# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import unittest
from fabric import configuration


class PiModelConfiguration(unittest.TestCase):
    def test_yaml_model_reaches_pi_without_a_catalog_substitution(self):
        for model in ('gpt-4o-mini', 'qwen3:4b', 'my-model'):
            config = configuration('main', 'pi', {'model': model})
            self.assertEqual(config['models']['default']['model'], model)

    def test_custom_model_metadata_reaches_the_adapter(self):
        options = {'api': 'openai-completions', 'contextTokens': 8192,
                   'maxOutputTokens': 2048, 'reasoning': False, 'input': ['text']}
        config = configuration('main', 'pi', {'model': 'qwen3:4b', 'piModel': options})
        self.assertEqual(config['models']['default']['settings']['model_metadata'], options)

    def test_pi_requires_an_explicit_model(self):
        with self.assertRaisesRegex(ValueError, 'Pi requires'):
            configuration('main', 'pi')

import json
from pathlib import Path
import tempfile
from pi_host import PiHost


class PiRuntimeConfiguration(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.starts = []
        self.stops = []
        self.fail_start = False

        async def start(config):
            if self.fail_start:
                raise RuntimeError('adapter rejected configuration')
            self.starts.append(config)
            runtime = type('Runtime', (), {'runtime_id': str(len(self.starts)), 'status': 'active'})()
            async def stop():
                self.stops.append(runtime.runtime_id)
            runtime.stop = stop
            return runtime

        self.host = PiHost('main', configuration, start, Path(self.directory.name) / 'model.json')

    async def test_unchanged_apply_keeps_runtime_and_change_stops_before_restart(self):
        first = {'model': 'gpt-4o-mini'}
        second = {'model': 'gpt-4.1-mini'}
        self.assertFalse(self.host.status()['ready'])
        await self.host.configure(first)
        await self.host.prepare(first)
        await self.host.configure(first)
        self.assertEqual(len(self.starts), 1)
        self.assertEqual(self.stops, [])
        await self.host.prepare(second)
        self.assertFalse(self.host.status()['ready'])
        self.assertEqual(self.stops, ['1'])
        self.assertEqual(len(self.starts), 1)
        await self.host.configure(second)
        self.assertEqual(self.host.status()['config']['models']['default']['model'], second['model'])
        self.assertEqual(json.loads(self.host.model_path.read_text()), second)
        self.assertEqual(len(self.starts), 2)

    async def test_failed_start_is_not_ready_and_explicit_apply_can_recover(self):
        self.fail_start = True
        with self.assertRaises(RuntimeError):
            await self.host.configure({'model': 'custom-model'})
        self.assertFalse(self.host.status()['ready'])
        self.fail_start = False
        await self.host.configure({'model': 'custom-model'})
        self.assertTrue(self.host.status()['ready'])

    async def test_invalid_metadata_does_not_stop_the_running_model(self):
        await self.host.configure({'model': 'gpt-4o-mini'})
        with self.assertRaisesRegex(ValueError, 'metadata'):
            await self.host.prepare({'model': 'custom-model', 'piModel': {}})
        self.assertTrue(self.host.status()['ready'])
        self.assertEqual(self.stops, [])

    async def test_failed_stop_cannot_start_an_overlapping_runtime(self):
        await self.host.configure({'model': 'gpt-4o-mini'})
        async def fail_stop():
            raise RuntimeError('stop not confirmed')
        self.host.runtime.stop = fail_stop
        for _ in range(2):
            with self.assertRaisesRegex(RuntimeError, 'stop not confirmed'):
                await self.host.configure({'model': 'gpt-4.1-mini'})
        self.assertFalse(self.host.status()['ready'])
        self.assertEqual(len(self.starts), 1)


if __name__ == '__main__':
    unittest.main()
