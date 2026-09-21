#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Validate that the dashboard seeder writes model.provider = 'custom' for all upstream providers."""

import importlib.util
import sys
import types
from pathlib import Path

AGENTS_HERMES = Path(__file__).resolve().parents[3] / "agents" / "hermes"
sys.path.insert(0, str(AGENTS_HERMES))

stub = types.ModuleType("managed_policy")
stub.HERMES_PROXY_REWRITE_SENTINEL = "sk-OPENSHELL-PROXY-REWRITE"
stub.ManagedPolicyError = Exception
stub.load_managed_policy = lambda _path: {}
stub.policy_value = lambda _cfg, _path: None
sys.modules["managed_policy"] = stub

spec = importlib.util.spec_from_file_location(
    "seed_dashboard_config",
    AGENTS_HERMES / "seed-dashboard-config.py",
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
_normalized_routing = mod._normalized_routing

ROUTING_KEYS = ["model", "_nemoclaw_upstream", "providers", "custom_providers"]
SENTINEL = stub.HERMES_PROXY_REWRITE_SENTINEL


def _gateway(provider_name: str) -> dict:
    return {
        "model": {
            "default": "test-model",
            "provider": "custom",
            "base_url": "http://localhost:4000/v1",
            "api_key": SENTINEL,
        },
        "_nemoclaw_upstream": {
            "provider": provider_name,
            "provider_key": provider_name.lower().replace(" ", "-"),
            "model": "test-model",
        },
        "providers": {
            provider_name.lower().replace(" ", "-"): {
                "name": provider_name,
                "api": "http://localhost:4000/v1",
                "api_key": SENTINEL,
                "default_model": "test-model",
                "discover_models": True,
            },
        },
        "custom_providers": [
            {
                "name": provider_name,
                "base_url": "http://localhost:4000/v1",
                "api_key": SENTINEL,
                "discover_models": True,
            },
        ],
    }


def _policy() -> dict:
    return {
        "config": {},
        "dashboard": {"routing_keys": ROUTING_KEYS, "env_keys": []},
    }


def test_provider_custom_for_compatible_endpoint():
    routing = _normalized_routing(_gateway("compatible-endpoint"), ROUTING_KEYS, _policy())
    assert routing["model"]["provider"] == "custom"


def test_provider_custom_for_nvidia():
    routing = _normalized_routing(_gateway("nvidia-inference"), ROUTING_KEYS, _policy())
    assert routing["model"]["provider"] == "custom"


def test_provider_custom_for_gemini():
    routing = _normalized_routing(_gateway("gemini-api"), ROUTING_KEYS, _policy())
    assert routing["model"]["provider"] == "custom"


def test_provider_custom_for_vllm():
    routing = _normalized_routing(_gateway("vllm-local"), ROUTING_KEYS, _policy())
    assert routing["model"]["provider"] == "custom"


def test_provider_custom_for_openai():
    routing = _normalized_routing(_gateway("openai"), ROUTING_KEYS, _policy())
    assert routing["model"]["provider"] == "custom"


def test_provider_key_preserved_in_upstream():
    routing = _normalized_routing(_gateway("compatible-endpoint"), ROUTING_KEYS, _policy())
    assert routing["_nemoclaw_upstream"]["provider_key"] == "compatible-endpoint"
    assert routing["_nemoclaw_upstream"]["provider"] == "compatible-endpoint"
