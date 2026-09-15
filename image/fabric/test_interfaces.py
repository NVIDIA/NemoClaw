# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import unittest
from openclaw_adapter import native_configuration

class DashboardTests(unittest.TestCase):
    def test_dashboard_uses_selected_port_and_requires_token_auth(self):
        config=native_configuration('main', {'api':'openai-completions','tuning':{},'interfaces':{'dashboard':{'port':18800,'bind':'0.0.0.0'}}})
        gateway=config['gateway']
        self.assertEqual(gateway['port'],18800)
        self.assertEqual(gateway['bind'],'lan')
        self.assertEqual(gateway['auth']['mode'],'token')
        self.assertTrue(gateway['controlUi']['enabled'])

    def test_retained_token_is_private_stable_and_not_in_native_configuration(self):
        import tempfile
        from pathlib import Path
        from interfaces import token
        with tempfile.TemporaryDirectory() as directory:
            first=token(directory,create=True)
            self.assertEqual(token(directory,create=True),first)
            self.assertEqual((Path(directory)/'interface-token').stat().st_mode & 0o777,0o600)
            self.assertNotIn(first,str(native_configuration('main', {'api':'openai-completions','tuning':{},'interfaces':{'dashboard':{'port':18800}}})))
            (Path(directory)/'interface-token').chmod(0o644)
            with self.assertRaises(RuntimeError): token(directory)

    def test_pairing_helper_rejects_native_options_as_request_ids(self):
        import subprocess
        import sys
        from pathlib import Path
        result=subprocess.run([sys.executable,str(Path(__file__).with_name('interfaces.py')),'devices','approve','--latest'],capture_output=True,text=True)
        self.assertIn('usage:',result.stderr)
        self.assertNotEqual(result.returncode,0)
