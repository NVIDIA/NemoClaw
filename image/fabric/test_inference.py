# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import unittest
from fabric import configuration

class InferenceConfiguration(unittest.TestCase):
    def test_openclaw_receives_api_and_tuning(self):
        options = {'api': 'openai-responses', 'tuning': {'contextWindow': 65536, 'maxTokens': 8192, 'reasoning': True, 'reasoningEffort': 'high'}}
        config = configuration('main', 'openclaw', inference=options)
        self.assertEqual(config['harness']['settings']['inference'], options)

    def test_hermes_api_modes_and_placeholder_auth(self):
        for api, mode in [('openai-completions', 'chat_completions'), ('openai-responses', 'codex_responses'), ('anthropic-messages', 'anthropic_messages')]:
            options = {'api': api, 'tuning': {}, 'auth': {'method': 'api-key', 'providerRef': 'nous'}}
            config = configuration('main', 'hermes', inference=options)
            self.assertEqual(config['harness']['settings']['api_mode'], mode)
            self.assertEqual(config['models']['default']['api_key_env'], 'OPENAI_API_KEY')
            self.assertEqual(config['models']['default']['base_url'], 'https://inference.local/v1')
            self.assertNotIn('NOUS_API_KEY', str(config))


class NativeInference(unittest.TestCase):
    def test_native_api_limits_and_reasoning_are_verified_without_overwriting_drift(self):
        import json
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        import openclaw_adapter as adapter
        options = {'api': 'anthropic-messages', 'tuning': {'contextWindow': 65536, 'maxTokens': 8192, 'reasoning': True, 'reasoningEffort': 'high'}}
        with tempfile.TemporaryDirectory() as directory, patch.object(adapter, 'ROOT', Path(directory)):
            runtime = adapter.OpenClawRuntime()
            runtime.name, runtime.home, runtime.inference = 'main', Path(directory), options
            runtime.initialize_configuration()
            path = Path(directory) / 'openclaw.json'
            config = json.loads(path.read_text())
            provider = config['models']['providers']['openshell']
            self.assertEqual(provider['api'], 'anthropic-messages')
            self.assertEqual(provider['models'][0]['maxTokens'], 8192)
            self.assertEqual(config['agents']['defaults']['thinkingDefault'], 'high')
            self.assertTrue(adapter.configuration_matches('main', options))
            provider['models'][0]['maxTokens'] = 4096
            path.write_text(json.dumps(config))
            before = path.read_bytes()
            self.assertFalse(adapter.configuration_matches('main', options))
            with self.assertRaises(RuntimeError):
                runtime.initialize_configuration()
            self.assertEqual(path.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
