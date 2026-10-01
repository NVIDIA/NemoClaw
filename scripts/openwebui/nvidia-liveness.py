#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# nvidia-liveness — daily sweep that keeps open-webui's NVIDIA model list current.
#
# Steps each run:
#   1. GET https://integrate.api.nvidia.com/v1/models with the host's NVIDIA key
#   2. Send a 1-token chat probe to each discovered model
#   3. Mark live/dead in ~/.nemoclaw/openwebui/liveness.json (consumed by
#      nvidia-proxy at request time)
#   4. Toggle is_active=0 on rows in webui.db whose base_model_id is dead,
#      so the curated picker auto-prunes too.
#
# Dead promotion is gated twice: a single sweep must see DEAD_AFTER_FAILS
# consecutive failures OR an explicit 410, AND the row is only disabled after
# TWO consecutive sweeps both classify the model dead — so one flaky probe
# pass (rate-limit 429s, transient 5xx, cold-start slowness) can never gut
# the picker. 429/5xx are treated as transient (no failure credit). Lenient
# by design: unknown/new models stay visible until proven dead.
#
# Triggered by ~/Library/LaunchAgents/dev.nemoclaw.nvidia-liveness.plist daily.
# Manual run: python3 nvidia-liveness.py

from __future__ import annotations

import fnmatch
import json
import os
import re
import sqlite3
import sys
import time
import tomllib
import urllib.error
import urllib.request
from pathlib import Path

HOME = Path(os.environ["HOME"])
SCRIPT_DIR = Path(__file__).resolve().parent
CREDENTIALS = Path(os.environ.get("NEMOCLAW_CREDENTIALS", HOME / ".nemoclaw/credentials.json"))
LIVENESS_FILE = Path(os.environ.get("NVIDIA_LIVENESS_FILE", HOME / ".nemoclaw/openwebui/liveness.json"))
LOG_FILE = Path(os.environ.get("NVIDIA_LIVENESS_LOG", HOME / ".nemoclaw/openwebui/liveness.log"))
CURATION_FILE = Path(os.environ.get("NVIDIA_CURATION_FILE", SCRIPT_DIR / "nvidia-curation.toml"))
WEBUI_DB = Path(os.environ.get("WEBUI_DB", HOME / ".nemoclaw/openwebui/data/webui.db"))
UPSTREAM = os.environ.get("NVIDIA_UPSTREAM", "https://integrate.api.nvidia.com")
DEAD_AFTER_FAILS = int(os.environ.get("DEAD_AFTER_FAILS", "3"))
# Intentionally generous: deactivated/removed models return HTTP 4xx immediately,
# so they're caught by status code, not timeout. This limit only fires for a model
# that accepts the TCP connection but never sends any response — a genuinely hung
# or infinitely-queued endpoint. 300 s covers the worst cold-start latency while
# still bounding a truly stale session.
PROBE_TIMEOUT = int(os.environ.get("PROBE_TIMEOUT", "300"))


def log(msg: str) -> None:
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n"
    sys.stderr.write(line)
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOG_FILE.open("a") as f:
        f.write(line)


def load_api_key() -> str:
    key = json.loads(CREDENTIALS.read_text()).get("NVIDIA_API_KEY")
    if not key:
        raise SystemExit("NVIDIA_API_KEY missing from credentials.json")
    return key


def http_request(method: str, url: str, api_key: str, body: dict | None = None) -> tuple[int, object]:
    data = json.dumps(body).encode() if body is not None else None
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
    }
    if data:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=PROBE_TIMEOUT) as resp:
            payload = resp.read().decode("utf-8", "replace")
            try:
                return resp.status, json.loads(payload)
            except json.JSONDecodeError:
                return resp.status, {"_raw": payload[:500]}
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode("utf-8", "replace"))
        except Exception:
            payload = {"_raw": "<unparseable error body>"}
        return e.code, payload
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return 0, {"_error": str(e)}


def list_models(api_key: str) -> list[str]:
    code, body = http_request("GET", f"{UPSTREAM}/v1/models", api_key)
    if code != 200 or not isinstance(body, dict):
        raise SystemExit(f"upstream /v1/models failed: HTTP {code} {body}")
    return sorted({m["id"] for m in body.get("data", []) if isinstance(m, dict) and m.get("id")})


def curated_base_ids() -> set[str]:
    # base_model_id from active curated rows in webui.db.model. Probing these
    # in addition to NVIDIA's catalog catches "vanished" models: deprecated IDs
    # that no longer appear in /v1/models but are still seeded in the picker.
    # Filter to `provider/name` shape — bare IDs like "chad" belong to local
    # shims (chad-shim) routed via a different base URL and must not be probed
    # against NVIDIA.
    if not WEBUI_DB.exists():
        return set()
    con = sqlite3.connect(str(WEBUI_DB), timeout=30)
    try:
        rows = con.execute(
            "SELECT DISTINCT base_model_id FROM model "
            "WHERE base_model_id IS NOT NULL AND base_model_id != '' AND is_active = 1"
        ).fetchall()
        return {r[0] for r in rows if r[0] and "/" in r[0]}
    finally:
        con.close()


def probe(model_id: str, api_key: str) -> tuple[str, str, float, int]:
    """Returns (verdict, detail, latency_ms, http_code) where verdict is one of:
      live      — 200 OK + first streaming token received
      dead      — 410 Gone (NVIDIA's explicit EOL signal); mark dead instantly
      transient — network/timeout (HTTP 0); keep previous status, don't strike
      fail      — anything else (404, 403, 5xx, etc.); ticks consecutive_failures

    Uses stream=True so latency_ms reflects time-to-first-token, not round-trip
    for a complete response. We close the connection immediately after the first
    chunk — we only care that the model is alive and generating, not the content.
    """
    t0 = time.monotonic()
    data = json.dumps({
        "model": model_id,
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 1,
        "stream": True,
    }).encode()
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Accept": "text/event-stream",
        "Content-Type": "application/json",
    }
    req = urllib.request.Request(
        f"{UPSTREAM}/v1/chat/completions", data=data, method="POST", headers=headers
    )
    try:
        with urllib.request.urlopen(req, timeout=PROBE_TIMEOUT) as resp:
            # Read until we see the first non-empty SSE data line — that confirms
            # the model is alive and generating. Bail immediately after.
            code = resp.status
            if code == 200:
                for raw in resp:
                    line = raw.decode("utf-8", "replace").strip()
                    if line.startswith("data:") and line != "data: [DONE]":
                        break
                latency_ms = (time.monotonic() - t0) * 1000
                return "live", "ok", latency_ms, code
            # Non-200 from urlopen shouldn't happen (raises HTTPError), but handle it.
            latency_ms = (time.monotonic() - t0) * 1000
            return "fail", f"HTTP {code}", latency_ms, code
    except urllib.error.HTTPError as e:
        latency_ms = (time.monotonic() - t0) * 1000
        try:
            payload = json.loads(e.read().decode("utf-8", "replace"))
        except Exception:
            payload = {"_raw": "<unparseable error body>"}
        detail = json.dumps(payload)[:240]
        if e.code == 410:
            return "dead", f"HTTP 410 Gone: {detail}", latency_ms, e.code
        if e.code == 429 or e.code >= 500:
            # Rate limits and server-side hiccups are NOT evidence the model is
            # gone. Treat as transient so they don't tick the failure counter
            # and can't promote a healthy model to dead.
            return "transient", f"HTTP {e.code}: {detail}", latency_ms, e.code
        return "fail", f"HTTP {e.code}: {detail}", latency_ms, e.code
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        latency_ms = (time.monotonic() - t0) * 1000
        return "transient", f"HTTP 0: {e}", latency_ms, 0


def load_curation() -> dict:
    if not CURATION_FILE.exists():
        return {"per_provider_limit": 1, "exclude": [], "ranking": {}}
    return tomllib.loads(CURATION_FILE.read_text())


_VERSION_DOTTED = re.compile(r"(\d+)\.(\d+)")
# Explicit release-tag: -v1, -v1.5, -v2. Checked first to prevent base-model
# version numbers (e.g. "llama-3.3", "gemma-3n") from outranking larger models
# whose ids carry no such tag (e.g. nemotron-3-ultra-550b-a55b).
_VERSION_EXPLICIT = re.compile(r"-v(\d+)(?:\.(\d+))?(?:-|$|\b)")
# Standalone dash-separated generation number: "nemotron-3-ultra" → 3,
# "gemma-4-31b" → 4. Catches model families that don't use dotted notation.
_VERSION_DASH = re.compile(r"(?:^|-)(\d+)-")
_VERSION_FAMILY = re.compile(r"[a-z](\d+)(?:-|\b)")
_PARAMS = re.compile(r"(\d+)(?:x(\d+))?b\b", re.IGNORECASE)


def rank_key(model_id: str) -> tuple:
    """(major_version, params_b, lexical) — higher tuple wins. Parses from id
    because NVIDIA's `created` field is a static placeholder (1993).

    Priority: explicit -vN tag > dotted N.N > standalone -N- > letter+digit.
    """
    name = model_id.split("/", 1)[-1].lower()
    m = _VERSION_EXPLICIT.search(name)
    if m:
        version = (int(m.group(1)), int(m.group(2)) if m.group(2) else 0)
    else:
        m = _VERSION_DOTTED.search(name)
        if m:
            version = (int(m.group(1)), int(m.group(2)))
        else:
            m = _VERSION_DASH.search(name)
            if m:
                version = (int(m.group(1)), 0)
            else:
                m = _VERSION_FAMILY.search(name)
                version = (int(m.group(1)), 0) if m else (0, 0)
    params = 0
    for pm in _PARAMS.finditer(name):
        a = int(pm.group(1))
        b = int(pm.group(2)) if pm.group(2) else None
        val = a * b if b else a
        if val > params:
            params = val
    return (version, params, name)


def matches_glob(model_id: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatchcase(model_id, p) for p in patterns)


def compute_featured(live_ids: list[str], curation: dict) -> list[str]:
    limit = int(curation.get("per_provider_limit", 1) or 0)
    excludes = list(curation.get("exclude", []) or [])
    by_provider: dict[str, list[str]] = {}
    for mid in live_ids:
        if matches_glob(mid, excludes):
            continue
        provider = mid.split("/", 1)[0] if "/" in mid else "_"
        by_provider.setdefault(provider, []).append(mid)
    featured: list[str] = []
    for provider, ids in sorted(by_provider.items()):
        ids.sort(key=rank_key, reverse=True)
        featured.extend(ids[:limit] if limit > 0 else ids)
    return sorted(featured)


def load_previous() -> dict:
    if not LIVENESS_FILE.exists():
        return {}
    try:
        return json.loads(LIVENESS_FILE.read_text())
    except Exception:
        return {}


def write_atomic(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True))
    tmp.replace(path)


def disable_dead_curated_models(dead_ids: set[str]) -> int:
    # Curated rows in webui.db.model reference NVIDIA IDs via base_model_id.
    # When a base goes dead, route is broken — flip is_active=0 so the picker
    # hides it. Sticks around so it auto-reappears if NVIDIA re-enables it.
    if not dead_ids or not WEBUI_DB.exists():
        return 0
    con = sqlite3.connect(str(WEBUI_DB), timeout=30)
    try:
        placeholders = ",".join("?" for _ in dead_ids)
        cur = con.execute(
            f"UPDATE model SET is_active = 0, "
            f"updated_at = CAST(strftime('%s','now') AS INTEGER) "
            f"WHERE base_model_id IN ({placeholders}) AND is_active = 1",
            tuple(dead_ids),
        )
        con.commit()
        return cur.rowcount
    finally:
        con.close()


def main() -> None:
    api_key = load_api_key()
    log(f"sweep start — upstream={UPSTREAM}")
    catalog = list_models(api_key)
    curated = curated_base_ids()
    extras = sorted(curated - set(catalog))
    models = sorted(set(catalog) | curated)
    log(f"discovered {len(catalog)} upstream + {len(extras)} curated-only = {len(models)} total")

    prev = load_previous().get("models", {})
    now = int(time.time())
    new_state: dict[str, dict] = {}
    live_n = dead_n = unknown_n = 0

    for mid in models:
        verdict, detail, latency_ms, _code = probe(mid, api_key)
        prev_entry = prev.get(mid, {})
        if verdict == "live":
            status = "live"
            fails = 0
        elif verdict == "dead":
            status = "dead"
            fails = int(prev_entry.get("consecutive_failures", 0)) + 1
        elif verdict == "transient":
            # Don't tick failure counter on network blips; preserve previous status.
            status = prev_entry.get("status", "unknown")
            fails = int(prev_entry.get("consecutive_failures", 0))
        else:  # fail
            fails = int(prev_entry.get("consecutive_failures", 0)) + 1
            status = "dead" if fails >= DEAD_AFTER_FAILS else prev_entry.get("status", "unknown")
        new_state[mid] = {
            "status": status,
            "last_checked": now,
            "last_ok": now if verdict == "live" else prev_entry.get("last_ok"),
            "last_error": None if verdict == "live" else detail,
            "consecutive_failures": fails,
            "latency_ms": round(latency_ms, 1),
        }
        if status == "live":
            live_n += 1
        elif status == "dead":
            dead_n += 1
        else:
            unknown_n += 1

    curation = load_curation()
    live_ids = [mid for mid, m in new_state.items() if m["status"] == "live"]
    featured = compute_featured(live_ids, curation)
    log(f"curation: {len(featured)} featured from {len(live_ids)} live "
        f"(per_provider_limit={curation.get('per_provider_limit')}, "
        f"excludes={len(curation.get('exclude') or [])})")

    write_atomic(LIVENESS_FILE, {
        "last_sweep": now,
        "upstream": UPSTREAM,
        "dead_after_fails": DEAD_AFTER_FAILS,
        "curation_file": str(CURATION_FILE),
        "featured": featured,
        "models": new_state,
    })
    log(f"wrote {LIVENESS_FILE.name}: live={live_n} dead={dead_n} unknown={unknown_n} featured={len(featured)}")

    # Only disable rows after TWO consecutive sweeps agree the model is dead.
    # A single flaky probe pass (rate limits, transient 5xx, cold-start hangs)
    # must not silently remove models from the picker.
    dead_ids = {
        mid
        for mid, m in new_state.items()
        if m["status"] == "dead" and prev.get(mid, {}).get("status") == "dead"
    }
    disabled = disable_dead_curated_models(dead_ids)
    if disabled:
        log(f"disabled {disabled} curated rows (dead across 2 consecutive sweeps)")


if __name__ == "__main__":
    main()
