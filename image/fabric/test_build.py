# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Check recipe coverage against the pinned Fabric source, including non-Python adapters."""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

from build import HARNESSES, REVISION, ROOT
from fabric import configuration


class RecipeCoverage(unittest.TestCase):
    def test_adapter_contract_preserves_and_validates_sampling_controls(self):
        source = ROOT / '.build/fabric' / f'NeMo-Fabric-{REVISION}'
        result = subprocess.run([sys.executable, '-B', '-c', '''
from nemo_fabric_adapter_contract.models import AgentModelConfig
model = AgentModelConfig.from_mapping({"provider": "openai", "model": "primary",
    "top_p": 0.8, "max_tokens": 37})
assert model.top_p == 0.8 and model.max_tokens == 37
assert AgentModelConfig.from_mapping(model.to_mapping()) == model
for invalid in ({"max_tokens": 0}, {"top_p": 1.1}):
    try:
        AgentModelConfig.from_mapping({"provider": "openai", "model": "primary", **invalid})
    except ValueError:
        pass
    else:
        raise AssertionError("invalid sampling controls accepted")
'''], env=dict(os.environ, PYTHONPATH=str(source / 'adapter-contract/python/src')),
            capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_every_upstream_adapter_has_a_recipe(self):
        source = next((ROOT / '.build').glob(f'fabric*/NeMo-Fabric-{REVISION}'), ROOT / '.build/missing')
        self.assertTrue(source.is_dir(), 'build the default image to populate the verified source first')
        upstream = {json.loads(p.read_text())['adapter_id']
                    for p in source.glob('adapters/*/*/*.fabric-adapter.json')}
        recipes = {configuration('coverage', h, {'model': 'gpt-4o-mini'} if h == 'pi' else None)['harness']['adapter_id'] for h in HARNESSES}
        self.assertEqual((recipes - {'nemoclaw.local.openclaw', 'nemoclaw.local.hermes'}) | {'nvidia.fabric.hermes'}, upstream)
        for h in HARNESSES:
            lock = 'dependencies.lock' if h == 'deepagents' else f'{h}-dependencies.lock'
            self.assertTrue((ROOT / 'image/fabric' / lock).is_file(), h)

    def test_protocol_specific_configuration(self):
        remote = configuration('coverage', 'remote-agent')
        self.assertNotIn('base_url', remote['models']['default'])
        self.assertEqual(remote['harness']['settings']['api_type'], 'openai-completions')
        self.assertEqual(configuration('coverage', 'nooa')['workflow']['target_id'], 'nvidia.nooa.coding-agent')
        for h in ('codex', 'nooa', 'nooa-bench', 'remote-agent', 'pi'):
            self.assertNotIn('max_turns', configuration('coverage', h, {'model': 'gpt-4o-mini'} if h == 'pi' else None)['runtime'])


if __name__ == '__main__':
    unittest.main()
