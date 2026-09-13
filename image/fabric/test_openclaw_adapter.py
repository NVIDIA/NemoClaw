# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import unittest
from types import SimpleNamespace

from nemo_fabric_adapter_contract.models import AgentRunStatus
from nemo_fabric_adapters.common import lifecycle
from openclaw_adapter import OpenClawRuntime, normalize_messages


class FakeRuntime(OpenClawRuntime):
    def __init__(self, result):
        super().__init__()
        self.result = result
        self.runtime_id = 'runtime-test'
        self.name = 'main'
        self.session_key = 'agent:main:fabric-runtime-test'
        self.process = SimpleNamespace(returncode=None, pid=123)
        self.calls = []
        self.stopped = False

    async def rpc(self, method, params, timeout=280):
        self.calls.append((method, params))
        if isinstance(self.result, Exception):
            raise self.result
        return self.result if method == 'agent' else {'messages': []}

    async def stop(self):
        self.stopped = True


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_uncertain_failure_is_not_replayed(self):
        runtime = FakeRuntime(TimeoutError('lost response'))
        request = SimpleNamespace(input="quotes ' and $(not-a-shell-command)\nnext")
        context = SimpleNamespace(runtime_id='runtime-test', invocation_id='turn-one')
        result = await runtime.invoke(request, context)
        self.assertEqual(result.status, AgentRunStatus.FAILED)
        self.assertTrue(runtime.stopped)
        self.assertEqual(len(runtime.calls), 1)
        self.assertEqual(runtime.calls[0][1]['message'], request.input)
        self.assertEqual(runtime.calls[0][1]['idempotencyKey'], 'turn-one')
        with self.assertRaises(lifecycle.LifecycleError):
            await runtime.invoke(request, context)
        self.assertEqual(len(runtime.calls), 1)

    async def test_nonterminal_and_aborted_results_fail(self):
        for native in [{'status': 'accepted'}, {'status': 'ok', 'result': {'meta': {'aborted': True}}},
                       {'status': 'ok', 'result': {'payloads': [{'text': 'failed', 'isError': True}]}}]:
            runtime = FakeRuntime(native)
            result = await runtime.invoke(SimpleNamespace(input='hello'),
                SimpleNamespace(runtime_id='runtime-test', invocation_id='turn-one'))
            self.assertEqual(result.status, AgentRunStatus.FAILED)
            self.assertTrue(runtime.stopped)
            self.assertEqual(len(runtime.calls), 1)

    def test_tool_history_retains_call_identity_and_error(self):
        result = normalize_messages([
            {'role': 'assistant', 'content': [{'type': 'toolCall', 'id': 'call-one', 'name': 'exec', 'arguments': {'command': 'pwd'}}]},
            {'role': 'toolResult', 'toolCallId': 'call-one', 'isError': True, 'content': [{'type': 'text', 'text': 'denied'}]},
        ])
        self.assertEqual(result[0]['tool_calls'][0]['id'], result[1]['tool_call_id'])
        self.assertEqual(result[1]['role'], 'tool')
        self.assertTrue(result[1]['is_error'])
        self.assertEqual(result[1]['content'], 'denied')


class NativeConfigurationTests(unittest.TestCase):
    def test_native_settings_survive_initialization_and_reserved_drift_is_rejected(self):
        import json
        from pathlib import Path
        import tempfile
        from unittest.mock import patch
        import openclaw_adapter as adapter
        with tempfile.TemporaryDirectory() as directory, patch.object(adapter, 'ROOT', Path(directory)):
            runtime = OpenClawRuntime()
            runtime.home = Path(directory)
            runtime.name = 'main'
            runtime.initialize_configuration()
            path = Path(directory) / 'openclaw.json'
            native = json.loads(path.read_text())
            native['channels'] = {'telegram': {'enabled': True, 'tokenFile': '/run/secrets/token'}}
            native['session'] = {'dmScope': 'per-channel-peer'}
            native['tools']['profile'] = 'minimal'
            path.write_text(json.dumps(native))
            original = path.read_bytes()
            runtime.initialize_configuration()
            self.assertEqual(path.read_bytes(), original)
            self.assertTrue(adapter.configuration_matches('main'))
            native['models']['providers']['openshell']['baseUrl'] = 'https://unexpected.example/v1'
            path.write_text(json.dumps(native))
            drifted = path.read_bytes()
            with self.assertRaises(RuntimeError):
                runtime.initialize_configuration()
            self.assertEqual(path.read_bytes(), drifted)


if __name__ == '__main__':
    unittest.main()
