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

This script mirrors the routing keys (``model``, ``custom_providers``, and the
informational ``_nemoclaw_upstream``) plus the exact native Tavily backend from
the gateway config into the dashboard config, preserving every other
dashboard-local key. It also copies only the
dashboard-needed dotenv keys (local API server context and managed-tool gateway
URLs) into the dashboard ``HERMES_HOME`` when paths are supplied, because Hermes
0.16 moved parts of dashboard chat/model setup behind dotenv loading.
``custom_providers`` carries ``discover_models: true`` so the dashboard live-lists
``/v1/models`` from the proxied endpoint rather than pinning a static catalog.
It is idempotent: ``start.sh`` runs it on every launch so the dashboard stays in
sync with the gateway's routed model.

Source-boundary note: this is a local compatibility bridge for the invalid state
where Hermes 0.16+ dashboard code uses an isolated ``HERMES_HOME`` and therefore
cannot see NemoClaw's gateway-owned routing config. Remove it when Hermes exposes
one authoritative dashboard/gateway routing source or accepts the gateway config
directly; until then, every source read must be descriptor-based and no-follow
because the root entrypoint may invoke this helper over sandbox-writable paths.

Usage:
    seed-dashboard-config.py <gateway-config.yaml> <dashboard-config.yaml>
    seed-dashboard-config.py <gateway-config.yaml> <dashboard-config.yaml> <gateway.env> <dashboard.env>

Exits 0 on success or benign no-op (missing gateway config, no routing to copy).
Exits 1 only on an unexpected write failure. Emits ``[dashboard]`` lines on stderr
to match the rest of the gateway startup contract.
"""

from __future__ import annotations

import errno
import grp
import os
import pwd
import re
import stat
import sys
from typing import Callable, TextIO

# Keys mirrored from the gateway config into the dashboard config. Intentionally
# excludes platforms/plugins/messaging: the dashboard binds its own ports and
# must not inherit the gateway's api_server bind (port conflict) or channels.
_ROUTING_KEYS = ("model", "custom_providers", "_nemoclaw_upstream")
_DASHBOARD_ENV_ALLOWED_KEYS = frozenset(
    {
        # Local API server context needed by dashboard chat/model calls.
        "API_SERVER_HOST",
        "API_SERVER_PORT",
        "API_SERVER_KEY",
        # This is a resolver placeholder, not a provider credential. It must
        # remain exact so the dashboard cannot use this mirror to carry a raw
        # Tavily key across the gateway/dashboard privilege boundary.
        "TAVILY_API_KEY",
        # Managed tool gateway broker URLs needed by dashboard-launched Hermes
        # code paths. Do not copy messaging/provider/user credentials across
        # this boundary; those stay in the gateway-owned .env.
        "NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER",
        "FIRECRAWL_GATEWAY_URL",
        "OPENAI_AUDIO_GATEWAY_URL",
        "BROWSER_USE_GATEWAY_URL",
        "FAL_QUEUE_GATEWAY_URL",
        "MODAL_GATEWAY_URL",
    }
)
API_SERVER_KEY_RE = re.compile(r"^[0-9a-f]{64}$")
TAVILY_API_KEY_PLACEHOLDER = "openshell:resolve:env:TAVILY_API_KEY"


class UnsafeDashboardSeedPathError(Exception):
    pass


class MissingDashboardSeedPathError(Exception):
    pass


def _lookup_uid(value: str) -> int:
    return int(value) if value.isdigit() else pwd.getpwnam(value).pw_uid


def _lookup_gid(value: str) -> int:
    return int(value) if value.isdigit() else grp.getgrnam(value).gr_gid


def _is_generated_api_server_key(value: str) -> bool:
    candidate = value.strip()
    if len(candidate) >= 2 and candidate[0] == candidate[-1] and candidate[0] in ("'", '"'):
        candidate = candidate[1:-1]
    return API_SERVER_KEY_RE.fullmatch(candidate) is not None


def _seed_owner_ids() -> tuple[int, int] | None:
    owner = os.environ.get("NEMOCLAW_DASHBOARD_SEED_OWNER", "").strip()
    if not owner:
        return None
    user, separator, group = owner.partition(":")
    uid = _lookup_uid(user)
    gid = _lookup_gid(group) if separator else -1
    return uid, gid


def _read_regular_text_no_follow(path: str, label: str) -> str:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = -1
    try:
        fd = os.open(path, flags)
        file_stat = os.fstat(fd)
        if not stat.S_ISREG(file_stat.st_mode):
            raise UnsafeDashboardSeedPathError(f"{label} {path} is not a regular file")
        with os.fdopen(fd, "r", encoding="utf-8", closefd=False) as handle:
            return handle.read()
    except FileNotFoundError as exc:
        raise MissingDashboardSeedPathError(path) from exc
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise UnsafeDashboardSeedPathError(f"{label} {path} is a symlink") from exc
        raise
    finally:
        if fd >= 0:
            try:
                os.close(fd)
            except OSError:
                # The descriptor is cleanup-only here; preserve the original
                # read error, if any, instead of failing startup on close.
                pass


def _load_yaml(path: str, label: str) -> dict:
    import yaml

    data = yaml.safe_load(_read_regular_text_no_follow(path, label))
    return data if isinstance(data, dict) else {}


def _atomic_write_no_follow(dst: str, label: str, writer: Callable[[TextIO], None]) -> bool:
    tmp = f"{dst}.nemoclaw.tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    for flag_name in ("O_CLOEXEC", "O_NOFOLLOW"):
        flags |= getattr(os, flag_name, 0)

    owner_ids = _seed_owner_ids()
    fd = -1
    created = False
    try:
        fd = os.open(tmp, flags, 0o600)
        created = True
        with os.fdopen(fd, "w", encoding="utf-8", closefd=False) as handle:
            writer(handle)
            handle.flush()
        if owner_ids is not None:
            os.fchown(fd, owner_ids[0], owner_ids[1])
        os.fchmod(fd, 0o600)
        os.close(fd)
        fd = -1
        os.replace(tmp, dst)
        created = False
        return True
    except FileExistsError:
        print(
            f"[SECURITY] Refusing to seed {label} because temp path {tmp} already exists",
            file=sys.stderr,
        )
        return False
    except OSError as exc:
        prefix = "[SECURITY]" if exc.errno in (errno.ELOOP, errno.EEXIST) else "[dashboard]"
        print(f"{prefix} failed to seed {label} into {dst} ({exc})", file=sys.stderr)
        return False
    except Exception as exc:
        print(f"[dashboard] failed to seed {label} into {dst} ({exc})", file=sys.stderr)
        return False
    finally:
        if fd >= 0:
            try:
                os.close(fd)
            except OSError:
                # Cleanup close failures are non-fatal and must not mask the
                # earlier seed result.
                pass
        if created:
            try:
                os.unlink(tmp)
            except OSError:
                # Best-effort temp cleanup after a failed atomic write; the
                # caller already gets the seed failure above.
                pass


def _provider_key(raw: object, fallback: str = "nemoclaw-inference") -> str:
    value = str(raw or "").strip()
    if not value:
        value = fallback
    key = value.lower().replace(" ", "-").replace("(", "").replace(")", "")
    while "--" in key:
        key = key.replace("--", "-")
    return key.strip("-") or fallback


def _route_model_name(gateway: dict) -> str:
    model = gateway.get("model")
    if isinstance(model, dict):
        for key in ("default", "model", "name"):
            value = model.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    if isinstance(model, str) and model.strip():
        return model.strip()
    upstream = gateway.get("_nemoclaw_upstream")
    if isinstance(upstream, dict):
        value = upstream.get("model")
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _route_provider_name(gateway: dict) -> str:
    upstream = gateway.get("_nemoclaw_upstream")
    if isinstance(upstream, dict):
        value = upstream.get("provider")
        if isinstance(value, str) and value.strip():
            return value.strip()
    model = gateway.get("model")
    if isinstance(model, dict):
        value = model.get("provider")
        if isinstance(value, str) and value.strip() and value.strip().lower() != "custom":
            return value.strip()
    custom_providers = gateway.get("custom_providers")
    if isinstance(custom_providers, list):
        for entry in custom_providers:
            if isinstance(entry, dict):
                value = entry.get("name")
                if isinstance(value, str) and value.strip():
                    return value.strip()
    providers = gateway.get("providers")
    if isinstance(providers, dict) and providers:
        return str(next(iter(providers.keys())))
    return "nemoclaw-inference"


def _route_base_url(gateway: dict) -> str:
    model = gateway.get("model")
    if isinstance(model, dict):
        value = model.get("base_url")
        if isinstance(value, str) and value.strip():
            return value.strip()
    custom_providers = gateway.get("custom_providers")
    if isinstance(custom_providers, list):
        for entry in custom_providers:
            if isinstance(entry, dict):
                value = entry.get("base_url") or entry.get("api") or entry.get("url")
                if isinstance(value, str) and value.strip():
                    return value.strip()
    providers = gateway.get("providers")
    if isinstance(providers, dict):
        for entry in providers.values():
            if isinstance(entry, dict):
                value = entry.get("api") or entry.get("base_url") or entry.get("url")
                if isinstance(value, str) and value.strip():
                    return value.strip()
    return ""


def _route_api_key(gateway: dict) -> str:
    model = gateway.get("model")
    if isinstance(model, dict):
        value = model.get("api_key")
        if isinstance(value, str) and value.strip():
            return value.strip()
    custom_providers = gateway.get("custom_providers")
    if isinstance(custom_providers, list):
        for entry in custom_providers:
            if isinstance(entry, dict):
                value = entry.get("api_key")
                if isinstance(value, str) and value.strip():
                    return value.strip()
    providers = gateway.get("providers")
    if isinstance(providers, dict):
        for entry in providers.values():
            if isinstance(entry, dict):
                value = entry.get("api_key")
                if isinstance(value, str) and value.strip():
                    return value.strip()
    return "sk-OPENSHELL-PROXY-REWRITE"


def _route_api_mode(gateway: dict) -> str:
    model = gateway.get("model")
    if isinstance(model, dict):
        value = model.get("api_mode")
        if isinstance(value, str) and value.strip():
            return value.strip()
    custom_providers = gateway.get("custom_providers")
    if isinstance(custom_providers, list):
        for entry in custom_providers:
            if isinstance(entry, dict):
                value = entry.get("api_mode") or entry.get("transport")
                if isinstance(value, str) and value.strip():
                    return value.strip()
    return ""


def _normalized_routing(gateway: dict) -> dict:
    routing = {key: gateway[key] for key in _ROUTING_KEYS if key in gateway}
    web = gateway.get("web")
    if isinstance(web, dict) and web.get("backend") == "tavily":
        # The backend selector is non-secret and must match the resolver-only
        # TAVILY_API_KEY mirrored into the dashboard dotenv. Copy no other web
        # settings across this privilege boundary.
        routing["web"] = {"backend": "tavily"}
    provider_name = _route_provider_name(gateway)
    provider_key = _provider_key(provider_name)
    model_name = _route_model_name(gateway)
    base_url = _route_base_url(gateway)
    api_key = _route_api_key(gateway)
    api_mode = _route_api_mode(gateway)

    if model_name and base_url:
        model = dict(routing.get("model") if isinstance(routing.get("model"), dict) else {})
        model.update(
            {
                "default": model_name,
                "provider": provider_key,
                "base_url": base_url,
                "api_key": api_key,
            }
        )
        if api_mode:
            model["api_mode"] = api_mode
        routing["model"] = model

        provider_entry: dict = {
            "name": provider_name,
            "api": base_url,
            "api_key": api_key,
            "default_model": model_name,
            "discover_models": True,
        }
        if api_mode:
            provider_entry["transport"] = api_mode
        providers = dict(gateway.get("providers") if isinstance(gateway.get("providers"), dict) else {})
        providers[provider_key] = provider_entry
        routing["providers"] = providers

        if "custom_providers" not in routing:
            custom_provider: dict = {
                "name": provider_name,
                "base_url": base_url,
                "api_key": api_key,
                "discover_models": True,
            }
            if api_mode:
                custom_provider["api_mode"] = api_mode
            routing["custom_providers"] = [custom_provider]

    return routing


def _mirror_env(src: str, dst: str) -> bool:
    try:
        env_text = _read_regular_text_no_follow(src, "gateway env")
    except MissingDashboardSeedPathError:
        print(f"[dashboard] gateway env {src} missing; skipping env seed", file=sys.stderr)
        return True
    except UnsafeDashboardSeedPathError as exc:
        print(f"[SECURITY] Refusing to seed dashboard env because {exc}", file=sys.stderr)
        return False
    except OSError as exc:
        print(f"[dashboard] gateway env {src} unreadable ({exc}); skipping env seed", file=sys.stderr)
        return True

    if os.path.islink(dst):
        print(f"[SECURITY] Refusing to seed dashboard env because {dst} is a symlink", file=sys.stderr)
        return False

    def parse_env_assignment(line: str) -> tuple[str, str] | None:
        candidate = line.lstrip()
        if candidate.startswith("export "):
            candidate = candidate[len("export ") :].lstrip()
        if "=" not in candidate:
            return None
        key, value = candidate.split("=", 1)
        return key.strip(), value.strip()

    mirrored_lines: list[str] = []
    for line in env_text.splitlines(keepends=True):
        parsed = parse_env_assignment(line)
        if parsed is None:
            continue
        key, value = parsed
        if key not in _DASHBOARD_ENV_ALLOWED_KEYS:
            continue
        if key == "API_SERVER_KEY" and not _is_generated_api_server_key(value):
            print(
                "[SECURITY] Refusing to seed dashboard env because API_SERVER_KEY "
                "does not match the generated-token contract",
                file=sys.stderr,
            )
            return False
        if key == "TAVILY_API_KEY" and value != TAVILY_API_KEY_PLACEHOLDER:
            print(
                "[SECURITY] Refusing to seed dashboard env because TAVILY_API_KEY "
                "is not the canonical OpenShell resolver placeholder",
                file=sys.stderr,
            )
            return False
        mirrored_lines.append(line)

    def write_env(dst_handle: TextIO) -> None:
        for line in mirrored_lines:
            dst_handle.write(line)

    if not _atomic_write_no_follow(dst, "dashboard env", write_env):
        return False

    print(f"[dashboard] seeded env into {dst}", file=sys.stderr)
    return True


def main(argv: list[str]) -> int:
    if len(argv) not in (3, 5):
        print(
            "[dashboard] usage: seed-dashboard-config.py "
            "<gateway-config.yaml> <dashboard-config.yaml> [<gateway.env> <dashboard.env>]",
            file=sys.stderr,
        )
        return 1

    src, dst = argv[1], argv[2]
    env_ok = True
    if len(argv) == 5:
        env_ok = _mirror_env(argv[3], argv[4])

    try:
        import yaml  # noqa: F401  (import here so a missing PyYAML is a clean skip)
    except Exception as exc:  # pragma: no cover - PyYAML ships in the Hermes venv
        print(f"[dashboard] PyYAML unavailable ({exc}); skipping model seed", file=sys.stderr)
        return 0 if env_ok else 1

    try:
        gateway = _load_yaml(src, "gateway config")
    except MissingDashboardSeedPathError:
        # Cold paths where the gateway config has not been written yet are not an
        # error: there is simply nothing to mirror.
        print(f"[dashboard] gateway config {src} missing; skipping model seed", file=sys.stderr)
        return 0 if env_ok else 1
    except UnsafeDashboardSeedPathError as exc:
        print(f"[SECURITY] Refusing to seed dashboard config because {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"[dashboard] gateway config {src} unreadable ({exc}); skipping model seed", file=sys.stderr)
        return 0 if env_ok else 1

    routing = _normalized_routing(gateway)
    if not routing.get("model") and not routing.get("custom_providers") and not routing.get("providers"):
        print("[dashboard] gateway config has no model routing; nothing to seed", file=sys.stderr)
        return 0 if env_ok else 1

    dashboard: dict = {}
    try:
        dashboard = _load_yaml(dst, "existing dashboard config")
    except MissingDashboardSeedPathError:
        dashboard = {}
    except UnsafeDashboardSeedPathError as exc:
        print(f"[SECURITY] Refusing to seed dashboard config because {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        # A corrupt dashboard config is owned by Hermes and is regenerated on
        # launch; recreate from the routing keys rather than abort startup.
        print(
            f"[dashboard] existing dashboard config {dst} unreadable ({exc}); recreating",
            file=sys.stderr,
        )
        dashboard = {}

    # The seeder owns only web.backend. Merge or remove that field while
    # preserving unrelated dashboard-local web settings.
    managed_web = routing.pop("web", None)
    dashboard_web = dict(dashboard.get("web") if isinstance(dashboard.get("web"), dict) else {})
    if isinstance(managed_web, dict) and managed_web.get("backend") == "tavily":
        dashboard_web["backend"] = "tavily"
    elif dashboard_web.get("backend") == "tavily":
        dashboard_web.pop("backend", None)
    if dashboard_web:
        dashboard["web"] = dashboard_web
    else:
        dashboard.pop("web", None)
    dashboard.update(routing)

    import yaml

    def write_dashboard(handle: TextIO) -> None:
        yaml.safe_dump(dashboard, handle, sort_keys=False)

    if not _atomic_write_no_follow(dst, "dashboard config", write_dashboard):
        return 1

    print(f"[dashboard] seeded model routing into {dst}", file=sys.stderr)
    return 0 if env_ok else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
