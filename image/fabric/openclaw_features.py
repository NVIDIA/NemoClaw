# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Native integration settings owned by NemoClaw's declared configuration."""

import math
import re


def tracing_features(inference):
    observability = (inference or {}).get("observability")
    if observability is None:
        return {}
    otlp = observability.get("otlp") if isinstance(observability, dict) else None
    if (
        set(observability) != {"otlp"}
        or not isinstance(otlp, dict)
        or set(otlp) != {"enabled", "endpoint", "serviceName", "sampleRate"}
        or otlp["enabled"] is not True
        or otlp["endpoint"] != "http://host.openshell.internal:4318"
        or not isinstance(otlp["serviceName"], str)
        or len(otlp["serviceName"]) > 256
        or not re.fullmatch(r"[!-~](?:[ -~]*[!-~])?", otlp["serviceName"])
        or type(otlp["sampleRate"]) not in (int, float)
        or not math.isfinite(otlp["sampleRate"])
        or not 0 <= otlp["sampleRate"] <= 1
    ):
        raise ValueError("invalid OpenClaw OTLP configuration")
    return {
        "diagnostics": {
            "enabled": True,
            "otel": {
                **otlp,
                "protocol": "http/protobuf",
                "traces": True,
                "metrics": False,
                "logs": False,
            },
        },
        "plugins": {
            "allow": ["diagnostics-otel"],
            "entries": {"diagnostics-otel": {"enabled": True}},
        },
    }


def search_agents(inference):
    search = (inference or {}).get("webSearch")
    if search is None:
        return []
    agents = {a["name"]: a for a in inference.get("agents", [])}
    if (
        not isinstance(search, dict)
        or set(search) != {"provider", "agentRefs", "credential"}
        or search["provider"] != "brave"
        or not isinstance(search["agentRefs"], list)
        or not search["agentRefs"]
        or any(not isinstance(n, str) for n in search["agentRefs"])
        or len(set(search["agentRefs"])) != len(search["agentRefs"])
        or any(
            n not in agents or agents[n].get("tools") == {"allow": ["read"]}
            for n in search["agentRefs"]
        )
        or not isinstance(search["credential"], dict)
        or set(search["credential"]) != {"env"}
        or not isinstance(search["credential"]["env"], str)
        or not re.fullmatch(r"[A-Z_][A-Z0-9_]*", search["credential"]["env"])
    ):
        raise ValueError("invalid Brave search configuration")
    return search["agentRefs"]


def native_features(inference):
    result = tracing_features(inference)
    if search_agents(inference):
        plugins = result.setdefault("plugins", {"allow": [], "entries": {}})
        plugins["allow"].append("brave")
        plugins["load"] = {"paths": ["/opt/nemoclaw/plugins/brave"]}
        plugins["entries"]["brave"] = {
            "enabled": True,
            "config": {
                "webSearch": {
                    "apiKey": {"source": "env", "provider": "default", "id": "BRAVE_API_KEY"}
                }
            },
        }
    return result


def features_match(actual, inference):
    expected = native_features(inference)
    if not expected:
        return True
    plugins = actual.get("plugins", {})
    return (
        ("diagnostics" not in expected or actual.get("diagnostics") == expected["diagnostics"])
        and plugins.get("enabled", True) is True
        and all(
            path in plugins.get("load", {}).get("paths", [])
            for path in expected["plugins"].get("load", {}).get("paths", [])
        )
        and all(
            name in plugins.get("allow", [])
            and name not in plugins.get("deny", [])
            and plugins.get("entries", {}).get(name) == entry
            for name, entry in expected["plugins"]["entries"].items()
        )
    )
