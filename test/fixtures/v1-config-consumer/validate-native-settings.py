# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import importlib
import json
import sys
import types
from pathlib import Path


def install_adapter_stubs():
    contract = types.ModuleType("nemo_fabric_adapter_contract")
    models = types.ModuleType("nemo_fabric_adapter_contract.models")
    for name in ("AgentRunError", "AgentRunResult", "AgentRunStatus"):
        setattr(models, name, type(name, (), {}))
    adapters = types.ModuleType("nemo_fabric_adapters")
    common = types.ModuleType("nemo_fabric_adapters.common")
    common.lifecycle = object()
    fabric = types.ModuleType("fabric")
    fabric.hermes_relay_enabled = lambda _inference: False
    fabric.model_connection = lambda _inference: {
        "model": "fixture-model",
        "base_url": "https://inference.local/v1",
    }
    fabric.model_credential = lambda _inference: "fixture-credential"
    interfaces = types.ModuleType("interfaces")
    interfaces.token = lambda _root: "fixture-token"
    sys.modules.update(
        {
            "nemo_fabric_adapter_contract": contract,
            "nemo_fabric_adapter_contract.models": models,
            "nemo_fabric_adapters": adapters,
            "nemo_fabric_adapters.common": common,
            "fabric": fabric,
            "interfaces": interfaces,
        }
    )


def validate_openclaw(settings_by_sandbox):
    settings = next(
        entry["settings"]
        for entry in settings_by_sandbox.values()
        if entry["runtime"] == "fabric-openclaw"
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
    return {"contextWindow": actual["contextWindow"]}


def validate_hermes(settings_by_sandbox):
    adapter = importlib.import_module("hermes_adapter")
    actual = {
        name: adapter.native_configuration(entry["settings"])["nemoclaw_interfaces"]
        for name, entry in settings_by_sandbox.items()
        if entry["runtime"] == "fabric-hermes"
    }
    expected = {
        "hermes-defaults": {
            "apiPort": 8642,
            "dashboard": {
                "enabled": True,
                "port": 18789,
                "internalPort": 19119,
                "tui": {"enabled": True},
            },
        },
        "hermes-disabled": {
            "apiPort": 8642,
            "dashboard": {
                "enabled": False,
                "port": 18789,
                "internalPort": 19119,
                "tui": {"enabled": True},
            },
        },
        "hermes-explicit": {
            "apiPort": 8643,
            "dashboard": {
                "enabled": True,
                "port": 19000,
                "internalPort": 19120,
                "tui": {"enabled": False},
            },
        },
    }
    if actual != expected:
        raise AssertionError(f"native Hermes interfaces changed: {actual!r}")
    return {"hermesInterfacesVerified": True}


def main():
    consumer = Path(sys.argv[1])
    settings_by_sandbox = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
    sys.path.insert(0, str(consumer / "image" / "fabric"))
    install_adapter_stubs()
    result = {
        **validate_openclaw(settings_by_sandbox),
        **validate_hermes(settings_by_sandbox),
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()
