#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Seed the Hermes dashboard's isolated config from the gateway-owned config.

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

This script mirrors the routing keys, managed dashboard policy, and reviewed
dotenv keys declared by NemoClaw's versioned policy manifest. It preserves
dashboard-local keys outside that policy boundary.
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
    seed-dashboard-config.py <managed-policy.json> <gateway-config.yaml> <dashboard-config.yaml>
    seed-dashboard-config.py <managed-policy.json> <gateway-config.yaml> <dashboard-config.yaml> <gateway.env> <dashboard.env>

Exits 0 on success or a benign no-op for a missing gateway config.
Exits 1 when an existing config is invalid or unreadable, routing is absent, a
reviewed policy is invalid, or a write fails. Emits ``[dashboard]`` lines on
stderr to match the rest of the gateway startup contract.
"""

from __future__ import annotations

import errno
import grp
import os
import pwd
import stat
import sys
from copy import deepcopy
from pathlib import Path
from typing import Callable, TextIO

sys.path.insert(0, str(Path(__file__).resolve().parent))

from managed_policy import (  # noqa: E402
    ManagedPolicyError,
    load_managed_policy,
    policy_value,
)

class UnsafeDashboardSeedPathError(Exception):
    pass


class MissingDashboardSeedPathError(Exception):
    pass


class InvalidDashboardSeedDocumentError(Exception):
    pass


def _lookup_uid(value: str) -> int:
    return int(value) if value.isdigit() else pwd.getpwnam(value).pw_uid


def _lookup_gid(value: str) -> int:
    return int(value) if value.isdigit() else grp.getgrnam(value).gr_gid


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

    try:
        data = yaml.safe_load(_read_regular_text_no_follow(path, label))
    except yaml.YAMLError as exc:
        raise InvalidDashboardSeedDocumentError(f"{label} is malformed") from exc
    if not isinstance(data, dict):
        raise InvalidDashboardSeedDocumentError(f"{label} must be a mapping")
    return data


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


def _normalized_routing(gateway: dict, routing_keys: list[str], policy: dict) -> dict:
    if any(key not in gateway for key in routing_keys):
        raise InvalidDashboardSeedDocumentError("gateway config has incomplete model routing")
    routing = {key: deepcopy(gateway[key]) for key in routing_keys}
    upstream = routing.get("_nemoclaw_upstream")
    model = routing.get("model")
    providers = routing.get("providers")
    custom_providers = routing.get("custom_providers")
    if not isinstance(upstream, dict) or not isinstance(model, dict):
        raise InvalidDashboardSeedDocumentError("gateway config has invalid model routing")
    provider_key = upstream.get("provider_key")
    if (
        not isinstance(provider_key, str)
        or not provider_key
        or not isinstance(model.get("default"), str)
        or not model.get("default")
        or not isinstance(model.get("base_url"), str)
        or not model.get("base_url")
        or not isinstance(providers, dict)
        or not isinstance(providers.get(provider_key), dict)
        or not isinstance(custom_providers, list)
        or not custom_providers
    ):
        raise InvalidDashboardSeedDocumentError("gateway config has invalid model routing")
    expected_api_key = policy_value(policy["config"], "model.api_key")
    credential_bearing_routes = [model, *providers.values(), *custom_providers]
    if not isinstance(expected_api_key, str) or any(
        not isinstance(route, dict) or route.get("api_key") != expected_api_key
        for route in credential_bearing_routes
    ):
        raise InvalidDashboardSeedDocumentError(
            "gateway model routing contains a non-policy credential reference"
        )
    model["provider"] = provider_key
    return routing


def _managed_policy_sections(gateway: dict, policy: dict) -> dict:
    config = policy["config"]
    section_names = {path.split(".", 1)[0] for path in policy["managed_paths"]}
    for section_name in section_names:
        if not _same_json_value(gateway.get(section_name), config.get(section_name)):
            raise InvalidDashboardSeedDocumentError("gateway policy does not match managed policy")

    sections: dict = {}
    for dotted_path in policy["managed_paths"]:
        expected = policy_value(config, dotted_path)
        _set_policy_value(sections, dotted_path, deepcopy(expected))
    expected_web = policy["config"].get("web")
    gateway_web = gateway.get("web")
    if expected_web is None:
        if isinstance(gateway_web, dict) and "backend" in gateway_web:
            raise InvalidDashboardSeedDocumentError("gateway policy does not match managed policy")
    elif not isinstance(expected_web, dict) or not isinstance(gateway_web, dict):
        raise InvalidDashboardSeedDocumentError("gateway policy does not match managed policy")
    elif any(not _same_json_value(gateway_web.get(key), value) for key, value in expected_web.items()):
        raise InvalidDashboardSeedDocumentError("gateway policy does not match managed policy")
    return sections


def _set_policy_value(config: dict, dotted_path: str, value: object) -> None:
    segments = dotted_path.split(".")
    target = config
    for segment in segments[:-1]:
        child = target.setdefault(segment, {})
        if not isinstance(child, dict):
            raise InvalidDashboardSeedDocumentError("managed policy path overlaps a value")
        target = child
    target[segments[-1]] = value


def _same_json_value(actual: object, expected: object) -> bool:
    if type(actual) is not type(expected):
        return False
    if isinstance(expected, dict):
        return set(actual) == set(expected) and all(
            _same_json_value(actual[key], value) for key, value in expected.items()
        )
    if isinstance(expected, list):
        return len(actual) == len(expected) and all(
            _same_json_value(actual_item, expected_item)
            for actual_item, expected_item in zip(actual, expected)
        )
    return actual == expected


def _merge_policy(dashboard: dict, policy: dict) -> None:
    """Overwrite only reviewed policy leaves while preserving dashboard-local siblings."""
    for section_name, managed_values in policy.items():
        dashboard_values = dashboard.get(section_name)
        merged = dict(dashboard_values) if isinstance(dashboard_values, dict) else {}
        merged.update(managed_values)
        dashboard[section_name] = merged


def _mirror_env(src: str, dst: str, policy: dict) -> bool:
    try:
        env_text = _read_regular_text_no_follow(src, "gateway env")
    except MissingDashboardSeedPathError:
        print(f"[dashboard] gateway env {src} missing; skipping env seed", file=sys.stderr)
        return True
    except UnsafeDashboardSeedPathError as exc:
        print(f"[SECURITY] Refusing to seed dashboard env because {exc}", file=sys.stderr)
        return False
    except Exception:
        # Do not interpolate decoder or parser exceptions here: their context can
        # contain credential-bearing source text.
        print(
            "[SECURITY] Refusing to seed dashboard env because gateway env is invalid or unreadable",
            file=sys.stderr,
        )
        return False

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

    allowed_keys = frozenset(policy["dashboard"]["env_keys"])
    expected_values = {}
    for line in policy["env_lines"]:
        parsed = parse_env_assignment(line)
        if parsed is not None:
            expected_values[parsed[0]] = parsed[1]

    mirrored_lines: list[str] = []
    for line in env_text.splitlines(keepends=True):
        parsed = parse_env_assignment(line)
        if parsed is None:
            continue
        key, value = parsed
        if key not in allowed_keys:
            continue
        if key == "TAVILY_API_KEY" and value != expected_values.get(key):
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
    if len(argv) not in (4, 6):
        print(
            "[dashboard] usage: seed-dashboard-config.py "
            "<managed-policy.json> <gateway-config.yaml> <dashboard-config.yaml> "
            "[<gateway.env> <dashboard.env>]",
            file=sys.stderr,
        )
        return 1

    policy_path, src, dst = argv[1], argv[2], argv[3]

    try:
        import yaml  # noqa: F401
    except Exception:  # pragma: no cover - PyYAML ships in the Hermes venv
        print(
            "[SECURITY] Refusing to seed dashboard config because PyYAML is unavailable",
            file=sys.stderr,
        )
        return 1

    try:
        policy = load_managed_policy(Path(policy_path))
    except ManagedPolicyError:
        print(
            "[SECURITY] Refusing to seed dashboard config because managed policy is invalid or unreadable",
            file=sys.stderr,
        )
        return 1

    try:
        gateway = _load_yaml(src, "gateway config")
    except MissingDashboardSeedPathError:
        # Cold paths where the gateway config has not been written yet are not an
        # error: there is simply nothing to mirror.
        print(f"[dashboard] gateway config {src} missing; skipping model seed", file=sys.stderr)
        env_ok = True
        if len(argv) == 6:
            env_ok = _mirror_env(argv[4], argv[5], policy)
        return 0 if env_ok else 1
    except UnsafeDashboardSeedPathError as exc:
        print(f"[SECURITY] Refusing to seed dashboard config because {exc}", file=sys.stderr)
        return 1
    except Exception:
        # PyYAML includes the offending source line in parser exceptions. Never
        # echo that context because routing documents contain API-key fields.
        print(
            "[SECURITY] Refusing to seed dashboard config because gateway config is invalid or unreadable",
            file=sys.stderr,
        )
        return 1

    try:
        routing = _normalized_routing(gateway, policy["dashboard"]["routing_keys"], policy)
    except InvalidDashboardSeedDocumentError:
        print(
            "[SECURITY] Refusing to seed dashboard config because gateway config has invalid model routing",
            file=sys.stderr,
        )
        return 1
    try:
        policy_sections = _managed_policy_sections(gateway, policy)
    except InvalidDashboardSeedDocumentError:
        print(
            "[SECURITY] Refusing to seed dashboard config because gateway policy is invalid",
            file=sys.stderr,
        )
        return 1

    dashboard: dict = {}
    try:
        dashboard = _load_yaml(dst, "existing dashboard config")
    except MissingDashboardSeedPathError:
        dashboard = {}
    except UnsafeDashboardSeedPathError as exc:
        print(f"[SECURITY] Refusing to seed dashboard config because {exc}", file=sys.stderr)
        return 1
    except Exception:
        # Preserve the existing bytes and stop startup. Recreating from a
        # partially understood document could erase dashboard-owned policy.
        print(
            "[SECURITY] Refusing to seed dashboard config because existing dashboard "
            "config is invalid or unreadable",
            file=sys.stderr,
        )
        return 1

    # Validate both YAML documents before mirroring dotenv or replacing either
    # config. A malformed policy source must not partially update the dashboard
    # environment before startup refuses the config.
    if len(argv) == 6 and not _mirror_env(argv[4], argv[5], policy):
        return 1

    # The seeder owns only web.backend. Merge or remove that field while
    # preserving unrelated dashboard-local web settings.
    managed_web = policy["config"].get("web")
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
    _merge_policy(dashboard, policy_sections)

    import yaml

    def write_dashboard(handle: TextIO) -> None:
        yaml.safe_dump(dashboard, handle, sort_keys=False)

    if not _atomic_write_no_follow(dst, "dashboard config", write_dashboard):
        return 1

    print(f"[dashboard] seeded model routing and reviewed policy into {dst}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
