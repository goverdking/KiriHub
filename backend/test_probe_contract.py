"""Portable checks for the publish gate, independent of NAS path syntax."""
import json
from pathlib import Path
import tempfile
import time
import unittest

from server import App, Problem


class ProbeContract(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.site = self.root / 'site'
        (self.site / 'data').mkdir(parents=True)
        (self.site / 'data/games.json').write_text('{"games": []}')
        self.app = App(self.site, self.root / 'state', {'roots': [], 'profiles': []})
        resource = self.root / 'data.xp3'
        resource.write_bytes(b'fixture')
        self.job = dict(id='a' * 24, status='ready', name='Probe fixture', engine='krkrsdl2', source=str(self.root), createdAt=time.time(),
                        result=dict(files={'/data.xp3': str(resource)}, compatibility={}, media={}, verifiedAdapter=True, adapter='fixture', fingerprint='1' * 64, runtime='/engines/fixture/index.html'),
                        fileStats={'/data.xp3': [resource.stat().st_size, resource.stat().st_mtime_ns]})
        self.app.save(self.job)
        self.token = self.app.probe_start(self.job['id'])['token']
        self.app.probes[self.job['id']] = (self.token, time.monotonic() - 30)

    def tearDown(self):
        self.app.pool.shutdown()
        self.temp.cleanup()

    def test_script_ready_black_screen_cannot_pass(self):
        for body in [{'ready': True}, {'ready': True, 'visualReady': False}]:
            with self.assertRaises(Problem):
                self.app.probe_result(self.job['id'], {**body, 'token': self.token})
        self.assertNotEqual(self.app.get(self.job['id'])['status'], 'checked')

    def test_verified_adapter_still_requires_manual_confirmation(self):
        self.app.probe_result(self.job['id'], dict(token=self.token, ready=True, visualReady=True))
        with self.assertRaises(Problem):
            self.app.publish(self.job['id'], {})
        result = self.app.publish(self.job['id'], {'confirmed': True})
        self.assertEqual(result['status'], 'published')
        self.assertEqual(result['check']['scope'], 'startup-visual-manual')

    def test_legacy_startup_only_pass_cannot_publish(self):
        self.job.update(status='checked', check={'passed': True, 'scope': 'startup-only'})
        self.app.save(self.job)
        with self.assertRaises(Problem):
            self.app.publish(self.job['id'], {'confirmed': True})

    def test_error_blocks_even_with_visual_ready(self):
        result = self.app.probe_result(self.job['id'], dict(token=self.token, ready=True, visualReady=True, errors=['missing renderer']))
        self.assertEqual(result['status'], 'probe-failed')
        with self.assertRaises(Problem):
            self.app.publish(self.job['id'], {'confirmed': True})


if __name__ == '__main__':
    unittest.main()
