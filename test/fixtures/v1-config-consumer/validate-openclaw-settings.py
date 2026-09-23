# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import importlib
import json
import sys
import types
from pathlib import Path


def main():
    consumer = Path(sys.argv[1])
    settings = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
    sys.path.insert(0, str(consumer / "image" / "fabric"))
    contract = types.ModuleType("nemo_fabric_adapter_contract")
    models = types.ModuleType("nemo_fabric_adapter_contract.models")
    for name in ("AgentRunError", "AgentRunResult", "AgentRunStatus"):
        setattr(models, name, type(name, (), {}))
    adapters = types.ModuleType("nemo_fabric_adapters")
    common = types.ModuleType("nemo_fabric_adapters.common")
    common.lifecycle = object()
    sys.modules.update(
        {
            "nemo_fabric_adapter_contract": contract,
            "nemo_fabric_adapter_contract.models": models,
            "nemo_fabric_adapters": adapters,
            "nemo_fabric_adapters.common": common,
        }
    )
    native = importlib.import_module("openclaw_adapter").native_configuration(
        "primary", settings
    )
    provider = next(iter(native["models"]["providers"].values()))
    model = provider["models"][0]
    defaults = native["agents"]["defaults"]
    actual = {
        "contextWindow": model["contextWindow"],
        "maxTokens": model["maxTokens"],
        "reasoning": model["reasoning"],
        "reasoningEffort": defaults.get("thinkingDefault", "default"),
        "timeoutSeconds": defaults["timeoutSeconds"],
        "heartbeatEvery": defaults.get("heartbeat", {}).get("every"),
        "dashboardEnabled": native["gateway"]["controlUi"]["enabled"],
        "dashboardPort": native["gateway"]["port"],
        "dashboardBind": native["gateway"]["bind"],
        "toolDisclosure": (
            "progressive"
            if isinstance(native["tools"]["toolSearch"], dict)
            else "direct"
        ),
        "explicitAgentOwnership": native["agents"].get("ownership") == "explicit",
    }
    expected = {
        "contextWindow": 131072,
        "maxTokens": 4096,
        "reasoning": False,
        "reasoningEffort": "default",
        "timeoutSeconds": 600,
        "heartbeatEvery": None,
        "dashboardEnabled": True,
        "dashboardPort": 18789,
        "dashboardBind": "loopback",
        "toolDisclosure": "progressive",
        "explicitAgentOwnership": True,
    }
    if actual != expected:
        raise AssertionError(f"native OpenClaw defaults changed: {actual!r}")
    print(json.dumps({"contextWindow": actual["contextWindow"]}))


if __name__ == "__main__":
    main()
