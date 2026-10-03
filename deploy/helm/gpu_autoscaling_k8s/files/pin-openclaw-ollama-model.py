#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Pin OpenClaw to the Ollama model and keep the sandbox light. No extra Node CLI."""

from __future__ import annotations

import json
import os
import pathlib
import sqlite3
import subprocess
import sys

MODEL = sys.argv[1] if len(sys.argv) > 1 else "llama3.2:3b"
try:
    MAX_TOKENS = int(sys.argv[2]) if len(sys.argv) > 2 else int(os.environ.get("MAX_TOKENS", "128"))
except ValueError:
    MAX_TOKENS = 128
if MAX_TOKENS < 8:
    MAX_TOKENS = 8
PRIMARY = MODEL if MODEL.startswith("inference/") else f"inference/{MODEL}"
BARE = PRIMARY[len("inference/") :]
PATH = pathlib.Path(os.environ.get("OPENCLAW_JSON_PATH", "/sandbox/.openclaw/openclaw.json"))
KEEP_PLUGINS = {"nemoclaw"}
SNAPSHOT_NAMES = (
    "openclaw.json.bak",
    "openclaw.json.last-good",
    "openclaw.json.nemoclaw-baseline",
)
SANDBOX_UID = 1000
SANDBOX_GID = 1000


def _load_json(path: pathlib.Path) -> dict | None:
    try:
        blob = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return blob if isinstance(blob, dict) else None


def _bounded_version(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    if len(value.encode("utf-8")) > 256 or any(ch in value for ch in "\0\r\n"):
        return None
    return value or None


def _continuity_meta(cfg: dict | None) -> dict | None:
    if not isinstance(cfg, dict):
        return None
    meta = cfg.get("meta")
    if not isinstance(meta, dict):
        return None
    version = _bounded_version(meta.get("lastTouchedVersion"))
    if version is None:
        return None
    # OpenClaw 2026.9.1 rejects lastTouchedAt; keep only the version field.
    return {"lastTouchedVersion": version}


def _keep_plugin_id(key: object) -> bool:
    text = str(key)
    return text in KEEP_PLUGINS or text.startswith("nemoclaw")


def _slim_install_records(blob: object) -> object:
    if isinstance(blob, dict):
        return {key: value for key, value in blob.items() if _keep_plugin_id(key)}
    if isinstance(blob, list):
        kept = []
        for item in blob:
            if not isinstance(item, dict):
                continue
            ident = item.get("pluginId") or item.get("id") or item.get("packageName") or ""
            if _keep_plugin_id(ident):
                kept.append(item)
        return kept
    return blob


def _slim_openclaw_state() -> None:
    # OpenClaw stores a 5-minute startup-migration lease and npm install records
    # in sqlite. Leftover leases block :18789; discord/slack install records
    # fail boot when e2e deleted those npm trees.
    db = PATH.parent / "state" / "openclaw.sqlite"
    if not db.is_file():
        return
    con = sqlite3.connect(db, timeout=8)
    try:
        try:
            con.execute("DELETE FROM state_leases WHERE scope = ?", ("startup-migrations",))
        except sqlite3.Error:
            pass  # Older OpenClaw DBs omit state_leases; skip the lock cleanup.
        try:
            rows = list(con.execute("SELECT index_key, install_records_json FROM installed_plugin_index"))
        except sqlite3.Error:
            rows = []
        for key, raw in rows:
            if not raw:
                continue
            try:
                recs = json.loads(raw)
            except json.JSONDecodeError:
                continue
            con.execute(
                "UPDATE installed_plugin_index SET install_records_json = ? WHERE index_key = ?",
                (json.dumps(_slim_install_records(recs)), key),
            )
        con.commit()
        con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        con.close()


def _enable_keep_only(entries: dict) -> None:
    if "nemoclaw" not in entries:
        entries["nemoclaw"] = {}
    for key, value in list(entries.items()):
        keep = key in KEEP_PLUGINS or str(key).startswith("nemoclaw")
        if not keep:
            # Leaving disabled entries still makes OpenClaw npm-install them
            # (403 + OOM in 1Gi e2e sandboxes). Drop them instead.
            del entries[key]
            continue
        blob = dict(value) if isinstance(value, dict) else {}
        blob["enabled"] = True
        entries[key] = blob


def _replace_text(path: pathlib.Path, text: str) -> None:
    if path.exists() or path.is_symlink():
        path.unlink()
    path.write_text(text)
    if path.read_text() != text:
        raise SystemExit(f"failed to persist {path}")


def _own(path: pathlib.Path) -> None:
    try:
        os.chown(path, SANDBOX_UID, SANDBOX_GID)
    except OSError:
        pass  # Image user may already own the file; keep going so chmod still runs.
    try:
        path.chmod(0o660)
    except OSError:
        pass  # Read-only snapshots are left as-is.


def main() -> int:
    if not PATH.is_file():
        print(f"missing {PATH}", file=sys.stderr)
        return 1

    cfg = _load_json(PATH)
    if cfg is None:
        print(f"unreadable {PATH}", file=sys.stderr)
        return 1

    # OpenClaw restores last-good/.bak when a rewrite drops meta.lastTouchedVersion
    # (`missing-meta-vs-last-good`). That brings messaging plugins back and npm-installs
    # them at start. Keep the bounded version and overwrite every snapshot OpenClaw reads.
    meta = (
        _continuity_meta(cfg)
        or _continuity_meta(_load_json(PATH.with_name("openclaw.json.bak")))
        or _continuity_meta(_load_json(PATH.with_name("openclaw.json.last-good")))
        or _continuity_meta(_load_json(PATH.with_name("openclaw.json.nemoclaw-baseline")))
    )
    if meta is not None:
        cfg["meta"] = meta
    else:
        cfg.pop("meta", None)

    defaults = cfg.setdefault("agents", {}).setdefault("defaults", {})
    defaults.setdefault("model", {})["primary"] = PRIMARY
    defaults["skipBootstrap"] = True
    defaults["thinkingDefault"] = "off"
    defaults.pop("heartbeat", None)

    provider = cfg.setdefault("models", {}).setdefault("providers", {}).setdefault("inference", {})
    provider["baseUrl"] = "https://inference.local/v1"
    provider["api"] = "openai-completions"
    models = provider.get("models")
    if not isinstance(models, list) or not models or not isinstance(models[0], dict):
        provider["models"] = [{}]
        models = provider["models"]
    models[0]["id"] = BARE
    models[0]["name"] = PRIMARY
    # OpenClaw defaults to SSE. OpenShell MITM + the metrics-proxy truncates
    # streamed bodies ("response truncated: upstream read error"). JSON
    # chat.completions is the path that returns 200 with content.
    params = models[0].get("params")
    if not isinstance(params, dict):
        params = {}
        models[0]["params"] = params
    # Same payload shape as files/load-generator.ts (stream=false, max_tokens).
    params["stream"] = False
    params["max_tokens"] = MAX_TOKENS
    models[0]["maxTokens"] = MAX_TOKENS

    plugins = cfg.setdefault("plugins", {})
    entries = plugins.setdefault("entries", {})
    if not isinstance(entries, dict):
        entries = {}
        plugins["entries"] = entries
    _enable_keep_only(entries)
    plugins["allow"] = sorted(KEEP_PLUGINS)
    plugins.pop("installs", None)

    tools = cfg.setdefault("tools", {})
    tools["toolSearch"] = False
    deny = tools.get("deny")
    if not isinstance(deny, list):
        deny = []
    for name in ("message", "cron", "gateway", "nodes", "sessions_send"):
        if name not in deny:
            deny.append(name)
    tools["deny"] = deny
    web = tools.setdefault("web", {})
    if not isinstance(web, dict):
        web = {}
        tools["web"] = web
    web["search"] = {"enabled": False}
    web["fetch"] = {"enabled": False, "useTrustedEnvProxy": True}

    gateway = cfg.setdefault("gateway", {})
    gateway["reload"] = {"mode": "off"}
    ui = gateway.setdefault("controlUi", {})
    if isinstance(ui, dict):
        # Serve Control UI on first start so publish does not restart every sandbox.
        ui["enabled"] = True
        ui["dangerouslyDisableDeviceAuth"] = True
        ui["dangerouslyAllowHostHeaderOriginFallback"] = True
        origins = ui.get("allowedOrigins")
        if not isinstance(origins, list):
            origins = []
        for item in ("http://127.0.0.1:18789", "http://localhost:18789"):
            if item not in origins:
                origins.append(item)
        ui["allowedOrigins"] = origins

    cfg.setdefault("update", {})["checkOnStart"] = False

    channels = cfg.get("channels")
    if isinstance(channels, dict):
        # Messaging channel keys without their plugins make OpenClaw exit 78
        # (`unknown channel id: openclaw-weixin`). E2E only talks over the
        # gateway HTTP port.
        for key in list(channels):
            del channels[key]

    text = json.dumps(cfg, indent=2) + "\n"
    _replace_text(PATH, text)
    targets = [PATH]
    for name in SNAPSHOT_NAMES:
        snap = PATH.with_name(name)
        _replace_text(snap, text)
        targets.append(snap)
    # OpenClaw rotates openclaw.json.bak.1 … and restores those copies.
    # Leaving the image's full-plugin snapshots makes start reinstall discord.
    for extra in PATH.parent.glob("openclaw.json.bak*"):
        _replace_text(extra, text)
        targets.append(extra)
    for stale in PATH.parent.glob("openclaw.json.clobbered*"):
        try:
            stale.unlink()
        except OSError:
            pass  # Concurrent start may already have removed a clobbered snapshot.
    try:
        digest = subprocess.check_output(["sha256sum", PATH.name], cwd=PATH.parent, text=True)
        hash_path = PATH.parent / ".config-hash"
        _replace_text(hash_path, digest)
        targets.append(hash_path)
    except (OSError, subprocess.CalledProcessError):
        pass  # Hash file is optional; OpenClaw still reads the rewritten JSON.
    for path in dict.fromkeys(targets):
        _own(path)
    _slim_openclaw_state()
    print(f"pinned {PRIMARY} (light plugins={','.join(sorted(KEEP_PLUGINS))})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
