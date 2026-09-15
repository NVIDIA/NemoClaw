# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import hermes_adapter as adapter
from fabric import configuration


class HermesServerConfiguration(unittest.TestCase):
    def test_fabric_selects_owned_native_server(self):
        config = configuration('main', 'hermes')
        self.assertEqual(config['harness']['adapter_id'], 'nemoclaw.local.hermes')
        self.assertEqual(config['harness']['settings']['agent_name'], 'main')

    def test_retained_configuration_and_credential_reject_drift(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(adapter, 'ROOT', Path(directory)):
            adapter.initialize(None)
            original = adapter.token(Path(directory))
            adapter.initialize(None)
            self.assertEqual(original, adapter.token(Path(directory)))
            p = Path(directory) / 'config.yaml'
            config = json.loads(p.read_text())
            config['model']['base_url'] = 'https://unexpected.invalid'
            p.write_text(json.dumps(config))
            before = p.read_bytes()
            with self.assertRaises(RuntimeError):
                adapter.initialize(None)
            self.assertEqual(before, p.read_bytes())

class HermesInvocation(unittest.IsolatedAsyncioTestCase):
    async def test_uncertain_response_stops_runtime_and_is_never_replayed(self):
        from types import SimpleNamespace
        from unittest.mock import AsyncMock
        runtime = adapter.HermesRuntime()
        runtime.runtime_id = 'fixture'
        runtime.inference = None
        runtime.process = SimpleNamespace(returncode=None)
        runtime.stop = AsyncMock()
        with patch.object(adapter, 'configuration_matches', return_value=True), patch.object(adapter, 'api_request', side_effect=TimeoutError) as request:
            result = await runtime.invoke(SimpleNamespace(input='hello'), SimpleNamespace(runtime_id='fixture'))
            self.assertEqual(str(result.status), 'failed')
            runtime.stop.assert_awaited_once()
            with self.assertRaises(RuntimeError):
                await runtime.invoke(SimpleNamespace(input='hello'), SimpleNamespace(runtime_id='fixture'))
            self.assertEqual(request.call_count, 1)


if __name__ == '__main__':
    unittest.main()
