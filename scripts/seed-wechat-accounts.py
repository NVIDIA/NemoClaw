#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Seed @tencent-weixin/openclaw-weixin's local account store with the
# session metadata captured by NemoClaw's host-side QR login (see
# src/lib/wechat/login.ts). Runs once at sandbox image build time.
#
# Skips the upstream plugin's own `openclaw channels login` flow, which
# would otherwise drive an in-sandbox QR scan that has no terminal and no
# paired phone access.
#
# Files written (matching auth/accounts.ts in @tencent-weixin/openclaw-weixin@2.4.2):
#   <stateDir>/openclaw-weixin/accounts.json                  — JSON array of accountIds
#   <stateDir>/openclaw-weixin/accounts/<accountId>.json      — { token, savedAt, baseUrl, userId }
#   <stateDir>/openclaw.json (channels.openclaw-weixin)       — registered channel + accounts.<id>.enabled
#
# The third file is the one OpenClaw consults at startup to know the channel
# is registered. Without channels.openclaw-weixin.accounts.<id>.enabled=true
# in openclaw.json, the plugin's auth/accounts.ts considers the account
# disabled and the bridge won't start, even if the per-account state files
# above exist. We mutate openclaw.json HERE (post-install) rather than in
# generate-openclaw-config.py because writing channels.openclaw-weixin
# upfront races with `openclaw plugins install`, which fails with "unknown
# channel id: openclaw-weixin" if the channel block exists before the plugin
# has registered it.
#
# State dir resolution mirrors the upstream's resolveStateDir():
#   $OPENCLAW_STATE_DIR || $CLAWDBOT_STATE_DIR || ~/.openclaw
#
# Token field carries the canonical NemoClaw placeholder
# `openshell:resolve:env:WECHAT_BOT_TOKEN`. The OpenShell L7 proxy rewrites
# that string to the real bot token at egress, so the secret never lands
# on disk inside the image.
#
# Inputs (from environment, populated by the Dockerfile patcher):
#   NEMOCLAW_WECHAT_CONFIG_B64               Base64-encoded JSON: {accountId, baseUrl, userId}.
#                                            When accountId is empty (no host-side QR login
#                                            captured), the script no-ops cleanly.
#   NEMOCLAW_MESSAGING_CHANNELS_B64          Base64-encoded JSON array of active channel names.
#                                            When "wechat" is absent (operator stopped the
#                                            channel via `nemoclaw <sandbox> channels stop
#                                            wechat`), we still write the per-account state
#                                            files so a later `channels start wechat` can
#                                            revive the bridge without a fresh QR scan — but
#                                            we skip patching openclaw.json, so the bridge
#                                            stays dormant until the channel is re-enabled.

from __future__ import annotations

import base64
import datetime as _dt
import json
import os
import pathlib
import sys


WECHAT_TOKEN_PLACEHOLDER = "openshell:resolve:env:WECHAT_BOT_TOKEN"


def _wechat_enabled() -> bool:
    """Decide whether wechat is in the active-channel whitelist for this build.

    NEMOCLAW_MESSAGING_CHANNELS_B64 carries the list of channels onboard
    selected after applying the disable filter. When wechat is absent the
    bridge must stay dormant on this image, so we skip the openclaw.json
    patch even though the per-account state files still get written.
    """
    raw = os.environ.get("NEMOCLAW_MESSAGING_CHANNELS_B64", "W10=") or "W10="
    try:
        channels = json.loads(base64.b64decode(raw).decode("utf-8"))
    except (ValueError, json.JSONDecodeError):
        return False
    return isinstance(channels, list) and "wechat" in channels


def _state_dir() -> pathlib.Path:
    raw = (
        os.environ.get("OPENCLAW_STATE_DIR")
        or os.environ.get("CLAWDBOT_STATE_DIR")
        or os.path.join(os.path.expanduser("~"), ".openclaw")
    )
    return pathlib.Path(raw.strip()).resolve()


def _decode_config() -> dict:
    raw = os.environ.get("NEMOCLAW_WECHAT_CONFIG_B64", "e30=") or "e30="
    try:
        decoded = base64.b64decode(raw).decode("utf-8")
        parsed = json.loads(decoded)
    except (ValueError, json.JSONDecodeError) as err:
        print(
            f"[seed-wechat-accounts] could not decode NEMOCLAW_WECHAT_CONFIG_B64: {err}",
            file=sys.stderr,
        )
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _atomic_write(path: pathlib.Path, payload: str, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(payload, encoding="utf-8")
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def _js_iso_utc() -> str:
    """ISO-8601 UTC with millisecond precision and trailing 'Z' — the format
    JavaScript's Date.toISOString() emits, which is what the upstream plugin
    writes to channelConfigUpdatedAt."""
    now = _dt.datetime.now(_dt.timezone.utc)
    return f"{now.strftime('%Y-%m-%dT%H:%M:%S')}.{now.microsecond // 1000:03d}Z"


def _patch_openclaw_config(account_id: str) -> None:
    """Register channels.openclaw-weixin.accounts.<accountId>.enabled=true in
    openclaw.json. The upstream plugin's auth/accounts.ts reads this block to
    decide which accounts to start at boot."""
    cfg_path = _state_dir() / "openclaw.json"
    if not cfg_path.exists():
        # generate-openclaw-config.py runs before us and is responsible for
        # producing openclaw.json. If it's missing, something else broke; bail
        # without inventing a config.
        print(
            f"[seed-wechat-accounts] {cfg_path} not found; cannot register channel",
            file=sys.stderr,
        )
        return

    try:
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as err:
        print(
            f"[seed-wechat-accounts] could not parse {cfg_path}: {err}",
            file=sys.stderr,
        )
        return
    if not isinstance(cfg, dict):
        print(
            f"[seed-wechat-accounts] {cfg_path} root is not a JSON object; cannot register channel",
            file=sys.stderr,
        )
        return

    channels = cfg.setdefault("channels", {})
    weixin = channels.setdefault("openclaw-weixin", {})
    weixin["channelConfigUpdatedAt"] = _js_iso_utc()
    accounts = weixin.setdefault("accounts", {})
    accounts[account_id] = {"enabled": True}

    _atomic_write(cfg_path, json.dumps(cfg, indent=2) + "\n", 0o600)
    print(
        f"[seed-wechat-accounts] registered channels.openclaw-weixin.accounts.{account_id} in {cfg_path}"
    )


def main() -> int:
    config = _decode_config()
    account_id = (config.get("accountId") or "").strip()
    base_url = (config.get("baseUrl") or "").strip()
    user_id = (config.get("userId") or "").strip()

    # accountId is non-secret but mandatory: without it we can't pick a
    # filename, and the upstream plugin won't see any registered accounts.
    # Empty accountId is the expected state when the operator did not go
    # through a host-side QR login (e.g. wechat channel never picked) —
    # no-op silently instead of warning, since this script now runs on
    # every build from generate-openclaw-config.py.
    if not account_id:
        return 0

    plugin_dir = _state_dir() / "openclaw-weixin"
    accounts_index = plugin_dir / "accounts.json"
    account_file = plugin_dir / "accounts" / f"{account_id}.json"

    # Per-account credential file. Schema mirrors WeixinAccountData; ordering
    # mirrors saveWeixinAccount() so a future upstream save merges cleanly.
    account_payload: dict[str, str] = {
        "token": WECHAT_TOKEN_PLACEHOLDER,
        "savedAt": _dt.datetime.now(_dt.timezone.utc).isoformat(),
    }
    if base_url:
        account_payload["baseUrl"] = base_url
    if user_id:
        account_payload["userId"] = user_id

    _atomic_write(account_file, json.dumps(account_payload, indent=2) + "\n", 0o600)

    # Account index. Append-only semantics: if the upstream plugin or a prior
    # seed step already registered other accountIds, preserve them.
    existing: list[str] = []
    if accounts_index.exists():
        try:
            raw = json.loads(accounts_index.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                existing = [item for item in raw if isinstance(item, str) and item.strip()]
        except json.JSONDecodeError:
            existing = []

    if account_id not in existing:
        existing.append(account_id)
        _atomic_write(accounts_index, json.dumps(existing, indent=2) + "\n", 0o600)

    print(
        f"[seed-wechat-accounts] seeded {account_file} and registered {account_id} in {accounts_index}"
    )

    # Only register the channel in openclaw.json when wechat is enabled for
    # this build. When the operator stopped the channel before rebuild,
    # NEMOCLAW_MESSAGING_CHANNELS_B64 omits "wechat" and we leave the patch
    # off — the account state files above are still on disk and ready for a
    # later `channels start wechat` rebuild to activate.
    if _wechat_enabled():
        _patch_openclaw_config(account_id)
    else:
        print(
            "[seed-wechat-accounts] wechat not in active channels; preserving account "
            "state files but skipping openclaw.json channel registration."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
