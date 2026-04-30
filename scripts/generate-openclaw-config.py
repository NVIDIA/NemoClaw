#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Generate openclaw.json from environment variables.

Called at Docker image build time (RUN layer) after ARG→ENV promotion.
Reads all configuration from os.environ — never from string interpolation
in Dockerfile source. See: C-2 security model.

Usage:
    python3 scripts/generate-openclaw-config.py            # Generate config

Environment variables:
    CHAT_UI_URL                         Dashboard URL (default: http://127.0.0.1:18789)
    NEMOCLAW_MODEL                      Model identifier
    NEMOCLAW_PROVIDER_KEY               Provider key for model config
    NEMOCLAW_PRIMARY_MODEL_REF          Primary model reference
    NEMOCLAW_INFERENCE_BASE_URL         Inference endpoint
    NEMOCLAW_INFERENCE_API              Inference API type
    NEMOCLAW_INFERENCE_INPUTS           Comma-separated model inputs (default: text)
    NEMOCLAW_CONTEXT_WINDOW             Context window size (default: 131072)
    NEMOCLAW_MAX_TOKENS                 Max tokens (default: 4096)
    NEMOCLAW_REASONING                  Enable reasoning (default: false)
    NEMOCLAW_AGENT_TIMEOUT              Per-request timeout seconds (default: 600)
    NEMOCLAW_INFERENCE_COMPAT_B64       Base64-encoded inference compat JSON
    NEMOCLAW_MESSAGING_CHANNELS_B64     Base64-encoded channel list
    NEMOCLAW_MESSAGING_ALLOWED_IDS_B64  Base64-encoded allowed IDs map
    NEMOCLAW_DISCORD_GUILDS_B64         Base64-encoded Discord guild config
    NEMOCLAW_DISABLE_DEVICE_AUTH        Set to "1" to force-disable device auth
    NEMOCLAW_PROXY_HOST                 Egress proxy host (default: 10.200.0.1)
    NEMOCLAW_PROXY_PORT                 Egress proxy port (default: 3128)
    NEMOCLAW_WEB_SEARCH_ENABLED         Set to "1" to enable web search tools
"""

from __future__ import annotations

import base64
import json
import os
import re
from urllib.parse import urlparse


def is_loopback(hostname: str) -> bool:
    """Check if a hostname is a loopback address.

    Mirrors isLoopbackHostname() from src/lib/url-utils.ts.
    Returns True for localhost, ::1, and 127.x.x.x addresses.
    """
    normalized = (hostname or "").strip().lower().strip("[]")
    if normalized == "localhost" or normalized == "::1":
        return True
    return bool(re.match(r"^127(?:\.\d{1,3}){3}$", normalized))


def build_config(env: dict | None = None) -> dict:
    """Build the complete openclaw config dict from environment variables.

    Args:
        env: Dict of environment variables. Defaults to os.environ.

    Returns:
        Complete config dict ready to be written as JSON.
    """
    if env is None:
        env = dict(os.environ)

    # Treat empty-string env vars as unset so the documented defaults still
    # apply when callers pass an explicit "" (e.g. `docker build --build-arg
    # CHAT_UI_URL=`).
    proxy_host = env.get("NEMOCLAW_PROXY_HOST") or "10.200.0.1"
    proxy_port = env.get("NEMOCLAW_PROXY_PORT") or "3128"
    proxy_url = f"http://{proxy_host}:{proxy_port}"
    model = env["NEMOCLAW_MODEL"]
    chat_ui_url = env.get("CHAT_UI_URL") or "http://127.0.0.1:18789"
    provider_key = env["NEMOCLAW_PROVIDER_KEY"]
    primary_model_ref = env["NEMOCLAW_PRIMARY_MODEL_REF"]
    inference_base_url = env["NEMOCLAW_INFERENCE_BASE_URL"]
    inference_api = env["NEMOCLAW_INFERENCE_API"]
    context_window = int(env.get("NEMOCLAW_CONTEXT_WINDOW", "131072"))
    max_tokens = int(env.get("NEMOCLAW_MAX_TOKENS", "4096"))
    reasoning = env.get("NEMOCLAW_REASONING", "false") == "true"
    inference_inputs = [
        v.strip()
        for v in env.get("NEMOCLAW_INFERENCE_INPUTS", "text").split(",")
        if v.strip()
    ] or ["text"]

    _raw_agent_timeout = env.get("NEMOCLAW_AGENT_TIMEOUT", "600")
    if not _raw_agent_timeout.isdigit() or int(_raw_agent_timeout) <= 0:
        raise ValueError("NEMOCLAW_AGENT_TIMEOUT must be a positive integer")
    agent_timeout = int(_raw_agent_timeout)

    inference_compat = json.loads(
        base64.b64decode(env["NEMOCLAW_INFERENCE_COMPAT_B64"]).decode("utf-8")
    )

    msg_channels = json.loads(
        base64.b64decode(
            env.get("NEMOCLAW_MESSAGING_CHANNELS_B64", "W10=") or "W10="
        ).decode("utf-8")
    )
    _allowed_ids = json.loads(
        base64.b64decode(
            env.get("NEMOCLAW_MESSAGING_ALLOWED_IDS_B64", "e30=") or "e30="
        ).decode("utf-8")
    )
    _discord_guilds = json.loads(
        base64.b64decode(
            env.get("NEMOCLAW_DISCORD_GUILDS_B64", "e30=") or "e30="
        ).decode("utf-8")
    )

    _token_keys = {"discord": "token", "telegram": "botToken", "slack": "botToken"}
    _env_keys = {
        "discord": "DISCORD_BOT_TOKEN",
        "telegram": "TELEGRAM_BOT_TOKEN",
        "slack": "SLACK_BOT_TOKEN",
    }

    # Slack's Bolt SDK validates token shape at App construction (^xoxb-…$ /
    # ^xapp-…$) before any HTTP call leaves the process, so the canonical
    # openshell:resolve:env:VAR placeholder is rejected synchronously. Emit a
    # Bolt-regex-compatible placeholder instead; the slack-token-rewriter
    # Node preload translates it to canonical form on outbound HTTP, where
    # OpenShell's L7 proxy substitutes the real token from env.
    def _placeholder(channel: str, env_key: str) -> str:
        if channel == "slack" and env_key == "SLACK_BOT_TOKEN":
            return f"xoxb-OPENSHELL-RESOLVE-ENV-{env_key}"
        if channel == "slack" and env_key == "SLACK_APP_TOKEN":
            return f"xapp-OPENSHELL-RESOLVE-ENV-{env_key}"
        return f"openshell:resolve:env:{env_key}"

    _ch_cfg = {}
    for ch in msg_channels:
        if ch not in _token_keys:
            continue
        account = {
            _token_keys[ch]: _placeholder(ch, _env_keys[ch]),
            "enabled": True,
            "healthMonitor": {"enabled": False},
        }
        if ch == "slack":
            account["appToken"] = _placeholder(ch, "SLACK_APP_TOKEN")
        if ch in ("telegram", "discord"):
            account["proxy"] = proxy_url
        if ch == "telegram":
            account["groupPolicy"] = "open"
        if ch in _allowed_ids and _allowed_ids[ch]:
            account["dmPolicy"] = "allowlist"
            account["allowFrom"] = _allowed_ids[ch]
        _ch_cfg[ch] = {"accounts": {"default": account}}

    if "discord" in _ch_cfg and _discord_guilds:
        _ch_cfg["discord"].update(
            {"groupPolicy": "allowlist", "guilds": _discord_guilds}
        )

    # Normalize schemeless URLs before parsing — urlparse("remote-host:18789")
    # misclassifies hostname as scheme. Mirrors ensureScheme() in dashboard-contract.ts.
    _normalized_url = chat_ui_url
    if chat_ui_url and not re.match(r"^[a-z][a-z0-9+.-]*://", chat_ui_url, re.IGNORECASE):
        _normalized_url = f"http://{chat_ui_url}"

    parsed = urlparse(_normalized_url)
    chat_origin = (
        f"{parsed.scheme}://{parsed.netloc}"
        if parsed.scheme and parsed.netloc
        else "http://127.0.0.1:18789"
    )
    origins = list(dict.fromkeys(["http://127.0.0.1:18789", chat_origin]))

    # Auto-disable device auth when CHAT_UI_URL is non-loopback — terminal-based
    # pairing is impossible when the user only has web access (Brev Launchable,
    # remote deployments). The explicit env var override still works but cannot
    # re-enable device auth for non-loopback URLs (security default).
    _is_remote = not is_loopback(parsed.hostname or "")
    disable_device_auth = (
        env.get("NEMOCLAW_DISABLE_DEVICE_AUTH", "") == "1"
        or _is_remote
    )
    allow_insecure = parsed.scheme == "http"

    providers = {
        provider_key: {
            "baseUrl": inference_base_url,
            "apiKey": "unused",
            "api": inference_api,
            "models": [
                {
                    **({"compat": inference_compat} if inference_compat else {}),
                    "id": model,
                    "name": primary_model_ref,
                    "reasoning": reasoning,
                    "input": inference_inputs,
                    "cost": {
                        "input": 0,
                        "output": 0,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                    },
                    "contextWindow": context_window,
                    "maxTokens": max_tokens,
                }
            ],
        }
    }

    # OpenClaw 2026.4.24 stages runtime dependencies for every bundled
    # enabledByDefault provider plugin during `openclaw doctor --fix`.
    # NemoClaw bakes one model provider into openclaw.json, so keeping unused
    # default providers enabled bloats the sandbox image and can exhaust the
    # CI k3s/containerd import volume before tests even start.
    plugin_entries = {
        "acpx": {
            "config": {
                "agents": {
                    "codex": {"command": "/usr/local/bin/nemoclaw-codex-acp"},
                }
            }
        },
        "bonjour": {"enabled": False},
        "qqbot": {"enabled": False},
    }
    _bundled_provider_plugins = {
        "amazon-bedrock": {"amazon-bedrock", "bedrock"},
        "amazon-bedrock-mantle": {"amazon-bedrock-mantle"},
        "anthropic": {"anthropic"},
        "anthropic-vertex": {"anthropic-vertex"},
        "google": {"google", "google-gemini-cli"},
    }
    for _plugin_id, _provider_keys in _bundled_provider_plugins.items():
        if provider_key not in _provider_keys:
            plugin_entries[_plugin_id] = {"enabled": False}

    config = {
        "agents": {
            "defaults": {
                "model": {"primary": primary_model_ref},
                "timeoutSeconds": agent_timeout,
                # NemoClaw sandboxes are provisioned non-interactively and the
                # E2E CLI contract expects the first agent turn to answer the
                # caller's prompt. OpenClaw 2026.4.24 seeds BOOTSTRAP.md by
                # default, which redirects a fresh workspace into an identity
                # setup conversation before normal replies.
                "skipBootstrap": True,
                # Keep first-turn smoke checks on the lowest-latency path.
                # OpenClaw can infer thinking defaults from the model catalog;
                # NemoClaw's sandbox contract is a direct CLI answer, not an
                # interactive reasoning session.
                "thinkingDefault": "off",
            }
        },
        "models": {"mode": "merge", "providers": providers},
        "channels": {"defaults": {}, **_ch_cfg},
        "update": {"checkOnStart": False},
        # Disable bundled plugins/channels that hit the L7 proxy at startup
        # and either crash or hang the gateway:
        #
        #   bonjour — uses @homebridge/ciao for mDNS announcement; sandbox
        #     netns has no multicast, ciao either fails sync via
        #     uv_interface_addresses or async via "CIAO PROBING CANCELLED".
        #     Introduced in OpenClaw 2026.4.15. See NemoClaw#2484.
        #
        #   qqbot — has stageRuntimeDependencies=true, so its npm deps
        #     (@tencent-connect/qqbot-connector et al.) install on first
        #     load. The sandbox L7 proxy denies the registry URL, the
        #     install retries for ~6 minutes, and while it's stuck the
        #     gateway can't service openclaw-agent requests — that's the
        #     TC-SBX-02 hang in 2026.4.24.
        #
        # acpx stays enabled, but its default codex adapter command is
        # `npx @zed-industries/codex-acp@^0.11.1`. npm refreshes registry
        # metadata for that package spec even when codex-acp is globally
        # installed, which hits the L7 proxy deny path during gateway startup.
        # The sandbox image pre-installs /usr/local/bin/codex-acp. The wrapper
        # below points ACPx at that binary with writable per-UID Codex/XDG
        # state so the gateway user does not try to write under /sandbox or
        # the sandbox user's redirected /tmp directories.
        #
        # Provider plugins with staged runtime dependencies are disabled above
        # unless they match NEMOCLAW_PROVIDER_KEY. That keeps the baked image
        # limited to the provider selected during onboard.
        "plugins": {"entries": plugin_entries},
        "gateway": {
            "mode": "local",
            "controlUi": {
                "allowInsecureAuth": allow_insecure,
                "dangerouslyDisableDeviceAuth": disable_device_auth,
                "allowedOrigins": origins,
            },
            "trustedProxies": ["127.0.0.1", "::1"],
            "auth": {"token": ""},
        },
    }

    if env.get("NEMOCLAW_WEB_SEARCH_ENABLED", "") == "1":
        config["tools"] = {
            "web": {
                "search": {
                    "enabled": True,
                    "provider": "brave",
                    "apiKey": "openshell:resolve:env:BRAVE_API_KEY",
                },
                "fetch": {"enabled": True},
            }
        }

    return config


def main() -> None:
    """Generate openclaw.json from environment variables."""
    config = build_config()
    path = os.path.expanduser("~/.openclaw/openclaw.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(config, f, indent=2)
    os.chmod(path, 0o600)


if __name__ == "__main__":
    main()
