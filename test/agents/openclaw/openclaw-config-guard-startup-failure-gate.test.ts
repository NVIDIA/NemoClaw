// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const GUARD_PATH = path.resolve("scripts/openclaw-config-guard.py");
const STATE_GUARD_PATH = path.resolve("scripts/state-dir-guard.py");
const PYTHON = process.platform === "win32" ? "python" : "python3";

const HARNESS = String.raw`
import importlib.util
import json
import os
import sys
import tempfile
import typing

spec = importlib.util.spec_from_file_location("guard", sys.argv[1])
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)

identity = guard.Identity(root_uid=0, root_gid=0, sandbox_uid=1000, sandbox_gid=1000)
guard.INSTALLED_HELPER_PATH = guard.__file__
guard._pid1_is_nemoclaw_start = lambda: False
guard._startup_lease_state = lambda _identity: (False, False)
nul = bytes([0])
start_cmdline = b"bash" + nul + b"/usr/local/bin/nemoclaw-start" + nul
supervisor_cmdline = b"/opt/openshell/bin/openshell-sandbox" + nul

def write_process(proc_root, pid, cmdline, namespace_path, uid, parent_pid):
    process_dir = os.path.join(proc_root, str(pid))
    os.makedirs(os.path.join(process_dir, "ns"))
    fields = ["S", str(parent_pid)] + (["0"] * 17) + ["424242"]
    with open(os.path.join(process_dir, "stat"), "w", encoding="ascii") as stream:
        stream.write(f"{pid} (nemoclaw) {' '.join(fields)}\n")
    with open(os.path.join(process_dir, "cmdline"), "wb") as stream:
        stream.write(cmdline)
    with open(os.path.join(process_dir, "status"), "w", encoding="ascii") as stream:
        stream.write(
            f"Uid:\t{uid}\t{uid}\t{uid}\t{uid}\n"
            f"NSpid:\t{pid}\t{pid}\n"
        )
    os.link(namespace_path, os.path.join(process_dir, "ns", "pid"))

def with_proc(children, markers_absent, supervisor, limit):
    root = tempfile.mkdtemp()
    proc_root = os.path.join(root, "proc")
    os.mkdir(proc_root)
    namespace_path = os.path.join(root, "shared")
    with open(namespace_path, "wb") as stream:
        stream.write(b"shared")
    write_process(proc_root, 1, supervisor, namespace_path, 0, 0)
    for pid in children:
        write_process(proc_root, pid, start_cmdline, namespace_path, 1000, 1)
    guard.PROC_ROOT = proc_root
    guard.MAX_PROC_ENTRIES = limit
    guard._startup_markers_absent = lambda _identity: markers_absent

def gate(action, children, markers_absent=True, supervisor=supervisor_cmdline, limit=32768):
    with_proc(children, markers_absent, supervisor, limit)
    try:
        guard._validate_action_readiness(action, False, identity)
        return "allowed"
    except guard.GuardError as error:
        return error.code

def provisional(action, children):
    with_proc(children, True, supervisor_cmdline, 32768)
    try:
        return bool(guard._validate_action_readiness(action, False, identity))
    except guard.GuardError:
        return "refused"

def reconfirm(children, markers_absent=True):
    with_proc(children, markers_absent, supervisor_cmdline, 32768)
    try:
        guard._reconfirm_startup_failure_recovery("unlock", identity)
        return "ok"
    except guard.GuardError as error:
        return error.code

def cli_accepts(action):
    parser = guard._parser()
    choices = next(a.choices for a in parser._actions if a.dest == "action")
    return action in set(choices) and set(choices) == set(typing.get_args(guard.Action))

print(json.dumps({
    # The CLI choices tuple is separate from the Action type, so an action can
    # exist in code and still be unreachable through the entry point.
    "cli_exposes_recovery": cli_accepts("unlock-failed-startup"),
    "failed_recovery": gate("unlock-failed-startup", []),
    "failed_preflight": gate("preflight", []),
    "failed_unlock": gate("unlock", []),
    "failed_lock": gate("lock", []),
    "failed_write": gate("write-config", []),
    "failed_seal": gate("seal-restart", []),
    "failed_recover": gate("recover", []),
    "live_lock": gate("lock", [412]),
    "duplicate_unlock": gate("unlock-failed-startup", [412, 413]),
    "foreign_unlock": gate("unlock-failed-startup", [], supervisor=b"/usr/bin/foreign" + nul),
    "stale_marker_unlock": gate("unlock-failed-startup", [], markers_absent=False),
    "bounded_scan_unlock": gate("unlock-failed-startup", [], limit=0),
    "provisional_failed_recovery": provisional("unlock-failed-startup", []),
    "provisional_live_lock": provisional("lock", [412]),
    "live_recovery": gate("unlock-failed-startup", [412]),
    "reconfirm_still_childless": reconfirm([]),
    "reconfirm_child_appeared": reconfirm([412]),
    "reconfirm_marker_appeared": reconfirm([], markers_absent=False),
}))
`;

const TRANSACTION_HARNESS = String.raw`
import importlib.util
import json
import subprocess
import time
import sys
import types

if sys.platform == "win32":
    for name in ("fcntl", "grp", "pwd"):
        sys.modules[name] = types.ModuleType(name)

spec = importlib.util.spec_from_file_location("guard", sys.argv[1])
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)

guard.os.path.isfile = lambda _path: True
run_call = {}
def timeout_run(command, **kwargs):
    run_call["command"] = command
    run_call["pass_fds"] = kwargs.get("pass_fds")
    raise subprocess.TimeoutExpired("state-dir-guard", guard.STATE_DIR_GUARD_TIMEOUT_SECONDS)

guard.subprocess.run = timeout_run
try:
    guard._run_state_dir_guard(
        "unlock",
        guard.PRODUCTION_CONFIG_DIR,
        "{}",
        91,
        time.monotonic() + guard.STATE_DIR_GUARD_TIMEOUT_SECONDS,
    )
except guard.GuardError as error:
    timeout_code = error.code

freeze_flags = []
def capture_freeze(_opened, _identity, **kwargs):
    freeze_flags.append(kwargs.get("quarantine_reserved"))
    raise guard.GuardError("injected-freeze-stop", guard.PRODUCTION_CONFIG_DIR, "stop")

guard._freeze = capture_freeze
guard._has_clamped_locked_dir_posture = lambda _opened, _identity: False
guard._has_locked_dir_posture = lambda _opened, _identity: False
guard._force_fail_closed_lock = lambda _opened, _identity: []
try:
    guard._transition("lock", object(), object(), quarantine_untrusted=True)
except guard.GuardError as error:
    assert error.code == "injected-freeze-stop"

guard._is_mutable_dir_posture = lambda _opened, _identity: False
guard._snapshot_pair = lambda _opened: (object(), object())
guard._verify_locked_posture = lambda *_args, **_kwargs: None
guard._restore_originals = lambda _opened, _snapshots, _identity: []
try:
    guard._transition("unlock", object(), object(), quarantine_untrusted=True)
except guard.GuardError as error:
    assert error.code == "injected-freeze-stop"

events = []
transaction_deadlines = {}
def transition(action, _opened, _identity, **kwargs):
    events.append(f"config-{action}-quarantine-{kwargs.get('quarantine_untrusted')}")
    if action == "unlock":
        raise guard.MutableHandoffError(
            "mutable-handoff-incomplete", guard.PRODUCTION_CONFIG_DIR, "handoff failed"
        )

def state_dir(action, _config_dir, _plan_json, lock_fd, deadline):
    assert lock_fd == 91
    transaction_deadlines[action] = deadline
    events.append(f"state-{action}")
    if action == "lock":
        raise guard.GuardError("state-lock-failed", guard.PRODUCTION_CONFIG_DIR, "lock failed")

guard._transition = transition
guard._run_state_dir_guard = state_dir
try:
    guard._run_failed_startup_unlock(
        object(), object(), guard.PRODUCTION_CONFIG_DIR, "{}", 91, quarantine_untrusted=True
    )
except guard.GuardError as error:
    transaction_error = {
        "code": error.code,
        "detail": error.detail,
    }

timeout_events = []
timeout_deadlines = {}
timeout_rollback_remaining = None
def timeout_transition(action, _opened, _identity, **kwargs):
    timeout_events.append(f"config-{action}-quarantine-{kwargs.get('quarantine_untrusted')}")

def timeout_state_dir(action, _config_dir, _plan_json, lock_fd, deadline):
    global timeout_rollback_remaining
    assert lock_fd == 91
    if deadline - guard.time.monotonic() <= 0:
        raise guard.GuardError(
            "state-dir-transition-timeout", guard.PRODUCTION_CONFIG_DIR,
            f"no recovery budget left for state-dir {action}",
        )
    timeout_deadlines[action] = deadline
    timeout_events.append(f"state-{action}")
    if action == "unlock":
        # Model the forward transition consuming its entire allowance. A
        # shared deadline would make the following relock refuse to start.
        guard.time.monotonic = lambda: deadline
        raise guard.GuardError(
            "state-dir-transition-timeout", guard.PRODUCTION_CONFIG_DIR, "unlock timed out"
        )
    # Model a relock that consumes nearly the state guard's ten-minute
    # maximum. The remaining allowance covers config relock overhead.
    guard.time.monotonic = lambda: deadline - (2 * 60 + 1)
    timeout_rollback_remaining = deadline - guard.time.monotonic()

guard._transition = timeout_transition
guard._run_state_dir_guard = timeout_state_dir
try:
    guard._run_failed_startup_unlock(
        object(), object(), guard.PRODUCTION_CONFIG_DIR, "{}", 91, quarantine_untrusted=True
    )
except guard.GuardError as error:
    timeout_transaction_code = error.code

print(json.dumps({
    "timeout_code": timeout_code,
    "lock_fd_flag": run_call["command"][-2:],
    "pass_fds": run_call["pass_fds"],
    "freeze_flags": freeze_flags,
    "events": events,
    "rollback_reserve": transaction_deadlines["lock"] - transaction_deadlines["unlock"],
    "transaction_error": transaction_error,
    "timeout_events": timeout_events,
    "timeout_rollback_reserve": timeout_deadlines["lock"] - timeout_deadlines["unlock"],
    "timeout_rollback_remaining": timeout_rollback_remaining,
    "timeout_transaction_code": timeout_transaction_code,
}))
`;

const LOCK_HANDOFF_HARNESS = String.raw`
import fcntl
import json
import os
import subprocess
import sys
import tempfile

guard_path = sys.argv[1]
# macOS exposes /var as a symlink to /private/var. Resolve the fixture root so
# descriptor-safe no-follow traversal tests the inherited lock rather than
# rejecting the host's symlinked temporary-directory prefix.
root = os.path.realpath(tempfile.mkdtemp())
config_dir = os.path.join(root, ".openclaw")
lock_path = os.path.join(root, ".openclaw-config-mutation.lock")
os.mkdir(config_dir)
owner_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
foreign_fd = os.open(lock_path, os.O_RDWR)
fcntl.flock(owner_fd, fcntl.LOCK_EX)
plan_json = json.dumps({
    "version": 1,
    "readOnlyRoots": [],
    "confidentialRoots": [],
    "readOnlyPrefixes": [],
    "confidentialPrefixes": [],
    "writableSubpaths": [],
})
child = r'''
import importlib.util
import json
import os
import sys

guard_path, config_dir, plan_json, lock_fd = sys.argv[1:5]
spec = importlib.util.spec_from_file_location("state_guard", guard_path)
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)
identity = guard.Identity(
    root_uid=os.getuid(), root_gid=os.getgid(),
    sandbox_uid=os.getuid(), sandbox_gid=os.getgid(),
)
guard.os.geteuid = lambda: 0
guard._production_identity = lambda: identity
raise SystemExit(guard.main([
    "unlock", "--config-dir", config_dir, "--plan-json", plan_json,
    "--transition-lock-fd", lock_fd,
]))
'''
env = {**os.environ, "NEMOCLAW_TEST_OPENCLAW_TRANSACTION_LOCK": "1"}

def invoke(lock_fd):
    return subprocess.run(
        [sys.executable, "-c", child, guard_path, config_dir, plan_json, str(lock_fd)],
        capture_output=True,
        text=True,
        timeout=5,
        env=env,
        pass_fds=(lock_fd,),
        check=False,
    )

inherited = invoke(owner_fd)
foreign = invoke(foreign_fd)
print(json.dumps({
    "inherited_status": inherited.returncode,
    "inherited_records": [json.loads(line) for line in inherited.stdout.splitlines()],
    "foreign_status": foreign.returncode,
    "foreign_records": [json.loads(line) for line in foreign.stdout.splitlines()],
}))
`;

const NOT_APPLICABLE_HARNESS = String.raw`
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("guard", sys.argv[1])
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)
guard.os.geteuid = lambda: 0
guard._production_identity = lambda: object()
guard._validate_action_readiness = lambda *_args, **_kwargs: False
status = guard.main([
    "unlock-failed-startup",
    "--config-dir", guard.PRODUCTION_CONFIG_DIR,
    "--plan-json", "{}",
])
print(json.dumps({"status": status}))
`;

describe("OpenClaw failed-startup unlock transaction (#8304)", () => {
  it("relocks both state layers after a config handoff failure", () => {
    const result = spawnSync(PYTHON, ["-c", TRANSACTION_HARNESS, GUARD_PATH], {
      encoding: "utf-8",
      timeout: 10000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      timeout_code: "state-dir-transition-timeout",
      lock_fd_flag: ["--transition-lock-fd", "91"],
      pass_fds: [91],
      freeze_flags: [true, true],
      events: [
        "state-unlock",
        "config-unlock-quarantine-True",
        "config-lock-quarantine-True",
        "state-lock",
      ],
      rollback_reserve: 720,
      transaction_error: {
        code: "mutable-handoff-incomplete",
        detail: "handoff failed; rollback issues: state-dir lock: lock failed",
      },
      timeout_events: ["state-unlock", "config-lock-quarantine-True", "state-lock"],
      timeout_rollback_reserve: 720,
      timeout_rollback_remaining: 121,
      timeout_transaction_code: "state-dir-transition-timeout",
    });
  });
});

describe("OpenClaw failed-startup host classification (#8304)", () => {
  it("emits a distinct machine code when recovery is not applicable", () => {
    const result = spawnSync(PYTHON, ["-c", NOT_APPLICABLE_HARNESS, GUARD_PATH], {
      encoding: "utf-8",
      timeout: 10000,
    });

    expect(result.status, result.stderr).toBe(0);
    const records = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toContainEqual(
      expect.objectContaining({
        type: "issue",
        code: "failed-startup-not-proven",
      }),
    );
    expect(records).toContainEqual({ status: 1 });
  });
});

describe.skipIf(process.platform === "win32")(
  "OpenClaw config guard startup-failure gate (#8304)",
  () => {
    it("shares the held mutation lock with the recursive state guard", () => {
      const result = spawnSync(PYTHON, ["-c", LOCK_HANDOFF_HARNESS, STATE_GUARD_PATH], {
        encoding: "utf-8",
        timeout: 10000,
      });

      expect(result.status, result.stderr).toBe(0);
      const outcome = JSON.parse(result.stdout);
      expect(outcome.inherited_status, JSON.stringify(outcome)).toBe(0);
      expect(outcome.inherited_records).toContainEqual(
        expect.objectContaining({ type: "result", action: "unlock", status: "ok" }),
      );
      expect(outcome.foreign_status).toBe(1);
      expect(outcome.foreign_records).toContainEqual(
        expect.objectContaining({ type: "issue", code: "transition-lock-not-inherited" }),
      );
    });

    it("combines the real process census with the action gate", () => {
      const result = spawnSync(PYTHON, ["-c", HARNESS, GUARD_PATH], {
        encoding: "utf-8",
        timeout: 10000,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        cli_exposes_recovery: true,
        // Only the dedicated atomic action is reachable through the escape.
        failed_recovery: "allowed",
        // The multi-step host sequence stays refused, so its first step fails
        // closed and no recursive state is mutated on stale evidence.
        failed_preflight: "startup-not-ready",
        failed_unlock: "startup-not-ready",
        failed_lock: "startup-not-ready",
        failed_write: "startup-not-ready",
        failed_seal: "startup-not-ready",
        failed_recover: "startup-not-ready",
        live_lock: "allowed",
        duplicate_unlock: "startup-not-ready",
        foreign_unlock: "startup-not-ready",
        stale_marker_unlock: "startup-not-ready",
        // A bounded-scan overflow makes the census undeterminable. Both
        // predicates must map that onto False so neither path authenticates.
        bounded_scan_unlock: "startup-not-ready",
        // Only the failed-startup path reports a provisional authorization, so
        // the mutex-held reconfirm runs for that path and nothing else.
        provisional_failed_recovery: true,
        provisional_live_lock: false,
        // A healthy sandbox must never reach the recovery action.
        live_recovery: "startup-not-ready",
        // The reconfirm is what binds the census to the effect: a start child
        // or a marker appearing after the pre-mutex scan revokes the escape.
        reconfirm_still_childless: "ok",
        reconfirm_child_appeared: "startup-not-ready",
        reconfirm_marker_appeared: "startup-not-ready",
      });
    });
  },
);
