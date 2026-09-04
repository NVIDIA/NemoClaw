#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Compose NemoClaw's rebuild drain with pinned Hermes operator drain control.

Hermes v2026.8.27 / 0.20.6 scopes its operator marker to one container epoch.
That is correct for operator lifecycle actions, but a NemoClaw rebuild marker
must survive replacement gateway and container restarts until restored scripts
and cron jobs are revalidated. Keep those two owners on separate paths and OR
their predicates at the gateway boundary.

GatewayRunner also hydrates the composed state during construction. The async
watcher still reconciles state transitions, but cron and new-turn gates cannot
observe a false value during the watcher's first-tick window after restart.
When the root-owned release-recovery record is present, the root-owned
controller re-arms only scheduled, unclaimed one-shots that became due at or
after gate acquisition while dispatch was held. The gate remains active if
that durable jobs update fails.
Exact source-shape checks fail closed when the pinned Hermes implementation
changes. Remove this patch when upstream provides an equivalent independently
owned, restart-stable maintenance drain.
"""

from __future__ import annotations

import argparse
from pathlib import Path

OLD_MARKER_ANCHOR = '_DRAIN_REQUEST_FILENAME = ".drain_request.json"'
NEW_MARKER_ANCHOR = '''_DRAIN_REQUEST_FILENAME = ".drain_request.json"
_NEMOCLAW_CRON_RESTORE_DRAIN_PATH = Path(
    "/sandbox/.nemoclaw/hermes-cron-restore-drain.json"
)
'''

OLD_OPERATOR_HEADER = '''def drain_requested(*, home: Optional[Path] = None) -> bool:
    """True iff a begin-drain marker for THIS instantiation is present.
'''
NEW_OPERATOR_HEADER = '''def operator_drain_requested(*, home: Optional[Path] = None) -> bool:
    """True iff a begin-drain marker for THIS instantiation is present.
'''

DRAIN_NOTIFICATION_HEADER = (
    "def drain_notification_suppressed(*, home: Optional[Path] = None) -> bool:"
)
COMPOSED_FUNCTIONS = '''def nemoclaw_cron_restore_drain_requested() -> bool:
    """Return whether NemoClaw's restart-stable rebuild marker is present.

    This marker deliberately has no Hermes instantiation epoch. NemoClaw owns
    its complete lifecycle and clears it only after restored cron state is
    revalidated. Open the root-owned state directory itself and resolve the
    marker relative to that stable descriptor so a sandbox user cannot bypass
    the gate by replacing the directory entry. Any unsafe metadata or lookup
    error fails toward keeping dispatch drained.
    """
    import os
    import stat

    state_root = _NEMOCLAW_CRON_RESTORE_DRAIN_PATH.parent
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_DIRECTORY | os.O_NOFOLLOW
    try:
        state_root_fd = os.open(state_root, flags)
    except OSError:
        return True
    try:
        metadata = os.fstat(state_root_fd)
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or metadata.st_uid != 0
            or metadata.st_gid != 0
            or stat.S_IMODE(metadata.st_mode) & 0o022
        ):
            return True
        try:
            os.stat(
                _NEMOCLAW_CRON_RESTORE_DRAIN_PATH.name,
                dir_fd=state_root_fd,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            return False
        except OSError:
            return True
        return True
    except OSError:
        return True
    finally:
        try:
            os.close(state_root_fd)
        except OSError:
            pass


def drain_requested(*, home: Optional[Path] = None) -> bool:
    """Return whether either operator or NemoClaw drain is active."""
    return (
        nemoclaw_cron_restore_drain_requested()
        or operator_drain_requested(home=home)
    )
'''

OLD_RUN_BLOCK = '''        # External (NAS-driven) drain state — distinct from the shutdown
        # ``_draining`` flag above. Set by ``_drain_control_watcher`` when the
        # ``.drain_request.json`` marker is present: the gateway flips
        # ``gateway_state -> draining`` and refuses NEW turns, but the process
        # does NOT exit (the whole point — quiesce-without-restart, D4a). It is
        # fully reversible: removing the marker reverts to ``running`` and
        # re-accepts turns. ``_draining`` (shutdown) is one-way and ends in
        # process exit; this one is a steady state NAS polls during its
        # request -> poll -> proceed loop.
        self._external_drain_active = False
'''
NEW_RUN_BLOCK = '''        # External drain state is distinct from the one-way shutdown flag.
        # Hydrate it synchronously so an active operator or NemoClaw rebuild
        # marker gates new turns and cron before the async watcher gets its
        # first tick. The watcher remains responsible for later transitions
        # and persisted gateway_state reconciliation.
        from gateway.drain_control import drain_requested
        self._external_drain_active = drain_requested()
'''

OLD_ENTER_BLOCK = '''        if self._external_drain_active:
            return
'''
NEW_ENTER_BLOCK = '''        if self._external_drain_active:
            self._update_runtime_status("draining")
            return
'''

JOBS_ANCHOR = '''def get_due_jobs() -> List[Dict[str, Any]]:
'''
JOBS_RELEASE_HELPER = '''def rearm_nemoclaw_drained_oneshots(not_before: datetime, profile_homes) -> int:
    """Re-arm one-shots held overdue by NemoClaw's restore drain.

    The root-owned controller calls this helper while the external drain still
    blocks dispatch and passes the authenticated marker creation time. It
    changes only enabled scheduled one-shots that have never run, carry no
    dispatch or fire claim, and became due at or after that marker was acquired.
    Each validated profile uses its own cron-store context, jobs lock, and
    normal save path so profile isolation and ownership remain intact.
    """
    now = _hermes_now()
    not_before = _ensure_aware(not_before)
    if not_before > now:
        raise RuntimeError("NemoClaw cron restore drain time is in the future")
    rearm_gate = not_before.isoformat()
    replacement = now + timedelta(seconds=2)
    replacement_schedule = parse_schedule(replacement.isoformat())
    replacement_next = compute_next_run(replacement_schedule)
    if replacement_next is None:
        raise RuntimeError("NemoClaw cron restore could not schedule delayed one-shots")

    changed = 0
    for profile_home in profile_homes:
        profile_changed = 0
        with use_cron_store(profile_home):
            with _jobs_lock():
                jobs = load_jobs()
                for job in jobs:
                    schedule = job.get("schedule")
                    repeat = job.get("repeat")
                    if (
                        not isinstance(schedule, dict)
                        or schedule.get("kind") != "once"
                        or job.get("enabled", True) is not True
                        or job.get("state") not in {None, "scheduled"}
                        or job.get("last_run_at") is not None
                        or job.get("run_claim") is not None
                        or job.get("fire_claim") is not None
                        or (isinstance(repeat, dict) and repeat.get("completed", 0) != 0)
                    ):
                        continue
                    run_at = schedule.get("run_at")
                    next_run_at = job.get("next_run_at")
                    if not isinstance(run_at, str) or not isinstance(next_run_at, str):
                        continue
                    try:
                        scheduled = _ensure_aware(datetime.fromisoformat(run_at))
                        next_run = _ensure_aware(datetime.fromisoformat(next_run_at))
                    except (TypeError, ValueError):
                        continue
                    if scheduled < not_before or next_run < not_before:
                        continue
                    if scheduled > now or next_run > now:
                        continue
                    job["schedule"] = dict(replacement_schedule)
                    job["schedule_display"] = replacement_schedule.get("display")
                    job["next_run_at"] = replacement_next
                    job["nemoclaw_restore_rearm_gate"] = rearm_gate
                    profile_changed += 1
                if profile_changed:
                    save_jobs(jobs)
        changed += profile_changed
    return changed


'''

DRAIN_CONTEXT = "from utils import atomic_json_write"
RUN_CONTEXT = (
    "class GatewayRunner(GatewayAuthorizationMixin, GatewayKanbanWatchersMixin, "
    "GatewaySlashCommandsMixin):"
)


def _require_exact(source: str, shape: str, description: str) -> None:
    count = source.count(shape)
    if count != 1:
        raise SystemExit(
            "ERROR: Hermes cron restore drain source shape changed; "
            f"expected one {description}, found {count}"
        )


def _state(
    source: str,
    *,
    old_shapes: tuple[str, ...],
    new_shapes: tuple[str, ...],
    description: str,
) -> str:
    old = all(source.count(shape) == 1 for shape in old_shapes)
    new = all(source.count(shape) == 1 for shape in new_shapes)
    if old and not new:
        return "unpatched"
    if new and not old:
        return "patched"
    raise SystemExit(
        "ERROR: Hermes cron restore drain source shape changed; "
        f"{description} is neither wholly unpatched nor wholly patched"
    )


def patch_files(
    drain_control_path: Path,
    gateway_run_path: Path,
    cron_jobs_path: Path,
) -> None:
    drain_source = drain_control_path.read_text(encoding="utf-8")
    run_source = gateway_run_path.read_text(encoding="utf-8")
    jobs_source = cron_jobs_path.read_text(encoding="utf-8")

    _require_exact(drain_source, DRAIN_CONTEXT, "drain-control import context")
    _require_exact(
        drain_source,
        DRAIN_NOTIFICATION_HEADER,
        "drain notification predicate",
    )
    _require_exact(run_source, RUN_CONTEXT, "GatewayRunner declaration")
    _require_exact(jobs_source, JOBS_ANCHOR, "cron due-jobs boundary")
    drain_state = _state(
        drain_source,
        old_shapes=(OLD_MARKER_ANCHOR, OLD_OPERATOR_HEADER),
        new_shapes=(
            NEW_MARKER_ANCHOR,
            NEW_OPERATOR_HEADER,
            COMPOSED_FUNCTIONS,
        ),
        description="drain predicate",
    )
    run_state = _state(
        run_source,
        old_shapes=(OLD_RUN_BLOCK, OLD_ENTER_BLOCK),
        new_shapes=(NEW_RUN_BLOCK, NEW_ENTER_BLOCK),
        description="GatewayRunner initialization",
    )
    helper_count = jobs_source.count(JOBS_RELEASE_HELPER)
    if helper_count == 0:
        jobs_state = "unpatched"
    elif helper_count == 1:
        jobs_state = "patched"
    else:
        raise SystemExit(
            "ERROR: Hermes cron restore drain source shape changed; "
            "cron release helper is duplicated"
        )
    if len({drain_state, run_state, jobs_state}) != 1:
        raise SystemExit(
            "ERROR: Hermes cron restore drain patch is only partially applied"
        )
    if drain_state == "patched":
        return

    drain_source = drain_source.replace(OLD_MARKER_ANCHOR, NEW_MARKER_ANCHOR)
    drain_source = drain_source.replace(OLD_OPERATOR_HEADER, NEW_OPERATOR_HEADER)
    drain_source = drain_source.replace(
        DRAIN_NOTIFICATION_HEADER,
        f"{COMPOSED_FUNCTIONS}\n\n{DRAIN_NOTIFICATION_HEADER}",
    )
    run_source = run_source.replace(OLD_RUN_BLOCK, NEW_RUN_BLOCK)
    run_source = run_source.replace(OLD_ENTER_BLOCK, NEW_ENTER_BLOCK)
    jobs_source = jobs_source.replace(JOBS_ANCHOR, f"{JOBS_RELEASE_HELPER}{JOBS_ANCHOR}")
    drain_control_path.write_text(drain_source, encoding="utf-8")
    gateway_run_path.write_text(run_source, encoding="utf-8")
    cron_jobs_path.write_text(jobs_source, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--drain-control",
        default="/opt/hermes/gateway/drain_control.py",
        help="Hermes drain-control module to patch",
    )
    parser.add_argument(
        "--gateway-run",
        default="/opt/hermes/gateway/run.py",
        help="Hermes gateway runner module to patch",
    )
    parser.add_argument(
        "--cron-jobs",
        default="/opt/hermes/cron/jobs.py",
        help="Hermes cron jobs module to patch",
    )
    args = parser.parse_args()
    patch_files(
        Path(args.drain_control),
        Path(args.gateway_run),
        Path(args.cron_jobs),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
