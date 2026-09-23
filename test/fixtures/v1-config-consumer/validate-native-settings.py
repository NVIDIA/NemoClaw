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
    sys.modules.update(
        {
            "nemo_fabric_adapter_contract": contract,
            "nemo_fabric_adapter_contract.models": models,
            "nemo_fabric_adapters": adapters,
            "nemo_fabric_adapters.common": common,
        }
    )


def validate_openclaw(settings_by_sandbox):
    context_windows = []
    for entry in settings_by_sandbox.values():
        if entry["runtime"] != "fabric-openclaw":
            continue
        native = importlib.import_module("openclaw_adapter").native_configuration(
            "primary", entry["settings"]
        )
        provider = next(iter(native["models"]["providers"].values()))
        model = provider["models"][0]
        context_windows.append(model["contextWindow"])
    return {
        "contextWindows": context_windows,
        "openclawNativeSettingsVerified": len(context_windows),
    }


def validate_hermes(settings_by_sandbox):
    fabric = importlib.import_module("fabric")
    fabric.model_credential = lambda _inference: "fixture-credential"
    adapter = importlib.import_module("hermes_adapter")
    verified = 0
    for entry in settings_by_sandbox.values():
        if entry["runtime"] != "fabric-hermes":
            continue
        settings = entry["settings"] or {}
        interfaces = settings.get("interfaces", {})
        dashboard = interfaces.get("dashboard", {"enabled": True})
        expected = {
            "apiPort": interfaces.get("api", {}).get("port", 8642),
            "dashboard": {
                "enabled": dashboard["enabled"],
                "port": dashboard.get("port", 18789),
                "internalPort": dashboard.get("internalPort", 19119),
                "tui": dashboard.get("tui", {"enabled": True}),
            },
        }
        actual = adapter.native_configuration(settings)["nemoclaw_interfaces"]
        if actual != expected:
            raise AssertionError(f"native Hermes interfaces changed: {actual!r}")
        verified += 1
    return {"hermesNativeSettingsVerified": verified}


def main():
    consumer = Path(sys.argv[1])
    settings_by_sandbox = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
    sys.path.insert(0, str(consumer / "image" / "fabric"))
    install_adapter_stubs()
    result = {
        "compiledSandboxes": len(settings_by_sandbox),
        **validate_openclaw(settings_by_sandbox),
        **validate_hermes(settings_by_sandbox),
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()
