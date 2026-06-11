#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Install OpenClaw plugins that match the bundled OpenClaw version.

OpenClaw's doctor repair uses the official catalog's unversioned plugin specs.
That can drift to a newer external plugin than the host OpenClaw runtime — for
messaging channels, the diagnostics OTEL exporter, and the Brave web-search
provider alike. NemoClaw pins the runtime with OPENCLAW_VERSION, so build-time
activation must force explicit npm installs for every external plugin and pin
them to that same version.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
from typing import Iterable


DEFAULT_CHANNELS_B64 = "W10="

EXTERNAL_CHANNEL_PACKAGES = {
    "discord": "@openclaw/discord",
    "slack": "@openclaw/slack",
    "whatsapp": "@openclaw/whatsapp",
}
DIAGNOSTICS_OTEL_PACKAGE = "@openclaw/diagnostics-otel"
# The Brave web-search provider is an external plugin too. Without an explicit
# pin, `openclaw doctor --fix` installs it from the official catalog's
# unversioned npmSpec, which resolves to the newest published brave-plugin —
# newer than the host runtime once OpenClaw cuts a release the NemoClaw pin has
# not caught up to. The newer plugin imports plugin-SDK symbols the older host
# does not export, so web_search fails at runtime with
#   (0, _providerWebSearch.readPositiveIntegerParam) is not a function
# Pin it to OPENCLAW_VERSION like the messaging channels and diagnostics OTEL
# exporter above so the installed plugin always matches the host runtime.
WEB_SEARCH_PLUGIN_PACKAGE = "@openclaw/brave-plugin"

DOCTOR_ENV_BY_CHANNEL = {
    "telegram": {
        "TELEGRAM_BOT_TOKEN": "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
    },
    "discord": {
        "DISCORD_BOT_TOKEN": "openshell:resolve:env:DISCORD_BOT_TOKEN",
    },
    "slack": {
        "SLACK_BOT_TOKEN": "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
        "SLACK_APP_TOKEN": "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
    },
}


class BuildMessagingPluginError(RuntimeError):
    """Raised for configuration errors that should fail the image build."""


def decode_channels(raw: str) -> list[str]:
    try:
        decoded = base64.b64decode(raw, validate=True)
        parsed = json.loads(decoded.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001 - keep the build error actionable.
        raise BuildMessagingPluginError(
            "NEMOCLAW_MESSAGING_CHANNELS_B64 must be base64-encoded JSON array"
        ) from exc

    if not isinstance(parsed, list):
        raise BuildMessagingPluginError(
            "NEMOCLAW_MESSAGING_CHANNELS_B64 must decode to a JSON array"
        )

    channels: list[str] = []
    seen: set[str] = set()
    for item in parsed:
        if not isinstance(item, str):
            raise BuildMessagingPluginError(
                "NEMOCLAW_MESSAGING_CHANNELS_B64 may contain only string channel names"
            )
        channel = item.strip().lower()
        if not channel or channel in seen:
            continue
        seen.add(channel)
        channels.append(channel)
    return channels


def is_truthy_env(value: str | None) -> bool:
    if value is None or value.strip() == "":
        return False
    return value.strip().lower() not in {"0", "false", "no", "off"}


def require_openclaw_version(
    channels: Iterable[str],
    env: dict[str, str],
    *,
    diagnostics_otel_enabled: bool,
    web_search_enabled: bool,
) -> str:
    needs_external_install = any(channel in EXTERNAL_CHANNEL_PACKAGES for channel in channels)
    needs_external_install = (
        needs_external_install or diagnostics_otel_enabled or web_search_enabled
    )
    version = (env.get("OPENCLAW_VERSION") or "").strip()
    if needs_external_install and not version:
        raise BuildMessagingPluginError(
            "OPENCLAW_VERSION is required when external OpenClaw plugins are enabled"
        )
    return version


def plugin_specs(
    channels: Iterable[str],
    openclaw_version: str,
    *,
    diagnostics_otel_enabled: bool,
    web_search_enabled: bool,
) -> list[str]:
    specs: list[str] = []
    for channel in channels:
        package_name = EXTERNAL_CHANNEL_PACKAGES.get(channel)
        if package_name:
            specs.append(f"npm:{package_name}@{openclaw_version}")
    if diagnostics_otel_enabled:
        specs.append(f"npm:{DIAGNOSTICS_OTEL_PACKAGE}@{openclaw_version}")
    if web_search_enabled:
        specs.append(f"npm:{WEB_SEARCH_PLUGIN_PACKAGE}@{openclaw_version}")
    return specs


def doctor_env_overrides(
    channels: Iterable[str],
    *,
    web_search_enabled: bool,
) -> dict[str, str]:
    overrides: dict[str, str] = {}
    for channel in channels:
        overrides.update(DOCTOR_ENV_BY_CHANNEL.get(channel, {}))
    # The generated config references openshell:resolve:env:BRAVE_API_KEY in
    # tools.web.search.apiKey. `openclaw doctor --fix` runs with only this env,
    # so without the placeholder set it can mutate/strip the web-search block.
    # Inject it the same way the messaging channel tokens above are injected.
    if web_search_enabled:
        overrides["BRAVE_API_KEY"] = "openshell:resolve:env:BRAVE_API_KEY"
    return overrides


def run_command(args: list[str], *, env: dict[str, str] | None = None) -> None:
    print("+ " + " ".join(args), flush=True)
    subprocess.run(args, check=True, env=env)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the derived plugin specs and doctor env overrides as JSON.",
    )
    args = parser.parse_args(argv)

    raw_channels = os.environ.get("NEMOCLAW_MESSAGING_CHANNELS_B64", DEFAULT_CHANNELS_B64)
    channels = decode_channels(raw_channels or DEFAULT_CHANNELS_B64)
    diagnostics_otel_enabled = is_truthy_env(os.environ.get("NEMOCLAW_OPENCLAW_OTEL"))
    web_search_enabled = is_truthy_env(os.environ.get("NEMOCLAW_WEB_SEARCH_ENABLED"))
    openclaw_version = require_openclaw_version(
        channels,
        os.environ,
        diagnostics_otel_enabled=diagnostics_otel_enabled,
        web_search_enabled=web_search_enabled,
    )
    specs = plugin_specs(
        channels,
        openclaw_version,
        diagnostics_otel_enabled=diagnostics_otel_enabled,
        web_search_enabled=web_search_enabled,
    )
    env_overrides = doctor_env_overrides(
        channels, web_search_enabled=web_search_enabled
    )

    if args.dry_run:
        print(
            json.dumps(
                {
                    "channels": channels,
                    "diagnosticsOtelEnabled": diagnostics_otel_enabled,
                    "doctorEnv": env_overrides,
                    "installSpecs": specs,
                    "openclawVersion": openclaw_version,
                    "webSearchEnabled": web_search_enabled,
                },
                indent=2,
                sort_keys=True,
            )
        )
        return 0

    for spec in specs:
        run_command(["openclaw", "plugins", "install", spec, "--pin"])

    doctor_env = os.environ.copy()
    doctor_env.update(env_overrides)
    run_command(["openclaw", "doctor", "--fix", "--non-interactive"], env=doctor_env)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except BuildMessagingPluginError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(2)
