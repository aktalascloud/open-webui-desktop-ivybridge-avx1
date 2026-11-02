"""Reuse the exact qualified PTY binaries for renderer-only changes."""
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from common import ROOT, WORK, sha256, write_json


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None


def restore():
    reference=json.loads((ROOT/'.avx1/desktop-native-reference.json').read_text('utf-8'))
    canonical=lambda path:hashlib.sha256(path.read_text('utf-8').encode()).hexdigest()
    if (canonical(ROOT/'package.json')!=reference['package_json_sha256'] or
            canonical(ROOT/'package-lock.json')!=reference['package_lock_sha256']):
        raise RuntimeError('Native ABI/dependency inputs changed; review a new native build')
    names={'pty.node','conpty.node','conpty_console_list.node','winpty.dll','winpty-agent.exe'}
    if set(reference['files'])!=names:raise RuntimeError('Unknown native reference inventory')
    cache=ROOT/'.avx1-native-cache'
    valid=lambda:all((cache/name).is_file() and not (cache/name).is_symlink()
        and sha256(cache/name)==digest for name,digest in reference['files'].items())
    if not valid():
        token=os.environ.get('GITHUB_TOKEN')
        if not token:raise RuntimeError('Qualified native cache missing; provide the reference artifact read token')
        endpoint=f"https://api.github.com/repos/{reference['repository']}/actions/artifacts/{reference['artifact_id']}"
        headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json','User-Agent':'qualified-native-reuse'}
        with urllib.request.urlopen(urllib.request.Request(endpoint,headers=headers),timeout=60) as response:artifact=json.load(response)
        if (artifact['digest']!='sha256:'+reference['artifact_sha256'] or artifact['size_in_bytes']!=reference['artifact_bytes']
                or artifact['workflow_run']['head_sha']!=reference['source_commit']):
            raise RuntimeError('Qualified native artifact provenance differs')
        try:
            urllib.request.build_opener(NoRedirect()).open(urllib.request.Request(endpoint+'/zip',headers=headers),timeout=60)
            raise RuntimeError('Native artifact download redirect missing')
        except urllib.error.HTTPError as error:
            if error.code!=302:raise
            location=error.headers['Location']
        parsed=urllib.parse.urlsplit(location)
        if (parsed.scheme!='https' or parsed.username or parsed.password or not any((parsed.hostname or '').endswith(s)
                for s in ('.blob.core.windows.net','.blob.storage.azure.net','.actions.githubusercontent.com','.githubusercontent.com'))):
            raise RuntimeError('Unexpected native artifact storage host')
        archive=WORK/'native-reference.zip'
        # Never forward the GitHub token to artifact storage.
        with urllib.request.build_opener(NoRedirect()).open(location,timeout=120) as response,archive.open('wb') as stream:shutil.copyfileobj(response,stream)
        if sha256(archive)!=reference['artifact_sha256']:raise RuntimeError('Native artifact digest differs')
        cache.mkdir(exist_ok=True)
        with zipfile.ZipFile(archive) as outer:
            nested=[name for name in outer.namelist() if name.endswith('.zip')]
            if len(nested)!=1:raise RuntimeError('Native candidate archive inventory differs')
            with zipfile.ZipFile(io.BytesIO(outer.read(nested[0]))) as candidate:
                manifest=json.loads(candidate.read('manifest.json'))
                if manifest['source_commit']!=reference['source_commit']:raise RuntimeError('Native candidate source differs')
                prefix='desktop/resources/app.asar.unpacked/node_modules/node-pty/build/Release/'
                for name,digest in reference['files'].items():
                    data=candidate.read(prefix+name)
                    if hashlib.sha256(data).hexdigest()!=digest:raise RuntimeError('Native binary checksum differs')
                    (cache/name).write_bytes(data)
        if not valid():raise RuntimeError('Qualified native cache incomplete')
    target=ROOT/'node_modules/node-pty/build/Release';target.mkdir(parents=True,exist_ok=True)
    for name in names:shutil.copyfile(cache/name,target/name)
    write_json(cache/'reference-complete.json',reference)
    return {'status':'reused qualified source-built binaries; not recompiled','reference':reference}
