#!/usr/bin/env -S uv run --quiet --script
# SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# /// script
# requires-python = ">=3.9"
# dependencies = ["pyyaml"]
# ///
"""Strip dangling optional depends_on entries from a resolved compose file.

Why this exists
---------------
`docker compose --env-file .env config > resolved.yml` filters out services
that don't match the active COMPOSE_PROFILES, but leaves depends_on: entries
pointing at those filtered-out services. Compose's schema validator rejects
any depends_on target that isn't a defined service in the file — even when
the entry is `required: false` — so `docker compose --env-file <env> -f resolved.yml up -d`
aborts with:

    service "X" depends on undefined service "Y": invalid compose project

before any container starts. This script normalizes the generated artifact
by dropping only the dangling *optional* depends_on entries; required active
deps (kafka, redis, rtvi-vlm, sensor-ms, streamprocessing-ms, etc.) are
preserved. A dangling *required* dependency — or any dangling list-form entry,
which compose treats as required — is not something profile filtering should
ever produce; it signals a genuinely broken project, so the script reports it
and exits non-zero rather than silently dropping it and masking the breakage.

The script edits ONLY the generated resolved.yml — never the source compose
files. The dependencies are correctly marked optional in the source; profile
filtering is what creates the dangling references in the resolved artifact.

This MUST run after `docker compose ... config > resolved.yml` and before
`docker compose --env-file <env> -f resolved.yml up -d`. The vss-deploy-profile skill (SKILL.md Step 3d)
calls this as part of every deploy.

Usage
-----
    uv run skills/vss-deploy-profile/scripts/normalize_resolved_yml.py [path/to/resolved.yml]
        # default path: ./resolved.yml in CWD
        # PEP 723 inline metadata declares pyyaml; uv pulls it into an
        # ephemeral env on demand, so no `pip install` on the host is needed.

Exit codes
----------
    0   normalized successfully (or already clean)
    1   file not found / parse error
    2   a dangling depends_on entry is required (or list-form) — refusing to
        normalize, since dropping it would mask a broken deployment
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml


def normalize(path: Path) -> int:
    """Strip dangling *optional* depends_on entries in resolved compose at *path*.

    Only dict-form entries explicitly marked ``required: false`` whose target
    service is absent are removed — those are the dangling references profile
    filtering legitimately produces. A dangling target that is required (the
    ``required`` key defaults to true when omitted), or any dangling list-form
    entry (compose treats short-form deps as required), means the resolved file
    is genuinely broken; the script reports every such entry and exits non-zero
    without writing the file, rather than silently dropping a real dependency.

    Returns the number of entries removed.
    """
    try:
        with path.open() as f:
            doc = yaml.safe_load(f) or {}
    except FileNotFoundError:
        print(f"ERROR: {path} not found", file=sys.stderr)
        sys.exit(1)
    except yaml.YAMLError as e:
        print(f"ERROR: failed to parse {path}: {e}", file=sys.stderr)
        sys.exit(1)

    services = doc.get("services") or {}
    defined = set(services.keys())

    removed: list[tuple[str, str]] = []
    errors: list[tuple[str, str, str]] = []  # (service, target, reason)

    for name, svc in services.items():
        if not isinstance(svc, dict):
            continue
        deps = svc.get("depends_on")
        if not deps:
            continue

        if isinstance(deps, dict):
            kept: dict = {}
            for k, v in deps.items():
                if k in defined:
                    kept[k] = v
                    continue
                # Dangling target. Drop it only when explicitly optional;
                # `required` defaults to true, so a missing key means required.
                is_optional = isinstance(v, dict) and v.get("required") is False
                if is_optional:
                    removed.append((name, k))
                else:
                    errors.append((name, k, "required dependency missing from resolved file"))
                    kept[k] = v  # preserve until we bail, so the doc stays intact
            if kept:
                svc["depends_on"] = kept
            else:
                svc.pop("depends_on", None)
        elif isinstance(deps, list):
            kept_list: list = []
            for k in deps:
                if k in defined:
                    kept_list.append(k)
                    continue
                # List-form (short syntax) deps are implicitly required.
                errors.append((name, k, "required list-form dependency missing from resolved file"))
                kept_list.append(k)
            if kept_list:
                svc["depends_on"] = kept_list
            else:
                svc.pop("depends_on", None)

    if errors:
        print(
            f"ERROR: {path} has {len(errors)} dangling REQUIRED depends_on "
            f"entr{'y' if len(errors) == 1 else 'ies'}; refusing to normalize "
            f"(dropping these would mask a broken deployment):",
            file=sys.stderr,
        )
        for svc_name, target, reason in errors:
            print(f"  - {svc_name} -> {target}: {reason}", file=sys.stderr)
        sys.exit(2)

    if removed:
        with path.open("w") as f:
            yaml.safe_dump(doc, f, sort_keys=False)
        print(f"Normalized {path}: dropped {len(removed)} dangling optional depends_on entries:")
        for svc_name, target in removed:
            print(f"  - {svc_name} -> {target}")
    else:
        print(f"{path} already clean (0 dangling optional depends_on entries)")

    return len(removed)


def main() -> None:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("resolved.yml")
    normalize(path)


if __name__ == "__main__":
    main()
