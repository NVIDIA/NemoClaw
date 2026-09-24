# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import fabric


class DynamicDispatch(unittest.TestCase):
    def test_unseen_installed_descriptor_selects_exact_adapter_and_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'new-agent.fabric-adapter.json'
            path.write_text(json.dumps({
                'contract_version': 'fabric.adapter/v1alpha2',
                'adapter_id': 'vendor.experimental.agent',
                'adapter_kind': 'python',
                'runner': {'module': 'vendor.agent'},
                'settings_schema': {'type': 'object', 'properties': {'effort': {'type': 'string'}}},
            }))
            with patch.object(fabric, 'descriptor_paths', return_value=[path]):
                config = fabric.configuration('main', 'new-agent', inference={
                    'api': 'openai-completions', 'settings': {'effort': 'high'},
                })
            self.assertEqual(config['harness'], {
                'adapter_id': 'vendor.experimental.agent', 'settings': {'effort': 'high'},
            })
            self.assertEqual(config['discovery']['local_paths'], [str(path)])

    def test_unavailable_or_malformed_descriptor_has_explicit_constraint(self):
        with patch.object(fabric, 'descriptor_paths', return_value=[]):
            with self.assertRaisesRegex(ValueError, 'unavailable.*missing-agent'):
                fabric.configuration('main', 'missing-agent')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'new-agent.fabric-adapter.json'
            path.write_text('{"adapter_id": 42}')
            with patch.object(fabric, 'descriptor_paths', return_value=[path]):
                with self.assertRaisesRegex(ValueError, 'invalid adapter descriptor'):
                    fabric.configuration('main', 'new-agent')

    def test_runtime_does_not_substitute_bundled_support_for_missing_installed_adapter(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(fabric, '__file__', str(Path(directory) / 'fabric.py')):
                with patch.object(fabric, 'descriptor_paths', return_value=[]):
                    with self.assertRaisesRegex(ValueError, 'unavailable.*deepagents'):
                        fabric.configuration('main', 'deepagents')

    def test_distinct_installed_descriptors_are_not_silently_selected(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = []
            for index in range(2):
                path = Path(directory) / str(index) / 'new-agent.fabric-adapter.json'
                path.parent.mkdir()
                path.write_text(json.dumps({
                    'contract_version': 'fabric.adapter/v1alpha2',
                    'adapter_id': f'vendor.agent{index}',
                    'adapter_kind': 'python',
                }))
                paths.append(path)
            with patch.object(fabric, 'descriptor_paths', return_value=paths):
                with self.assertRaisesRegex(ValueError, 'ambiguous.*new-agent'):
                    fabric.configuration('main', 'new-agent')

    def test_native_bridges_preserve_additional_settings_and_reject_reserved_conflicts(self):
        for harness in ('openclaw', 'hermes', 'remote-agent'):
            with self.subTest(harness=harness):
                config = fabric.configuration('main', harness, inference={
                    'api': 'openai-completions', 'settings': {'custom_option': {'nested': None}},
                })
                self.assertEqual(config['harness']['settings']['custom_option'], {'nested': None})
                reserved = 'base_url' if harness == 'remote-agent' else 'agent_name'
                with self.assertRaisesRegex(ValueError, 'conflicts with bridge-owned'):
                    fabric.configuration('main', harness, inference={
                        'api': 'openai-completions', 'settings': {reserved: 'conflicting-value'},
                    })

    def test_installed_catalog_cannot_be_extended_by_source_checkout_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'new-agent.fabric-adapter.json'
            path.write_text('{}')
            with patch.object(fabric, 'descriptor_paths', return_value=[path]):
                with self.assertRaisesRegex(ValueError, 'unavailable.*deepagents'):
                    fabric.configuration('main', 'deepagents')
