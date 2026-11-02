import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import desktop_native


class NativeReuseTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        self.root=Path(temporary.name);(self.root/'.avx1').mkdir();cache=self.root/'.avx1-native-cache';cache.mkdir()
        digest=hashlib.sha256(b'{}\n').hexdigest()
        for name in ['package.json','package-lock.json']:(self.root/name).write_bytes(b'{}\n')
        files={}
        for name in ['pty.node','conpty.node','conpty_console_list.node','winpty.dll','winpty-agent.exe']:
            data=name.encode();(cache/name).write_bytes(data);files[name]=hashlib.sha256(data).hexdigest()
        self.reference={'package_json_sha256':digest,'package_lock_sha256':digest,'files':files}
        (self.root/'.avx1/desktop-native-reference.json').write_text(json.dumps(self.reference))
        for setting in [patch.object(desktop_native,'ROOT',self.root),patch.object(desktop_native,'WORK',self.root/'work'),patch.dict(desktop_native.os.environ,{},clear=True)]:
            setting.start();self.addCleanup(setting.stop)

    def test_exact_qualified_cache_is_copied_without_running_a_compiler(self):
        self.assertIn('not recompiled',desktop_native.restore()['status'])
        self.assertEqual((self.root/'node_modules/node-pty/build/Release/pty.node').read_bytes(),b'pty.node')

    def test_changed_lock_or_native_bytes_never_reuses_unknown_inputs(self):
        (self.root/'package-lock.json').write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError,'inputs changed'):desktop_native.restore()
        (self.root/'package-lock.json').write_bytes(b'{}\n')
        (self.root/'.avx1-native-cache/pty.node').write_bytes(b'tampered')
        with self.assertRaisesRegex(RuntimeError,'cache missing'):desktop_native.restore()

    def test_unknown_native_file_inventory_is_rejected(self):
        self.reference['files']['../escape.node']='a'*64
        (self.root/'.avx1/desktop-native-reference.json').write_text(json.dumps(self.reference))
        with self.assertRaisesRegex(RuntimeError,'inventory'):desktop_native.restore()


if __name__=='__main__':unittest.main()
