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
    NEMOCLAW_TELEGRAM_CONFIG_B64        Base64-encoded Telegram config (e.g. {"requireMention": true})
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
import sys
from pathlib import Path
from urllib.parse import urlparse

KNOWN_MODEL_SETUP_AGENTS = {"openclaw", "hermes"}
MODEL_SETUP_EFFECT_KEYS = {
    "openclaw": {"openclawCompat", "openclawPlugins"},
    "hermes": {"hermesCompat"},
}


def _coerce_positive_int(env: dict, name: str, default: int) -> int:
    raw = env.get(name) or str(default)
    try:
        value = int(raw)
    except ValueError:
        value = 0
    if value > 0:
        return value
    print(
        f'[SECURITY] {name} must be a positive integer, got "{raw}" '
        f"— skipping override, falling back to default ({default})",
        file=sys.stderr,
    )
    return default


def is_loopback(hostname: str) -> bool:
    """Check if a hostname is a loopback address.

    Mirrors isLoopbackHostname() from src/lib/core/url-utils.ts.
    Returns True for localhost, ::1, and 127.x.x.x addresses.
    """
    normalized = (hostname or "").strip().lower().strip("[]")
    if normalized == "localhost" or normalized == "::1":
        return True
    return bool(re.match(r"^127(?:\.\d{1,3}){3}$", normalized))


def _registry_roots(env: dict) -> list[Path]:
    roots: list[Path] = []
    explicit = env.get("NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR")
    if explicit:
        roots.append(Path(explicit))

    script_dir = Path(__file__).resolve().parent
    roots.extend(
        [
            Path("/opt/nemoclaw-blueprint/model-specific-setup"),
            Path("/sandbox/.nemoclaw/blueprints/0.1.0/model-specific-setup"),
            script_dir.parent / "nemoclaw-blueprint" / "model-specific-setup",
            Path.cwd() / "nemoclaw-blueprint" / "model-specific-setup",
        ]
    )

    unique_roots: list[Path] = []
    seen: set[str] = set()
    for root in roots:
        key = str(root)
        if key not in seen:
            unique_roots.append(root)
            seen.add(key)
    return unique_roots


def _find_registry_root(env: dict) -> Path | None:
    explicit = env.get("NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR")
    if explicit:
        explicit_path = Path(explicit)
        if not explicit_path.is_dir():
            raise ValueError(
                "NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR must point to an existing directory: "
                f"{explicit}"
            )
        return explicit_path

    for root in _registry_roots(env):
        if root.is_dir():
            return root
    return None


def _validate_manifest_payload(payload: object, manifest_path: Path) -> dict:
    if not isinstance(payload, dict):
        raise ValueError(f"{manifest_path}: manifest must be a JSON object")

    setup_id = payload.get("id")
    if not isinstance(setup_id, str) or not setup_id.strip():
        raise ValueError(f"{manifest_path}: field 'id' must be a non-empty string")

    agent = payload.get("agent")
    if not isinstance(agent, str) or not agent.strip():
        raise ValueError(f"{manifest_path}: field 'agent' is required")
    if agent not in KNOWN_MODEL_SETUP_AGENTS:
        raise ValueError(f"{manifest_path}: unknown agent '{agent}'")

    description = payload.get("description")
    if not isinstance(description, str) or not description.strip():
        raise ValueError(f"{manifest_path}: field 'description' must be a non-empty string")

    match = payload.get("match")
    if not isinstance(match, dict):
        raise ValueError(f"{manifest_path}: field 'match' must be an object")
    if not match:
        raise ValueError(f"{manifest_path}: field 'match' must be a non-empty object")
    allowed_match_keys = {"modelIds", "providerKey", "inferenceApi", "baseUrl"}
    unknown_match_keys = sorted(set(match) - allowed_match_keys)
    if unknown_match_keys:
        raise ValueError(
            f"{manifest_path}: unknown match keys: {', '.join(unknown_match_keys)}"
        )
    model_ids = match.get("modelIds")
    if model_ids is not None and (
        not isinstance(model_ids, list)
        or not model_ids
        or not all(isinstance(model_id, str) and model_id.strip() for model_id in model_ids)
    ):
        raise ValueError(f"{manifest_path}: match.modelIds must be a non-empty string array")
    for key in ("providerKey", "inferenceApi", "baseUrl"):
        value = match.get(key)
        if value is not None and (not isinstance(value, str) or not value.strip()):
            raise ValueError(f"{manifest_path}: match.{key} must be a non-empty string")

    effects = payload.get("effects")
    if not isinstance(effects, dict) or not effects:
        raise ValueError(f"{manifest_path}: field 'effects' must be a non-empty object")

    return payload


def _validate_selected_agent_effects(payload: dict, manifest_path: Path, registry_root: Path) -> None:
    agent = payload["agent"]
    effects = payload["effects"]
    allowed_effect_keys = MODEL_SETUP_EFFECT_KEYS[agent]
    unknown_effect_keys = sorted(set(effects) - allowed_effect_keys)
    if unknown_effect_keys:
        raise ValueError(
            f"{manifest_path}: unknown effects for agent '{agent}': "
            f"{', '.join(unknown_effect_keys)}"
        )

    if agent == "openclaw":
        compat = effects.get("openclawCompat")
        if compat is not None and not isinstance(compat, dict):
            raise ValueError(f"{manifest_path}: effects.openclawCompat must be an object")

        plugins = effects.get("openclawPlugins", [])
        if not isinstance(plugins, list):
            raise ValueError(f"{manifest_path}: effects.openclawPlugins must be an array")
        for index, plugin in enumerate(plugins):
            if not isinstance(plugin, dict):
                raise ValueError(
                    f"{manifest_path}: effects.openclawPlugins[{index}] must be an object"
                )
            for key in ("id", "path", "loadPath"):
                value = plugin.get(key)
                if not isinstance(value, str) or not value.strip():
                    raise ValueError(
                        f"{manifest_path}: effects.openclawPlugins[{index}].{key} "
                        "must be a non-empty string"
                    )
            source_path = Path(plugin["path"])
            if source_path.is_absolute() or ".." in source_path.parts:
                raise ValueError(
                    f"{manifest_path}: effects.openclawPlugins[{index}].path "
                    "must be relative to nemoclaw-blueprint"
                )
            if not (registry_root.parent / source_path).exists():
                raise ValueError(
                    f"{manifest_path}: effects.openclawPlugins[{index}].path does not exist: "
                    f"{plugin['path']}"
                )
            expected_load_path = f"/usr/local/share/nemoclaw/{plugin['path'].strip('/')}"
            if plugin["loadPath"].rstrip("/") != expected_load_path:
                raise ValueError(
                    f"{manifest_path}: effects.openclawPlugins[{index}].loadPath "
                    f"must be '{expected_load_path}'"
                )

    if agent == "hermes":
        compat = effects.get("hermesCompat")
        if compat is not None and not isinstance(compat, dict):
            raise ValueError(f"{manifest_path}: effects.hermesCompat must be an object")


def _model_setup_matches(payload: dict, context: dict) -> bool:
    match = payload["match"]
    model_ids = match.get("modelIds")
    if model_ids and context["model"].strip().lower() not in {
        model_id.strip().lower() for model_id in model_ids
    }:
        return False

    provider_key = match.get("providerKey")
    if provider_key and context["providerKey"] != provider_key:
        return False

    inference_api = match.get("inferenceApi")
    if inference_api and context["inferenceApi"] != inference_api:
        return False

    base_url = match.get("baseUrl")
    if base_url and context["baseUrl"].rstrip("/") != base_url.rstrip("/"):
        return False

    return True


def _matching_model_specific_setups(agent: str, context: dict, env: dict) -> list[dict]:
    registry_root = _find_registry_root(env)
    if registry_root is None:
        return []

    manifests: list[dict] = []
    for manifest_path in sorted(registry_root.glob("**/*.json")):
        if manifest_path.name == "schema.json":
            continue
        with open(manifest_path, "r", encoding="utf-8") as manifest_file:
            payload = _validate_manifest_payload(json.load(manifest_file), manifest_path)
        if payload["agent"] != agent:
            continue
        _validate_selected_agent_effects(payload, manifest_path, registry_root)
        if _model_setup_matches(payload, context):
            manifests.append(payload)
    return manifests


def _coerce_compat_dict(value: object) -> dict:
    if value is None:
        return {}
    if isinstance(value, dict):
        return value
    raise ValueError("NEMOCLAW_INFERENCE_COMPAT_B64 must decode to a JSON object or null")


def _apply_openclaw_setup_effects(
    setup: dict, inference_compat: dict, openclaw_plugins: list[dict], plugin_ids: set[str]
) -> None:
    effects = setup["effects"]
    for key, value in effects.get("openclawCompat", {}).items():
        if key in inference_compat and inference_compat[key] != value:
            raise ValueError(
                "model-specific setup "
                f"'{setup['id']}' conflicts with inference compat key '{key}'"
            )
        inference_compat[key] = value

    for plugin in effects.get("openclawPlugins", []):
        plugin_id = plugin["id"]
        if plugin_id in plugin_ids:
            raise ValueError(
                "model-specific setup "
                f"'{setup['id']}' declares duplicate OpenClaw plugin '{plugin_id}'"
            )
        plugin_ids.add(plugin_id)
        openclaw_plugins.append(plugin)


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
    context_window = _coerce_positive_int(env, "NEMOCLAW_CONTEXT_WINDOW", 131072)
    max_tokens = _coerce_positive_int(env, "NEMOCLAW_MAX_TOKENS", 4096)

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

    model_specific_setups = _matching_model_specific_setups(
        "openclaw",
        {
            "model": model,
            "providerKey": provider_key,
            "baseUrl": inference_base_url,
            "inferenceApi": inference_api,
        },
        env,
    )

    inference_compat = _coerce_compat_dict(
        json.loads(
            base64.b64decode(env["NEMOCLAW_INFERENCE_COMPAT_B64"]).decode("utf-8")
        )
    )
    openclaw_plugins: list[dict] = []
    openclaw_plugin_ids: set[str] = set()
    for setup in model_specific_setups:
        _apply_openclaw_setup_effects(
            setup, inference_compat, openclaw_plugins, openclaw_plugin_ids
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
    _telegram_config = json.loads(
        base64.b64decode(
            env.get("NEMOCLAW_TELEGRAM_CONFIG_B64", "e30=") or "e30="
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

    if "telegram" in _ch_cfg and _telegram_config.get("requireMention"):
        _ch_cfg["telegram"]["groups"] = {"*": {"requireMention": True}}

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
    # When onboard injects an internal port (e.g. :18789) into a URL that the
    # user provided without an explicit port, the browser origin from a reverse
    # proxy (Brev Cloudflare Tunnel, nginx, Caddy, etc.) will not carry that
    # port.  Include the portless origin so both direct and proxied access work.
    # Skip for loopback — no reverse proxy in front of localhost.
    try:
        _has_explicit_port = parsed.port is not None
    except ValueError:
        _has_explicit_port = False
    if parsed.scheme and parsed.hostname and _has_explicit_port and not is_loopback(parsed.hostname):
        host_part = f"[{parsed.hostname}]" if ":" in parsed.hostname else parsed.hostname
        portless_origin = f"{parsed.scheme}://{host_part}"
    else:
        portless_origin = None
    origins = list(dict.fromkeys(
        filter(None, ["http://127.0.0.1:18789", chat_origin, portless_origin])
    ))

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

    # OpenClaw stages runtime dependencies for every bundled enabledByDefault
    # provider plugin. NemoClaw bakes one model provider into openclaw.json, so
    # keeping unused default providers enabled bloats image builds and, once the
    # gateway has write access to plugin-runtime-deps, can stall first startup.
    plugin_entries = {
        "acpx": {"enabled": False},
        "bonjour": {"enabled": False},
        "qqbot": {"enabled": False},
    }
    _bundled_provider_plugins = {
        "amazon-bedrock": {"amazon-bedrock", "bedrock"},
        "amazon-bedrock-mantle": {"amazon-bedrock-mantle"},
        "anthropic": {"anthropic"},
        "anthropic-vertex": {"anthropic-vertex"},
        "fireworks": {"fireworks"},
        "google": {"google", "google-gemini-cli"},
        "kimi": {"kimi"},
        "lmstudio": {"lmstudio"},
        "ollama": {"ollama", "ollama-local"},
        "openai": {"openai"},
        "xai": {"xai"},
    }
    for _plugin_id, _provider_keys in _bundled_provider_plugins.items():
        if provider_key not in _provider_keys:
            plugin_entries[_plugin_id] = {"enabled": False}

    plugins = {"entries": plugin_entries}
    plugin_load_paths: list[str] = []
    for plugin in openclaw_plugins:
        plugin_entries[plugin["id"]] = {"enabled": True}
        if plugin["loadPath"] not in plugin_load_paths:
            plugin_load_paths.append(plugin["loadPath"])
    if plugin_load_paths:
        plugins["load"] = {"paths": plugin_load_paths}

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
        # acpx is disabled by default because its runtime dependency staging
        # also reaches npm during gateway startup. NemoClaw's primary CLI path
        # invokes openclaw-agent directly, not ACPx.
        #
        # Provider plugins with staged runtime dependencies are disabled above
        # unless they match NEMOCLAW_PROVIDER_KEY. That keeps the baked image
        # limited to the provider selected during onboard.
        "plugins": plugins,
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
