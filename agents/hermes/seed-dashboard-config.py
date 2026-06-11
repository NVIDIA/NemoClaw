#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Seed the Hermes dashboard's isolated config with the gateway's model routing.

The Hermes dashboard runs under its own ``HERMES_HOME`` (``HERMES_DASHBOARD_HOME``
in ``start.sh``) for privilege separation from the gateway user, so it never sees
the ``model:`` / ``custom_providers:`` block NemoClaw writes to the gateway's
``config.yaml``. Without those keys in the dashboard's own ``config.yaml`` two
things break (verified live):

* the dashboard Models page (``GET /api/model/options`` →
  ``hermes_cli.inventory.build_models_payload``) lists **no** providers, because
  the picker enumerates only ``custom_providers:`` / ``providers:`` — never the
  inline ``model:`` block; and
* the kanban specifier/decomposer (``agent.auxiliary_client``
  ``get_text_auxiliary_client``) resolve **no** client, because ``model.provider``
  / ``model.base_url`` are empty so the auto-detect chain finds nothing.

This script mirrors only the routing keys (``model``, ``custom_providers``, and
the informational ``_nemoclaw_upstream``) from the gateway config into the
dashboard config, preserving every other dashboard-local key. ``custom_providers``
carries ``discover_models: true`` so the dashboard live-lists ``/v1/models`` from
the proxied endpoint rather than pinning a static catalog. It is idempotent:
``start.sh`` runs it on every launch so the dashboard stays in sync with the
gateway's routed model.

Usage:
    seed-dashboard-config.py <gateway-config.yaml> <dashboard-config.yaml>

Exits 0 on success or benign no-op (missing gateway config, no routing to copy).
Exits 1 only on an unexpected write failure. Emits ``[dashboard]`` lines on stderr
to match the rest of the gateway startup contract.
"""

from __future__ import annotations

import os
import sys

# Keys mirrored from the gateway config into the dashboard config. Intentionally
# excludes platforms/plugins/messaging: the dashboard binds its own ports and
# must not inherit the gateway's api_server bind (port conflict) or channels.
_ROUTING_KEYS = ("model", "custom_providers", "_nemoclaw_upstream")


def _load_yaml(path: str) -> dict:
    import yaml

    with open(path, encoding="utf-8") as handle:
        data = yaml.safe_load(handle)
    return data if isinstance(data, dict) else {}


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(
            "[dashboard] usage: seed-dashboard-config.py "
            "<gateway-config.yaml> <dashboard-config.yaml>",
            file=sys.stderr,
        )
        return 1

    src, dst = argv[1], argv[2]

    if not os.path.isfile(src):
        # Cold paths where the gateway config has not been written yet are not an
        # error: there is simply nothing to mirror.
        print(f"[dashboard] gateway config {src} missing; skipping model seed", file=sys.stderr)
        return 0

    if os.path.islink(dst):
        # Defence-in-depth: never follow a symlink planted at the dashboard config
        # path (HERMES_DASHBOARD_HOME is sandbox-writable).
        print(f"[SECURITY] Refusing to seed dashboard config because {dst} is a symlink", file=sys.stderr)
        return 1

    try:
        import yaml  # noqa: F401  (import here so a missing PyYAML is a clean skip)
    except Exception as exc:  # pragma: no cover - PyYAML ships in the Hermes venv
        print(f"[dashboard] PyYAML unavailable ({exc}); skipping model seed", file=sys.stderr)
        return 0

    try:
        gateway = _load_yaml(src)
    except Exception as exc:
        print(f"[dashboard] gateway config {src} unreadable ({exc}); skipping model seed", file=sys.stderr)
        return 0

    routing = {key: gateway[key] for key in _ROUTING_KEYS if key in gateway}
    if not routing.get("model") and not routing.get("custom_providers"):
        print("[dashboard] gateway config has no model routing; nothing to seed", file=sys.stderr)
        return 0

    dashboard: dict = {}
    if os.path.exists(dst):
        try:
            dashboard = _load_yaml(dst)
        except Exception as exc:
            # A corrupt dashboard config is owned by Hermes and is regenerated on
            # launch; recreate from the routing keys rather than abort startup.
            print(
                f"[dashboard] existing dashboard config {dst} unreadable ({exc}); recreating",
                file=sys.stderr,
            )
            dashboard = {}

    dashboard.update(routing)

    import yaml

    tmp = f"{dst}.nemoclaw.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as handle:
            yaml.safe_dump(dashboard, handle, sort_keys=False)
        os.replace(tmp, dst)
    except Exception as exc:
        print(f"[dashboard] failed to seed model routing into {dst} ({exc})", file=sys.stderr)
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return 1

    print(f"[dashboard] seeded model routing into {dst}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
