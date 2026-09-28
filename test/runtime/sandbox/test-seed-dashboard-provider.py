#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Validate the dashboard seeder routing normalization and error messages."""

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
InvalidDashboardSeedDocumentError = mod.InvalidDashboardSeedDocumentError

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


def test_empty_routing_returns_empty():
    policy = {"config": {}, "dashboard": {"routing_keys": ROUTING_KEYS, "env_keys": []}}
    result = _normalized_routing({}, ROUTING_KEYS, policy)
    assert result == {}


def test_missing_keys_reports_specific_keys():
    gw = _gateway("test")
    del gw["providers"]
    del gw["custom_providers"]
    try:
        _normalized_routing(gw, ROUTING_KEYS, _policy())
        assert False, "should have raised"
    except InvalidDashboardSeedDocumentError as exc:
        msg = str(exc)
        assert "providers" in msg
        assert "custom_providers" in msg


def test_non_dict_upstream_reports_specifically():
    gw = _gateway("test")
    gw["_nemoclaw_upstream"] = "not-a-dict"
    try:
        _normalized_routing(gw, ROUTING_KEYS, _policy())
        assert False, "should have raised"
    except InvalidDashboardSeedDocumentError as exc:
        assert "_nemoclaw_upstream is not a mapping" in str(exc)


def test_non_dict_model_reports_specifically():
    gw = _gateway("test")
    gw["model"] = "not-a-dict"
    try:
        _normalized_routing(gw, ROUTING_KEYS, _policy())
        assert False, "should have raised"
    except InvalidDashboardSeedDocumentError as exc:
        assert "model is not a mapping" in str(exc)


def test_missing_provider_key_reports_specifically():
    gw = _gateway("test")
    del gw["_nemoclaw_upstream"]["provider_key"]
    try:
        _normalized_routing(gw, ROUTING_KEYS, _policy())
        assert False, "should have raised"
    except InvalidDashboardSeedDocumentError as exc:
        assert "provider_key is missing or empty" in str(exc)


def test_empty_provider_key_reports_specifically():
    gw = _gateway("test")
    gw["_nemoclaw_upstream"]["provider_key"] = ""
    try:
        _normalized_routing(gw, ROUTING_KEYS, _policy())
        assert False, "should have raised"
    except InvalidDashboardSeedDocumentError as exc:
        assert "provider_key is missing or empty" in str(exc)


def test_missing_model_default_reports_specifically():
    gw = _gateway("test")
    del gw["model"]["default"]
    try:
        _normalized_routing(gw, ROUTING_KEYS, _policy())
        assert False, "should have raised"
    except InvalidDashboardSeedDocumentError as exc:
        assert "model.default is missing or empty" in str(exc)


def test_missing_model_base_url_reports_specifically():
    gw = _gateway("test")
    del gw["model"]["base_url"]
    try:
        _normalized_routing(gw, ROUTING_KEYS, _policy())
        assert False, "should have raised"
    except InvalidDashboardSeedDocumentError as exc:
        assert "model.base_url is missing or empty" in str(exc)


def test_non_dict_providers_reports_specifically():
    gw = _gateway("test")
    gw["providers"] = "not-a-dict"
    try:
        _normalized_routing(gw, ROUTING_KEYS, _policy())
        assert False, "should have raised"
    except InvalidDashboardSeedDocumentError as exc:
        assert "providers is not a mapping" in str(exc)


def test_providers_missing_key_reports_specifically():
    gw = _gateway("test")
    gw["providers"] = {"other-key": {"name": "other"}}
    try:
        _normalized_routing(gw, ROUTING_KEYS, _policy())
        assert False, "should have raised"
    except InvalidDashboardSeedDocumentError as exc:
        assert "no entry for key" in str(exc)
        assert "test" in str(exc)


def test_empty_custom_providers_reports_specifically():
    gw = _gateway("test")
    gw["custom_providers"] = []
    try:
        _normalized_routing(gw, ROUTING_KEYS, _policy())
        assert False, "should have raised"
    except InvalidDashboardSeedDocumentError as exc:
        assert "custom_providers is missing or empty" in str(exc)


def test_non_list_custom_providers_reports_specifically():
    gw = _gateway("test")
    gw["custom_providers"] = "not-a-list"
    try:
        _normalized_routing(gw, ROUTING_KEYS, _policy())
        assert False, "should have raised"
    except InvalidDashboardSeedDocumentError as exc:
        assert "custom_providers is missing or empty" in str(exc)
