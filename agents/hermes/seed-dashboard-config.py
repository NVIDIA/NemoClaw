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

This script mirrors the routing keys (``model``, ``custom_providers``, and the
informational ``_nemoclaw_upstream``), the exact native Tavily backend, and a
tight allowlist of reviewed policy leaves from the gateway config into the
dashboard config, preserving every other dashboard-local key. It also copies only the
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
    seed-dashboard-config.py --merge-legacy <gateway-config.yaml> <dashboard-config.yaml>

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
import re
import stat
import sys
from typing import Callable, TextIO

# Keys mirrored from the gateway config into the dashboard config. Intentionally
# excludes platforms/plugins/messaging: the dashboard binds its own ports and
# must not inherit the gateway's api_server bind (port conflict) or channels.
_ROUTING_KEYS = ("model", "custom_providers", "_nemoclaw_upstream")
_APPROVAL_MODES = frozenset({"manual", "smart", "off"})
_SESSION_RESET_MODES = frozenset({"daily", "idle", "both", "none"})
_SESSION_RESET_KEYS = frozenset(
    {
        "mode",
        "at_hour",
        "idle_minutes",
        "notify",
        "notify_exclude_platforms",
        "bg_process_max_age_hours",
    }
)
_PRE_UPDATE_BACKUP_MODES = frozenset(
    {"off", "false", "none", "disabled", "quick", "full", "zip", "true"}
)
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


class InvalidDashboardPolicyError(Exception):
    pass


class InvalidDashboardSeedDocumentError(Exception):
    pass


def _open_directory_no_follow(path: str, *, dir_fd: int | None = None) -> int:
    """Open a directory without following its final path component."""

    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    flags |= getattr(os, "O_CLOEXEC", 0)
    return os.open(path, flags, dir_fd=dir_fd)


def _directory_is_empty_at(parent_fd: int, name: str) -> bool:
    """Return whether a child directory is empty without following symlinks."""

    fd = _open_directory_no_follow(name, dir_fd=parent_fd)
    try:
        return not os.listdir(fd)
    finally:
        os.close(fd)


def _rename_no_replace_at(src_fd: int, name: str, dst_fd: int) -> None:
    """Move one entry between anchored directories without replacing a peer."""

    import ctypes

    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None:
        raise OSError(errno.ENOSYS, "renameat2 is unavailable")
    renameat2.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    renameat2.restype = ctypes.c_int
    encoded = os.fsencode(name)
    if renameat2(src_fd, encoded, dst_fd, encoded, 1) != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number))


def _merge_legacy_profile(config_fd: int, profiles_fd: int, dashboard_home: str) -> bool:
    """Merge disjoint restored legacy entries into the canonical profile."""

    legacy_fd = -1
    dashboard_fd = -1
    try:
        legacy_fd = _open_directory_no_follow("dashboard-home", dir_fd=config_fd)
        dashboard_fd = _open_directory_no_follow("dashboard-home", dir_fd=profiles_fd)
        entries = sorted(os.listdir(legacy_fd))
        for name in entries:
            try:
                os.stat(name, dir_fd=dashboard_fd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            print(
                "[dashboard] Refusing to merge restored legacy and current dashboard "
                "profiles because an entry collides",
                file=sys.stderr,
            )
            return False

        moved: list[str] = []
        for name in entries:
            try:
                _rename_no_replace_at(legacy_fd, name, dashboard_fd)
                moved.append(name)
            except OSError as exc:
                rollback_failed = False
                for moved_name in reversed(moved):
                    try:
                        _rename_no_replace_at(dashboard_fd, moved_name, legacy_fd)
                    except OSError:
                        rollback_failed = True
                prefix = "[SECURITY]" if rollback_failed else "[dashboard]"
                print(
                    f"{prefix} failed to merge restored legacy dashboard profile ({exc})",
                    file=sys.stderr,
                )
                return False
        try:
            os.rmdir("dashboard-home", dir_fd=config_fd)
        except OSError as exc:
            rollback_failed = False
            for moved_name in reversed(moved):
                try:
                    _rename_no_replace_at(dashboard_fd, moved_name, legacy_fd)
                except OSError:
                    rollback_failed = True
            prefix = "[SECURITY]" if rollback_failed else "[dashboard]"
            print(
                f"{prefix} failed to finish restored legacy dashboard profile merge ({exc})",
                file=sys.stderr,
            )
            return False
        print(
            f"[dashboard] merged restored legacy dashboard profile into {dashboard_home}",
            file=sys.stderr,
        )
        return True
    except OSError as exc:
        print(
            f"[SECURITY] Refusing to merge restored legacy dashboard profile ({exc})",
            file=sys.stderr,
        )
        return False
    finally:
        if dashboard_fd >= 0:
            os.close(dashboard_fd)
        if legacy_fd >= 0:
            os.close(legacy_fd)

def _open_profile_parent(config_fd: int, path: str) -> int | None:
    """Create and securely open the canonical profile parent."""

    try:
        os.mkdir("profiles", 0o700, dir_fd=config_fd)
    except FileExistsError:
        # The no-follow open below validates the existing path before use.
        pass
    except OSError as exc:
        print(f"[dashboard] failed to create profile directory {path} ({exc})", file=sys.stderr)
        return None

    try:
        return _open_directory_no_follow("profiles", dir_fd=config_fd)
    except OSError as exc:
        print(
            f"[SECURITY] Refusing to migrate legacy dashboard profile because {path} "
            f"is not a safe directory ({exc})",
            file=sys.stderr,
        )
        return None


def _prepare_dashboard_destination(
    dst: str, *, merge_legacy: bool = False
) -> tuple[bool, int | None]:
    """Migrate and securely open the canonical dashboard profile when applicable."""

    dashboard_home = os.path.dirname(dst)
    profiles_dir = os.path.dirname(dashboard_home)
    config_dir = os.path.dirname(profiles_dir)
    if (
        os.path.basename(dst) != "config.yaml"
        or os.path.basename(dashboard_home) != "dashboard-home"
        or os.path.basename(profiles_dir) != "profiles"
    ):
        return True, None

    legacy_home = os.path.join(config_dir, "dashboard-home")
    try:
        config_fd = _open_directory_no_follow(config_dir)
    except OSError as exc:
        print(
            f"[SECURITY] Refusing to inspect dashboard profile root {config_dir} ({exc})",
            file=sys.stderr,
        )
        return False, None

    profiles_fd = -1
    try:
        try:
            legacy_stat = os.stat("dashboard-home", dir_fd=config_fd, follow_symlinks=False)
        except FileNotFoundError:
            legacy_stat = None
        if legacy_stat is not None and not stat.S_ISDIR(legacy_stat.st_mode):
            print(
                f"[SECURITY] Refusing to migrate legacy dashboard profile because {legacy_home} "
                "is not a safe directory",
                file=sys.stderr,
            )
            return False, None

        opened_profiles_fd = _open_profile_parent(config_fd, profiles_dir)
        if opened_profiles_fd is None:
            return False, None
        profiles_fd = opened_profiles_fd

        try:
            current_stat = os.stat("dashboard-home", dir_fd=profiles_fd, follow_symlinks=False)
        except FileNotFoundError:
            current_stat = None
        if legacy_stat is not None and current_stat is not None:
            if not stat.S_ISDIR(current_stat.st_mode):
                print(
                    f"[SECURITY] Refusing to migrate legacy dashboard profile because "
                    f"{dashboard_home} is not a safe directory",
                    file=sys.stderr,
                )
                return False, None
            try:
                destination_is_empty = _directory_is_empty_at(profiles_fd, "dashboard-home")
            except OSError as exc:
                print(
                    f"[SECURITY] Refusing to inspect dashboard profile {dashboard_home} ({exc})",
                    file=sys.stderr,
                )
                return False, None
            if not destination_is_empty:
                if not merge_legacy:
                    print(
                        "[dashboard] Refusing to merge legacy and current dashboard profiles; "
                        "move the legacy files manually before restarting",
                        file=sys.stderr,
                    )
                    return False, None
                if not _merge_legacy_profile(config_fd, profiles_fd, dashboard_home):
                    return False, None
                legacy_stat = None
                current_stat = os.stat(
                    "dashboard-home", dir_fd=profiles_fd, follow_symlinks=False
                )
                destination_is_empty = False
            if destination_is_empty:
                try:
                    os.rmdir("dashboard-home", dir_fd=profiles_fd)
                except OSError as exc:
                    print(
                        f"[SECURITY] Refusing to migrate legacy dashboard profile because "
                        f"{dashboard_home} changed unexpectedly ({exc})",
                        file=sys.stderr,
                    )
                    return False, None
                current_stat = None

        if legacy_stat is not None:
            try:
                _rename_no_replace_at(config_fd, "dashboard-home", profiles_fd)
            except OSError as exc:
                print(
                    f"[dashboard] failed to migrate legacy dashboard profile ({exc})",
                    file=sys.stderr,
                )
                return False, None
            print(
                f"[dashboard] migrated legacy dashboard profile to {dashboard_home}",
                file=sys.stderr,
            )
        elif current_stat is None:
            try:
                os.mkdir("dashboard-home", 0o700, dir_fd=profiles_fd)
            except OSError as exc:
                print(
                    f"[dashboard] failed to create dashboard profile {dashboard_home} ({exc})",
                    file=sys.stderr,
                )
                return False, None

        try:
            dashboard_fd = _open_directory_no_follow("dashboard-home", dir_fd=profiles_fd)
        except OSError as exc:
            print(
                f"[SECURITY] Refusing to open dashboard profile {dashboard_home} ({exc})",
                file=sys.stderr,
            )
            return False, None
        try:
            os.fchmod(dashboard_fd, 0o700)
        except OSError as exc:
            os.close(dashboard_fd)
            print(
                f"[SECURITY] Refusing to secure dashboard profile {dashboard_home} ({exc})",
                file=sys.stderr,
            )
            return False, None
        return True, dashboard_fd
    finally:
        if profiles_fd >= 0:
            os.close(profiles_fd)
        os.close(config_fd)


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


def _read_regular_text_no_follow(path: str, label: str, *, dir_fd: int | None = None) -> str:
    """Read a regular text file without following its final path component."""

    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = -1
    try:
        name = os.path.basename(path) if dir_fd is not None else path
        fd = os.open(name, flags, dir_fd=dir_fd)
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


def _load_yaml(path: str, label: str, *, dir_fd: int | None = None) -> dict:
    """Load a YAML mapping through the no-follow reader."""

    import yaml

    try:
        data = yaml.safe_load(_read_regular_text_no_follow(path, label, dir_fd=dir_fd))
    except yaml.YAMLError as exc:
        raise InvalidDashboardSeedDocumentError(f"{label} is malformed") from exc
    if not isinstance(data, dict):
        raise InvalidDashboardSeedDocumentError(f"{label} must be a mapping")
    return data


def _atomic_write_no_follow(
    dst: str,
    label: str,
    writer: Callable[[TextIO], None],
    *,
    parent_fd: int | None = None,
) -> bool:
    """Atomically replace a file relative to an optional validated parent."""

    parent, basename = os.path.split(dst)
    parent = parent or "."
    tmp_basename = f"{basename}.nemoclaw.tmp"
    tmp = os.path.join(parent, tmp_basename)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    for flag_name in ("O_CLOEXEC", "O_NOFOLLOW"):
        flags |= getattr(os, flag_name, 0)

    owner_ids = _seed_owner_ids()
    opened_parent_fd = -1
    fd = -1
    created = False
    try:
        if parent_fd is None:
            opened_parent_fd = _open_directory_no_follow(parent)
            write_parent_fd = opened_parent_fd
        else:
            write_parent_fd = parent_fd
        fd = os.open(tmp_basename, flags, 0o600, dir_fd=write_parent_fd)
        created = True
        with os.fdopen(fd, "w", encoding="utf-8", closefd=False) as handle:
            writer(handle)
            handle.flush()
        if owner_ids is not None:
            os.fchown(fd, owner_ids[0], owner_ids[1])
        os.fchmod(fd, 0o600)
        os.close(fd)
        fd = -1
        os.replace(
            tmp_basename,
            basename,
            src_dir_fd=write_parent_fd,
            dst_dir_fd=write_parent_fd,
        )
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
                os.unlink(tmp_basename, dir_fd=write_parent_fd)
            except OSError:
                # Best-effort temp cleanup after a failed atomic write; the
                # caller already gets the seed failure above.
                pass
        if opened_parent_fd >= 0:
            os.close(opened_parent_fd)


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


def _policy_section(gateway: dict, name: str) -> dict:
    value = gateway.get(name)
    if not isinstance(value, dict):
        raise InvalidDashboardPolicyError(f"{name} must be a mapping")
    return value


def _policy_bool(section: dict, section_name: str, key: str) -> bool:
    value = section.get(key)
    if not isinstance(value, bool):
        raise InvalidDashboardPolicyError(f"{section_name}.{key} must be a boolean")
    return value


def _policy_int(section: dict, section_name: str, key: str, minimum: int, maximum: int) -> int:
    value = section.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise InvalidDashboardPolicyError(
            f"{section_name}.{key} must be an integer from {minimum} through {maximum}"
        )
    return value


def _normalized_policy(gateway: dict) -> dict:
    """Return only reviewed policy leaves, rejecting incomplete or invalid source policy."""
    approvals = _policy_section(gateway, "approvals")
    approval_mode = approvals.get("mode")
    if not isinstance(approval_mode, str) or approval_mode not in _APPROVAL_MODES:
        raise InvalidDashboardPolicyError(
            "approvals.mode must be one of manual, smart, or off"
        )

    browser = _policy_section(gateway, "browser")
    restrict_evaluate = _policy_bool(browser, "browser", "restrict_evaluate")

    session_reset = _policy_section(gateway, "session_reset")
    session_keys = frozenset(session_reset)
    if session_keys != _SESSION_RESET_KEYS:
        missing = sorted(_SESSION_RESET_KEYS - session_keys)
        extra = sorted(session_keys - _SESSION_RESET_KEYS)
        raise InvalidDashboardPolicyError(
            f"session_reset must contain the reviewed complete policy "
            f"(missing={missing}, extra={extra})"
        )
    reset_mode = session_reset.get("mode")
    if not isinstance(reset_mode, str) or reset_mode not in _SESSION_RESET_MODES:
        raise InvalidDashboardPolicyError(
            "session_reset.mode must be one of daily, idle, both, or none"
        )
    at_hour = _policy_int(session_reset, "session_reset", "at_hour", 0, 23)
    idle_minutes = _policy_int(
        session_reset,
        "session_reset",
        "idle_minutes",
        1,
        2**31 - 1,
    )
    notify = _policy_bool(session_reset, "session_reset", "notify")
    excluded_platforms = session_reset.get("notify_exclude_platforms")
    if (
        not isinstance(excluded_platforms, list)
        or not excluded_platforms
        or not all(isinstance(value, str) and value for value in excluded_platforms)
    ):
        raise InvalidDashboardPolicyError(
            "session_reset.notify_exclude_platforms must be a non-empty list of strings"
        )
    bg_process_max_age_hours = _policy_int(
        session_reset,
        "session_reset",
        "bg_process_max_age_hours",
        1,
        2**31 - 1,
    )

    display = _policy_section(gateway, "display")
    show_reasoning = _policy_bool(display, "display", "show_reasoning")
    show_commentary = _policy_bool(display, "display", "show_commentary")

    updates = _policy_section(gateway, "updates")
    pre_update_backup = updates.get("pre_update_backup")
    if isinstance(pre_update_backup, str):
        if pre_update_backup.strip().lower() not in _PRE_UPDATE_BACKUP_MODES:
            raise InvalidDashboardPolicyError(
                "updates.pre_update_backup has an unsupported mode"
            )
    elif not isinstance(pre_update_backup, bool):
        raise InvalidDashboardPolicyError(
            "updates.pre_update_backup must be a boolean or supported mode string"
        )
    refresh_cua_driver = _policy_bool(updates, "updates", "refresh_cua_driver")

    return {
        "approvals": {"mode": approval_mode},
        "browser": {"restrict_evaluate": restrict_evaluate},
        "session_reset": {
            "mode": reset_mode,
            "at_hour": at_hour,
            "idle_minutes": idle_minutes,
            "notify": notify,
            "notify_exclude_platforms": list(excluded_platforms),
            "bg_process_max_age_hours": bg_process_max_age_hours,
        },
        "display": {
            "show_reasoning": show_reasoning,
            "show_commentary": show_commentary,
        },
        "updates": {
            "pre_update_backup": pre_update_backup,
            "refresh_cua_driver": refresh_cua_driver,
        },
    }


def _merge_policy(dashboard: dict, policy: dict) -> None:
    """Overwrite only reviewed policy leaves while preserving dashboard-local siblings."""
    for section_name, managed_values in policy.items():
        dashboard_values = dashboard.get(section_name)
        merged = dict(dashboard_values) if isinstance(dashboard_values, dict) else {}
        merged.update(managed_values)
        dashboard[section_name] = merged


def _mirror_env(src: str, dst: str, *, dst_parent_fd: int | None = None) -> bool:
    """Mirror allowlisted environment values into the dashboard profile."""

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

    try:
        dst_stat = os.stat(
            os.path.basename(dst) if dst_parent_fd is not None else dst,
            dir_fd=dst_parent_fd,
            follow_symlinks=False,
        )
    except FileNotFoundError:
        dst_stat = None
    if dst_stat is not None and stat.S_ISLNK(dst_stat.st_mode):
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

    if not _atomic_write_no_follow(
        dst,
        "dashboard env",
        write_env,
        parent_fd=dst_parent_fd,
    ):
        return False

    print(f"[dashboard] seeded env into {dst}", file=sys.stderr)
    return True


def _seed_dashboard(argv: list[str], dashboard_fd: int | None) -> int:
    """Seed dashboard state using an optional validated profile descriptor."""
    src, dst = argv[1], argv[2]
    env_parent_fd = (
        dashboard_fd
        if len(argv) == 5
        and os.path.normpath(os.path.dirname(argv[4])) == os.path.normpath(os.path.dirname(dst))
        else None
    )

    try:
        import yaml  # noqa: F401
    except Exception:  # pragma: no cover - PyYAML ships in the Hermes venv
        print(
            "[SECURITY] Refusing to seed dashboard config because PyYAML is unavailable",
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
        if len(argv) == 5:
            env_ok = _mirror_env(argv[3], argv[4], dst_parent_fd=env_parent_fd)
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

    routing = _normalized_routing(gateway)
    if not routing.get("model") and not routing.get("custom_providers") and not routing.get("providers"):
        print(
            "[SECURITY] Refusing to seed dashboard config because gateway config has no model routing",
            file=sys.stderr,
        )
        return 1
    try:
        policy = _normalized_policy(gateway)
    except InvalidDashboardPolicyError:
        print(
            "[SECURITY] Refusing to seed dashboard config because gateway policy is invalid",
            file=sys.stderr,
        )
        return 1

    dashboard: dict = {}
    try:
        dashboard = _load_yaml(dst, "existing dashboard config", dir_fd=dashboard_fd)
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
    if len(argv) == 5 and not _mirror_env(
        argv[3],
        argv[4],
        dst_parent_fd=env_parent_fd,
    ):
        return 1

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
    _merge_policy(dashboard, policy)

    import yaml

    def write_dashboard(handle: TextIO) -> None:
        yaml.safe_dump(dashboard, handle, sort_keys=False)

    if not _atomic_write_no_follow(
        dst,
        "dashboard config",
        write_dashboard,
        parent_fd=dashboard_fd,
    ):
        return 1

    print(f"[dashboard] seeded model routing and reviewed policy into {dst}", file=sys.stderr)
    return 0


def main(argv: list[str]) -> int:
    """Validate arguments, anchor the destination, and run the dashboard seed."""
    merge_legacy = len(argv) > 1 and argv[1] == "--merge-legacy"
    seed_argv = [argv[0], *argv[2:]] if merge_legacy else argv
    if len(seed_argv) not in (3, 5):
        print(
            "[dashboard] usage: seed-dashboard-config.py "
            "[--merge-legacy] <gateway-config.yaml> <dashboard-config.yaml> "
            "[<gateway.env> <dashboard.env>]",
            file=sys.stderr,
        )
        return 1

    destination_ok, dashboard_fd = _prepare_dashboard_destination(
        seed_argv[2], merge_legacy=merge_legacy
    )
    if not destination_ok:
        return 1

    try:
        return _seed_dashboard(seed_argv, dashboard_fd)
    finally:
        if dashboard_fd is not None:
            os.close(dashboard_fd)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
