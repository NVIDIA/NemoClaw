# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Add explicit API mode forwarding to the pinned Fabric Hermes adapter.

Upstream: NVIDIA/NeMo-Fabric 6c08337bcb11d6c0f2d5118f8f0c98a5b2a1a421,
Apache-2.0. 2026-09-15: extend settings schema and forward api_mode to AIAgent
from NousResearch/hermes-agent 29112bef099274229cadff79cdff7bf7b99c4b77.
2026-09-21: rebase the unchanged API-mode correction onto the pinned source.
Upstream notices remain in the patched source and built wheel.
"""

import json


def patch_hermes(source):
    root = source / "adapters/python/hermes"
    adapter = root / "src/nemo_fabric_adapters/hermes/adapter.py"
    original = adapter.read_text()
    anchor = "                        provider=model_config.provider,\n"
    if original.count(anchor) != 1 or 'api_mode=self._settings.get("api_mode")' in original:
        raise ValueError("pinned Hermes adapter API forwarding anchor changed")
    adapter.write_text(
        "# NemoClaw modification, 2026-09-15: forward explicit api_mode.\n"
        "# Upstream: NVIDIA/NeMo-Fabric 6c08337bcb11d6c0f2d5118f8f0c98a5b2a1a421 (Apache-2.0).\n"
        + original.replace(
            anchor, anchor + '                        api_mode=self._settings.get("api_mode"),\n'
        )
    )
    manifest = root / "hermes.fabric-adapter.json"
    value = json.loads(manifest.read_text())
    value["settings_schema"]["properties"]["api_mode"] = {
        "type": "string",
        "enum": ["chat_completions", "codex_responses", "anthropic_messages"],
        "description": "Explicit Hermes wire API through the OpenShell primary route.",
    }
    manifest.write_text(json.dumps(value, indent=2) + "\n")
    (root / "NEMOCLAW-MODIFICATIONS.md").write_text(__doc__ + "\n")
