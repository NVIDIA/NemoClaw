# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Run only in an explicitly selected disposable, network-disabled OpenClaw container."""
import json
import os
import unittest
from fabric import configuration
from openclaw_adapter import OpenClawRuntime, ROOT, healthy


@unittest.skipUnless(os.environ.get('NEMOCLAW_TEST_NATIVE_TOOLS') == '1',
                     'requires an explicitly selected disposable OpenClaw container')
class NativeRosterStartup(unittest.IsolatedAsyncioTestCase):
    async def test_gateway_restart_retains_roster_and_detects_broadened_tools(self):
        options = {'api': 'openai-completions', 'tuning': {}, 'agents': [
            {'name': 'primary'}, {'name': 'reader', 'tools': {'allow': ['read']}},
            {'name': 'reviewer', 'tools': {'allow': ['read']}}]}
        for runtime_id in ('tools-first', 'tools-restarted'):
            runtime = OpenClawRuntime()
            try:
                await runtime.start({'config': configuration('primary', 'openclaw', inference=options),
                                     'runtime_context': {'runtime_id': runtime_id}})
                self.assertTrue(healthy('primary', runtime_id, options))
                if runtime_id == 'tools-restarted':
                    path = ROOT / 'openclaw.json'
                    native = json.loads(path.read_text())
                    native['agents']['entries']['reader']['tools']['allow'].append('exec')
                    path.write_text(json.dumps(native))
                    self.assertFalse(healthy('primary', runtime_id, options))
                    with self.assertRaises(RuntimeError):
                        runtime.initialize_configuration()
            finally:
                await runtime.stop()


if __name__ == '__main__':
    unittest.main()
