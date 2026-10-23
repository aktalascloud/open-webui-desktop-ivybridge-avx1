"""Install verified fork packages, keeping data/settings outside runtime swaps."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request
import uuid
import zipfile

REPOS={'webui':'open-webui-ivybridge-avx1','terminal':'open-terminal-ivybridge-avx1'}

def digest(path):
    with Path(path).open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()

def download(url,path,expected):
    if not url.startswith('https://'):raise RuntimeError('Требуется HTTPS')
    request=urllib.request.Request(url,headers={'User-Agent':'Open-WebUI-AVX1-Installer','Cache-Control':'no-cache'})
    with urllib.request.urlopen(request,timeout=120) as response,Path(path).open('wb') as output:shutil.copyfileobj(response,output)
    if digest(path)!=expected:raise RuntimeError('Контрольная сумма скачанного пакета не совпала')

def validate_bundle(archive,project,source=None):
    with zipfile.ZipFile(archive) as bundle:
        for member in bundle.infolist():
            name=member.filename.replace('\\','/');parts=name.split('/')
            if name.startswith('/') or ':' in name or '..' in parts or ((member.external_attr>>16)&0o170000)==0o120000:
                raise RuntimeError('Небезопасный путь в пакете')
        if bundle.testzip():raise RuntimeError('Архив повреждён')
        manifest=json.loads(bundle.read('manifest.json'))
        if manifest['project']!=project or manifest['repository']!='aktalascloud/'+REPOS[project]:raise RuntimeError('Неверный источник пакета')
        if not re.fullmatch('[a-f0-9]{40}',manifest['source_commit']) or source and manifest['source_commit']!=source:
            raise RuntimeError('Исходный коммит пакета не совпал с релизом')
        if manifest['channel'] not in ('latest','development'):raise RuntimeError('Требуется актуальная сборка форка')
        if project=='webui' and not manifest.get('security',{}).get('browser_smoke'):raise RuntimeError('Отсутствует проверка интерфейса браузером')
        for item in manifest['files']:
            if hashlib.sha256(bundle.read(item['path'])).hexdigest()!=item['sha256']:raise RuntimeError('Файл пакета повреждён')
    return manifest

def fetch_candidate(project,cache,tag=None):
    cache=Path(cache);cache.mkdir(parents=True,exist_ok=True)
    endpoint='latest' if not tag else 'tags/'+urllib.parse.quote(tag,safe='')
    request=urllib.request.Request('https://api.github.com/repos/aktalascloud/'+REPOS[project]+'/releases/'+endpoint,
        headers={'User-Agent':'Open-WebUI-AVX1-Installer','Cache-Control':'no-cache'})
    with urllib.request.urlopen(request,timeout=30) as response:release=json.load(response)
    if release['draft'] or not re.fullmatch('[a-f0-9]{40}',release['target_commitish']):raise RuntimeError('Неопубликованный или незакреплённый релиз')
    assets=[x for x in release['assets'] if x['name'].endswith('.zip')]
    # Migration compatibility: the earlier public release exposed two variants.
    if len(assets)>1:assets=[x for x in assets if '-development-' in x['name']]
    if len(assets)!=1:raise RuntimeError('В релизе должен быть один актуальный пакет')
    asset=assets[0];expected=asset.get('digest','')
    if not re.fullmatch('sha256:[a-f0-9]{64}',expected) or not 0<asset['size']<2*1024**3:raise RuntimeError('Нет проверяемой суммы пакета')
    archive=cache/(expected.split(':')[1]+'.zip')
    if not archive.exists() or digest(archive)!=expected.split(':')[1]:download(asset['browser_download_url'],archive,expected.split(':')[1])
    return archive,validate_bundle(archive,project,release['target_commitish'])

def install(project,python,archive,manifest):
    python=Path(python).resolve();runtime=python.parent;root=runtime.parent
    if python.name.lower()!='python.exe' or runtime.name.lower()!='python' or not python.is_file():raise RuntimeError('Неизвестная папка Python; установка отменена')
    if (root/'maintenance/scripts/qualify.py').exists():raise RuntimeError('Для управляемой установки требуется проверенный контроллер проекта')
    receipt_path=root/'fork-builds.json';receipts=json.loads(receipt_path.read_text('utf-8')) if receipt_path.exists() else {}
    if receipts.get(project,{}).get('source_commit')==manifest['source_commit']:
        print('Уже установлена эта проверенная сборка',flush=True);return
    updates=root/'updates';updates.mkdir(exist_ok=True)
    if updates.is_symlink() or runtime.is_symlink():raise RuntimeError('Символические ссылки в папках установки не поддерживаются')
    stage=updates/('stage-'+uuid.uuid4().hex);stage.mkdir()
    previous=updates/('backup-'+time.strftime('%Y%m%d_%H%M%S')+'-'+uuid.uuid4().hex[:8]);previous.mkdir()
    try:
        package=stage/'package';package.mkdir()
        with zipfile.ZipFile(archive) as bundle:bundle.extractall(package)
        pin=manifest['python'];tar_path=stage/'python.tar.gz'
        print('Подготовка проверенной среды Python…',flush=True)
        download(pin['url'],tar_path,pin['sha256'])
        with tarfile.open(tar_path,'r:gz') as source:source.extractall(stage,filter='data')
        new_python=stage/'python/python.exe';site=stage/'python/Lib/site-packages';site.mkdir(parents=True,exist_ok=True)
        if not new_python.is_file():raise RuntimeError('Не найден Python в проверенном дистрибутиве')
        app='open_webui' if project=='webui' else 'open_terminal'
        def ignore(parent,names):
            return [name for name in names if name=='__pycache__' or (Path(parent)==runtime/'Lib/site-packages' and
                (name in {app,'pip','setuptools','pkg_resources','_distutils_hack','distutils-precedence.pth'} or
                 name.startswith((app+'-', 'pip-', 'setuptools-')) and name.endswith('.dist-info')))]
        old_site=runtime/'Lib/site-packages'
        if old_site.exists():shutil.copytree(old_site,site,dirs_exist_ok=True,ignore=ignore)
        if (runtime/'Scripts').exists():shutil.copytree(runtime/'Scripts',stage/'python/Scripts',dirs_exist_ok=True)
        bootstrap=list((package/'bootstrap').glob('pip-*.whl'))
        if len(bootstrap)!=1:raise RuntimeError('Нет однозначного установщика pip')
        with zipfile.ZipFile(bootstrap[0]) as wheel:wheel.extractall(site)
        constraints=stage/'constraints.txt'
        constraints.write_text(''.join(x['name']+'=='+x['version']+'\n' for x in manifest['resolved_dependencies']),encoding='utf-8')
        wheels=list((package/'wheels').glob('*.whl'))
        if manifest.get('native_json',{}).get('default')=='stock':wheels=[p for p in wheels if not p.name.startswith('orjson-')]
        print('Установка оптимизированного пакета и проверенных зависимостей…',flush=True)
        subprocess.run([str(new_python),'-m','pip','install','--no-cache-dir','--disable-pip-version-check','--no-input','--constraint',str(constraints),*map(str,wheels)],check=True)
        check="import importlib.metadata as m; import uv; assert m.version('open-webui'); import mcp; import orjson" if project=='webui' else "import importlib.metadata as m; import uv; assert m.version('open-terminal'); import open_terminal.cli"
        subprocess.run([str(new_python),'-I','-c',check],check=True)
        subprocess.run([str(new_python),'-I','-m','uv','--version'],check=True)
        moved=False
        try:
            runtime.rename(previous/'python');moved=True
            (stage/'python').rename(runtime)
        except Exception:
            if moved and not runtime.exists():(previous/'python').rename(runtime)
            raise
        receipts[project]={'source_commit':manifest['source_commit'],'upstream_commit':manifest['upstream_commit'],'backup':str(previous)}
        temporary=receipt_path.with_suffix('.tmp');temporary.write_text(json.dumps(receipts,indent=2),encoding='utf-8');temporary.replace(receipt_path)
        print('Установлена проверенная сборка форка. Данные и настройки сохранены.',flush=True)
    finally:
        # Only this freshly created staging directory is removed.
        if stage.resolve().is_relative_to(updates.resolve()) and not stage.is_symlink():shutil.rmtree(stage,ignore_errors=True)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--project',choices=REPOS,required=True);parser.add_argument('--python',required=True);parser.add_argument('--tag');args=parser.parse_args()
    root=Path(args.python).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix='owui-fork-download-') as cache:
        archive,manifest=fetch_candidate(args.project,cache,args.tag)
        install(args.project,args.python,archive,manifest)

if __name__=='__main__':main()
