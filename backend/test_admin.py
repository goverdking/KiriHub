import http.client
import json
from pathlib import Path
import shutil
import struct
import tempfile
import subprocess
import threading
import time
import unittest
from unittest import mock
import zipfile
import zlib

from engines import MAGIC, digest, xp3_index
from server import App, Handler, Problem, ThreadingHTTPServer


def fixture(path, encrypted=False):
    content = b'Debug.message("fixture");'
    def chunk(tag, data):
        return tag + struct.pack('<Q', len(data)) + data
    name = 'startup.tjs'.encode('utf-16-le')
    info = struct.pack('<IQQH', 0x80000000 if encrypted else 0, len(content), len(content), len(name) // 2) + name
    segment = struct.pack('<IQQQ', 0, 19, len(content), len(content))
    index = chunk(b'File', chunk(b'info', info) + chunk(b'segm', segment) + chunk(b'adlr', struct.pack('<I', zlib.adler32(content))))
    path.write_bytes(MAGIC + struct.pack('<Q', 19 + len(content)) + content + b'\0' + struct.pack('<Q', len(index)) + index)


class Integration(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='gamehub-admin-test-')
        self.base = Path(self.temp.name)
        self.games = self.base / 'gal'
        self.games.mkdir()
        self.site = self.base / 'site'
        (self.site / 'data').mkdir(parents=True)
        (self.site / 'data/games.json').write_text('{"schema":1,"games":[]}')
        (self.site / 'engines/test').mkdir(parents=True)
        (self.site / 'engines/test/index.html').write_text('<html>test engine</html>')
        self.game = self.games / 'fixture'
        self.game.mkdir()
        fixture(self.game / 'data.xp3')
        self.config = dict(roots=[str(self.games)], profiles=[], runtime='/engines/test/index.html', genericCompatibility={})
        self.app = App(self.site, self.base / 'state', self.config)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.app = self.app
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = 'http://127.0.0.1:' + str(self.server.server_port)
        self.cookie = ''

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.app.pool.shutdown(wait=True)
        self.temp.cleanup()

    def request(self, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        h = {'Origin': self.origin, 'Cookie': self.cookie, **(headers or {})}
        if body is not None:
            h['Content-Type'] = 'application/json'
        conn.request('POST' if body is not None else 'GET', path, json.dumps(body) if body is not None else None, h)
        response = conn.getresponse()
        data = response.read()
        headers = dict(response.getheaders())
        status = response.status
        conn.close()
        return status, data, headers

    def login(self):
        secret = (self.app.state / 'admin-password.txt').read_text().strip()
        status, body, headers = self.request('/api/login', {'password': secret})
        self.assertEqual(status, 200)
        self.cookie = headers['Set-Cookie'].split(';')[0]

    def scan(self, path=None):
        status, body, _ = self.request('/api/imports', {'engine': 'krkrsdl2', 'path': str(path or self.game)})
        self.assertEqual(status, 202, body)
        job = json.loads(body)
        for _ in range(150):
            job = self.app.get(job['id'])
            if job['status'] not in ('queued', 'scanning'):
                return job
            time.sleep(.02)
        self.fail('scan timed out')

    def test_auth_origin_and_scope(self):
        self.assertEqual(self.request('/api/browse')[0], 401)
        self.login()
        self.assertEqual(self.request('/api/browse?path=/etc')[0], 403)
        self.assertEqual(self.request('/api/imports', {'engine': 'renpy', 'path': str(self.game)})[0], 400)
        self.assertEqual(self.request('/api/logout', {}, {'Origin': 'http://attacker.invalid'})[0], 403)
        self.assertEqual(self.request('/api/imports', {'engine': 'krkrsdl2', 'path': str(self.game / '../../outside')})[0], 403)

    def test_publish_gate_range_and_idempotence(self):
        self.login()
        job = self.scan()
        self.assertEqual(job['status'], 'ready', job)
        endpoint = '/api/imports/' + job['id']
        self.assertEqual(self.request(endpoint + '/publish', {})[0], 409)
        file_url = '/game-files/' + job['id'] + '/data.xp3'
        status, body, headers = self.request(file_url, headers={'Range': 'bytes=0-10'})
        self.assertEqual((status, body), (206, MAGIC))
        self.assertEqual(headers['Content-Range'], 'bytes 0-10/' + str((self.game / 'data.xp3').stat().st_size))
        self.assertEqual(self.request(file_url, headers={'Range': 'bytes=99999-'})[0], 416)
        self.assertEqual(self.request('/game-files/' + job['id'] + '/../state/auth.json')[0], 404)
        status, body, _ = self.request(endpoint + '/probe', {})
        token = json.loads(body)['token']
        self.assertEqual(self.request(endpoint + '/result', {'token': token, 'ready': True})[0], 409)
        self.app.probes[job['id']] = (token, time.monotonic() - 20)
        self.assertEqual(self.request(endpoint + '/result', {'token': token, 'ready': True})[0], 409)
        self.assertEqual(self.request(endpoint + '/result', {'token': token, 'ready': True, 'visualReady': True})[0], 200)
        self.assertEqual(self.request(endpoint + '/publish', {})[0], 409)
        self.assertEqual(self.request(endpoint + '/publish', {'confirmed': True})[0], 200)
        self.assertEqual(self.request(endpoint + '/publish', {'confirmed': True})[0], 200)
        catalog = json.loads((self.site / 'data/games.json').read_text())
        self.assertEqual(len(catalog['games']), 1)
        profile = json.loads((self.site / 'data/web-games' / (catalog['games'][0]['webRuntime']['profile'] + '.json')).read_text())
        self.assertFalse(profile['migrateLegacySaves'])
        self.assertNotEqual(profile['saveId'], 'probe-' + job['id'])
        self.cookie = ''
        self.assertEqual(self.request(file_url, headers={'Range': 'bytes=-3'})[0], 206)
        # Changed resources fail closed, including after publication.
        (self.game / 'data.xp3').write_bytes(b'changed')
        self.assertEqual(self.request(file_url)[0], 409)

    def test_failures_and_archive_traversal(self):
        self.login()
        fixture(self.game / 'data.xp3', encrypted=True)
        # The protected flag alone is not encryption. Corrupt the payload instead.
        raw = bytearray((self.game / 'data.xp3').read_bytes())
        raw[19] ^= 128
        (self.game / 'data.xp3').write_bytes(raw)
        self.assertEqual(self.scan()['status'], 'blocked')
        archive = self.games / 'bad.zip'
        with zipfile.ZipFile(archive, 'w') as zip_file:
            zip_file.writestr('../escape.txt', 'no')
        job = self.scan(archive)
        self.assertEqual(job['status'], 'blocked', job)
        self.assertFalse((self.app.state / 'imports' / job['id'] / 'escape.txt').exists())

    def test_missing_known_resource_and_restart(self):
        self.login()
        self.app.config['profiles'] = [dict(id='known', identity={'/data.xp3': digest(self.game / 'data.xp3')}, resources={'/data.xp3': digest(self.game / 'data.xp3'), '/voice.xp3': 'missing'})]
        job = self.scan()
        self.assertEqual(job['status'], 'blocked')
        self.assertIn('voice.xp3', job['message'])
        job.update(status='probing')
        self.app.save(job)
        restored = App(self.site, self.app.state, self.config)
        self.assertEqual(restored.get(job['id'])['status'], 'ready')
        restored.pool.shutdown()

    def test_dedupe_password_change_and_probe_failure(self):
        self.login()
        job = self.scan()
        endpoint = '/api/imports/' + job['id']
        _, body, _ = self.request(endpoint + '/probe', {})
        token = json.loads(body)['token']
        self.assertEqual(self.request(endpoint + '/result', {'token': token, 'errors': ['script failed']})[0], 200)
        self.assertEqual(self.request(endpoint + '/publish', {'confirmed': True})[0], 409)
        job = self.app.get(job['id'])
        job.update(status='checked', check={'passed': True, 'visualReady': True})
        self.app.save(job)
        self.assertEqual(self.request(endpoint + '/publish', {'confirmed': True})[0], 200)
        duplicate = self.scan()
        self.assertEqual(duplicate['id'], job['id'])
        self.assertEqual(len(self.app.jobs()), 1)
        self.assertEqual(self.request('/api/password', {'password': 'new-test-password-123'})[0], 200)
        self.assertEqual(self.request('/api/browse')[0], 401)
        self.assertEqual(self.request('/api/login', {'password': 'new-test-password-123'})[0], 200)

    def test_content_detection_unicode_main_and_ambiguity(self):
        self.login()
        original = self.game / 'data.xp3'
        renamed = self.game / '启动游戏.xp3'
        fixture(original, encrypted=True)
        original.rename(renamed)
        before = renamed.read_bytes()
        job = self.scan()
        self.assertEqual(job['status'], 'ready', job)
        self.assertEqual(job['result']['files']['/data.xp3'], str(renamed))
        self.assertEqual(job['result']['mainArchive'], '启动游戏.xp3')
        self.assertEqual(renamed.read_bytes(), before)
        self.assertFalse(original.exists())
        fixture(self.game / 'another.xp3')
        ambiguous = self.scan()
        self.assertEqual(ambiguous['status'], 'blocked')
        self.assertIn('多个非标准名称', ambiguous['message'])

    def test_main_is_not_guessed_from_suffix(self):
        self.login()
        (self.game / 'data.xp3').unlink()
        (self.game / '开始游戏.xp3').write_bytes(b'not xp3')
        job = self.scan()
        self.assertEqual(job['status'], 'blocked')
        self.assertNotIn('没有找到 data.xp3', job['message'])

    def test_video_entry_extraction_checksum(self):
        from media import extract
        from engines import xp3_index
        path = self.game / 'data.xp3'
        entry = xp3_index(path, allow_protected=True)[0]
        target = self.base / 'extracted.bin'
        extract(dict(archive=str(path), entry=entry), target)
        self.assertEqual(target.read_bytes(), b'Debug.message("fixture");')
        entry['checksum'] ^= 1
        with self.assertRaises(ValueError):
            extract(dict(archive=str(path), entry=entry), target)

    def test_retry_reuses_completed_extraction(self):
        self.login()
        archive = self.games / 'renamed.zip'
        with zipfile.ZipFile(archive, 'w') as output:
            output.write(self.game / 'data.xp3', 'game/开始游戏.xp3')
        job = self.scan(archive)
        self.assertEqual(job['status'], 'ready', job)
        extracted = Path(job['result']['files']['/data.xp3'])
        before = extracted.stat().st_ino
        self.assertEqual(self.request('/api/imports/' + job['id'] + '/retry', {})[0], 202)
        for _ in range(150):
            retried = self.app.get(job['id'])
            if retried['status'] not in ('queued', 'scanning'):
                break
            time.sleep(.02)
        self.assertEqual(retried['status'], 'ready', retried)
        self.assertEqual(extracted.stat().st_ino, before)

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'ffmpeg not installed')
    def test_media_conversion_and_cache(self):
        from media import prepare
        movie = self.game / 'test.avi'
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=64x64:d=0.1',
                        '-c:v', 'mjpeg', '-threads', '1', str(movie)], check=True)
        signature = digest(movie)
        args = ([dict(path=str(movie), name='test.avi')], self.base / 'derived', 'test', lambda value: None)
        media, files = prepare(*args)
        self.assertEqual(media['test.avi']['width'], 64)
        self.assertTrue(Path(files['/webmedia/0.mp4']).is_file())
        real_run = subprocess.run
        def no_second_encode(command, *a, **kw):
            if command[0] == 'ffmpeg':
                raise AssertionError('Prepared video was encoded again')
            return real_run(command, *a, **kw)
        with mock.patch('media.subprocess.run', side_effect=no_second_encode):
            reused, _ = prepare(*args)
        self.assertEqual(reused['test.avi']['sourceSha256'], signature)
        self.assertEqual(digest(movie), signature)


if __name__ == '__main__':
    unittest.main()
