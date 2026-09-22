# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import argparse
import copy
import importlib
import json
import sys
import types
from pathlib import Path


def load_adapters(consumer: Path):
    fabric = consumer / "image" / "fabric"
    sys.path.insert(0, str(fabric))
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
    return importlib.import_module("openclaw_adapter"), importlib.import_module("hermes_adapter")


def openclaw_evidence(adapter, settings, expected):
    native = adapter.native_configuration(expected["agentName"], settings)
    provider = next(iter(native["models"]["providers"].values()))
    model = provider["models"][0]
    source = {
        "contextWindow": model["contextWindow"],
        "maxTokens": model["maxTokens"],
        "reasoning": model["reasoning"],
        "timeoutSeconds": native["agents"]["defaults"]["timeoutSeconds"],
        "heartbeatPresent": "heartbeat" in native["agents"]["defaults"],
        "dashboardEnabled": native["gateway"]["controlUi"]["enabled"],
        "dashboardPort": native["gateway"]["port"],
        "dashboardBind": native["gateway"]["bind"],
        "toolDisclosure": "progressive" if isinstance(native["tools"]["toolSearch"], dict) else "direct",
        "explicitAgentOwnership": native["agents"].get("ownership") == "explicit",
        "thinkingDefaultPresent": "thinkingDefault" in native["agents"]["defaults"],
    }
    if source != expected["source"]:
        raise AssertionError(f"OpenClaw native source behavior changed: {source!r}")

    omitted = copy.deepcopy(settings)
    omitted["tuning"] = {}
    for agent in omitted.get("agents", []):
        for model in agent.get("inference", {}).get("models", {}).values():
            model["tuning"] = {}
    omitted.pop("execution", None)
    omitted.pop("interfaces", None)
    for agent in omitted.get("agents", []):
        agent.pop("tools", None)
    native_defaults = adapter.native_configuration(expected["agentName"], omitted)
    default_provider = next(iter(native_defaults["models"]["providers"].values()))
    default_model = default_provider["models"][0]
    target_defaults = {
        "contextWindow": default_model["contextWindow"],
        "maxTokens": default_model["maxTokens"],
        "reasoning": default_model["reasoning"],
        "timeoutSeconds": native_defaults["agents"]["defaults"]["timeoutSeconds"],
        "heartbeatPresent": "heartbeat" in native_defaults["agents"]["defaults"],
        "dashboardEnabled": native_defaults["gateway"]["controlUi"]["enabled"],
        "dashboardPort": native_defaults["gateway"]["port"],
        "dashboardBind": native_defaults["gateway"]["bind"],
        "toolDisclosure": (
            "progressive" if isinstance(native_defaults["tools"]["toolSearch"], dict) else "direct"
        ),
        "thinkingDefaultPresent": "thinkingDefault" in native_defaults["agents"]["defaults"],
    }
    if target_defaults != expected["targetDefaults"]:
        raise AssertionError(f"OpenClaw target omission defaults changed: {target_defaults!r}")
    return {"source": source, "targetDefaults": target_defaults}


def hermes_evidence(adapter, settings, expected):
    source = adapter.interface_settings(settings)
    if source != expected["source"]:
        raise AssertionError(f"Hermes native source behavior changed: {source!r}")
    omitted = copy.deepcopy(settings)
    omitted.pop("interfaces", None)
    target_defaults = adapter.interface_settings(omitted)
    if target_defaults != expected["targetDefaults"]:
        raise AssertionError(f"Hermes target omission defaults changed: {target_defaults!r}")
    return {"source": source, "targetDefaults": target_defaults}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--consumer", type=Path, required=True)
    parser.add_argument("--settings", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    openclaw, hermes = load_adapters(args.consumer)
    documents = []
    for item in manifest["documents"]:
        settings = json.loads((args.settings / f"{item['name']}.json").read_text(encoding="utf-8"))
        native = (
            openclaw_evidence(openclaw, settings, item)
            if item["harness"] == "openclaw"
            else hermes_evidence(hermes, settings, item)
        )
        documents.append(
            {
                "name": item["name"],
                "harness": item["harness"],
                "sha256": item["sha256"],
                "native": native,
            }
        )
    args.output.write_text(json.dumps({"documents": documents}, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
