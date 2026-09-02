// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HERMES_CRON_RESTORE_DRAIN_MARKER_ROLLBACK_FAILED_CODE } from "../../../src/lib/actions/sandbox/rebuild-hermes-post-restore";
import { validateHermesCronRestoreBackup } from "../../../src/lib/state/rebuild/hermes-cron-restore-backup";

const HELPER = path.resolve("agents/hermes/cron-restore-control.py");
const HOST_VALIDATOR = path.resolve("src/lib/state/rebuild/hermes-cron-restore-backup.ts");
const RECEIPT_PREFIX = "NEMOCLAW_HERMES_CRON_RESTORE_V1:";
const CONTROL_ERROR_PREFIX = "NEMOCLAW_HERMES_CRON_RESTORE_ERROR_V1:";
const LIFECYCLE_HARNESS = String.raw`
import importlib.util
import os
import sys
import types
from datetime import datetime, timezone
from pathlib import Path

spec = importlib.util.spec_from_file_location("cron_restore_control", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
scenario = sys.argv[2]
module.HERMES_HOME = Path(sys.argv[3])
module.SANDBOX_HOME = module.HERMES_HOME.parent
module.NEMOCLAW_HOME = module.SANDBOX_HOME / ".nemoclaw"
module.CONTROL_LOCK_PATH = module.SANDBOX_HOME / "run" / "cron-restore.lock"
module.ROOT_UID = os.geteuid()
module.ROOT_GID = os.getegid()
module.NEMOCLAW_HOME.mkdir(mode=0o755)
module.CONTROL_LOCK_PATH.parent.mkdir(mode=0o755)
os.chmod(module.NEMOCLAW_HOME, 0o755)
os.chmod(module.CONTROL_LOCK_PATH.parent, 0o755)
cron_validations = 0
def validate_cron_tree():
    global cron_validations
    if not module._marker_path().exists():
        raise AssertionError("cron validation ran without the NemoClaw drain")
    cron_validations += 1
    return {
        "profiles": 1,
        "active_jobs": 1,
        "script_jobs": 1,
    }
module.validate_cron_tree = validate_cron_tree
durability_sync_calls = 0
def fail_directory_sync_on(expected_call):
    original_fsync_directory = module._fsync_directory
    def fsync_directory(path, label):
        global durability_sync_calls
        durability_sync_calls += 1
        if durability_sync_calls == expected_call:
            raise module.ControlError("simulated state directory durability failure")
        return original_fsync_directory(path, label)
    module._fsync_directory = fsync_directory

def forbid_gateway_or_validation(*_args, **_kwargs):
    raise AssertionError("prepare-recover touched gateway or cron validation")

class DrainControl:
    def __init__(self):
        self.write_calls = 0
        self.clear_calls = 0

    @staticmethod
    def drain_request_path(home):
        return Path(home) / ".drain_request.json"

    @property
    def marker(self):
        path = self.drain_request_path(module.HERMES_HOME)
        try:
            return __import__("json").loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None

    @marker.setter
    def marker(self, value):
        path = self.drain_request_path(module.HERMES_HOME)
        if value is None:
            path.unlink(missing_ok=True)
            return
        path.write_text(__import__("json").dumps(value), encoding="utf-8")

    def write_drain_request(self, **kwargs):
        self.write_calls += 1
        raise AssertionError("controller mutated the operator marker")

    def operator_drain_requested(self, **_kwargs):
        marker = self.marker
        return marker is not None and marker.get("principal") != "stale"

    def clear_drain_request(self, **_kwargs):
        self.clear_calls += 1
        raise AssertionError("controller mutated the operator marker")

class Status:
    payload = {
        "pid": 41,
        "start_time": 902,
        "gateway_state": "running",
        "active_agents": 0,
    }
    force_state = None

    def read_runtime_status(self):
        payload = dict(self.payload)
        payload["gateway_state"] = self.force_state or (
            "draining"
            if module._marker_path().exists() or drain.operator_drain_requested()
            else "running"
        )
        return payload

    def get_runtime_status_running_pid(self, *, runtime, expected_home):
        return runtime["pid"]

    def parse_active_agents(self, value):
        return int(value)

drain = DrainControl()
status = Status()
module._load_gateway_modules = lambda: (drain, status)
rearm_calls = []
delayed_one_shot_due_at = None
cron_package = types.ModuleType("cron")
cron_jobs = types.ModuleType("cron.jobs")
def rearm_nemoclaw_drained_oneshots(not_before, profile_homes):
    if not module._marker_path().exists():
        raise AssertionError("one-shot re-arm ran without the NemoClaw drain")
    if not profile_homes or profile_homes[0] != module.HERMES_HOME:
        raise AssertionError("one-shot re-arm did not include the default Hermes profile")
    rearm_calls.append(not_before.isoformat())
    if delayed_one_shot_due_at is not None and not_before > delayed_one_shot_due_at:
        return 0
    return 1
cron_jobs.rearm_nemoclaw_drained_oneshots = rearm_nemoclaw_drained_oneshots
cron_package.jobs = cron_jobs
sys.modules["cron"] = cron_package
sys.modules["cron.jobs"] = cron_jobs
RECOVERY_STARTED_AT_NS = 1_600_000_000_000_000_000

try:
    if scenario == "success":
        token = module.begin_drain()
        module.validate_restore(41, 902, token)
        module.recover_drain()
    elif scenario == "wrong-identity":
        token = module.begin_drain()
        module.validate_restore(42, 902, token)
    elif scenario == "missing-marker":
        token = module.begin_drain()
        module._marker_path().unlink()
        status.payload["pid"] = 77
        status.payload["start_time"] = 903
        module.complete_replacement(41, 902, 77, 903, token)
    elif scenario == "preserve-operator":
        drain.marker = {"principal": "operator"}
        token = module.begin_drain()
        module.validate_restore(41, 902, token)
        module.recover_drain()
    elif scenario == "concurrent-operator":
        token = module.begin_drain()
        module.validate_restore(41, 902, token)
        drain.marker = {"principal": "operator"}
        module.recover_drain()
    elif scenario == "existing-owned-marker":
        marker = module._marker_path()
        marker.write_text(
            __import__("json").dumps({"token": "a" * 32, "version": 1}),
            encoding="utf-8",
        )
        os.chmod(marker, 0o400)
        module.begin_drain()
    elif scenario == "link-failure":
        def fail_link(*_args):
            raise OSError("unsupported")
        module.os.link = fail_link
        module.begin_drain()
    elif scenario == "symlink-owned-marker":
        token = module.begin_drain()
        marker = module._marker_path()
        held = module.NEMOCLAW_HOME / "held-marker.json"
        marker.rename(held)
        marker.symlink_to(held.name)
        module.recover_drain()
    elif scenario == "hardlinked-owned-marker":
        token = module.begin_drain()
        marker = module._marker_path()
        held = module.NEMOCLAW_HOME / "held-marker.json"
        os.link(marker, held)
        module.recover_drain()
    elif scenario == "unsafe-lock-metadata":
        module.CONTROL_LOCK_PATH.write_text("unsafe", encoding="utf-8")
        os.chmod(module.CONTROL_LOCK_PATH, 0o644)
        module.begin_drain()
    elif scenario == "replacement-owned-marker":
        token = module.begin_drain()
        marker = module._marker_path()
        os.chmod(marker, 0o600)
        marker.write_text(
            __import__("json").dumps({"token": "b" * 32, "version": 1}),
            encoding="utf-8",
        )
        os.chmod(marker, 0o400)
        status.payload["pid"] = 77
        status.payload["start_time"] = 903
        module.complete_replacement(41, 902, 77, 903, token)
    elif scenario == "rollback-operator":
        token = module.begin_drain()
        module.validate_restore(41, 902, token)
        def fail_after_operator_drain(*_args, **_kwargs):
            drain.marker = {"principal": "operator"}
            raise module.ControlError("simulated reactivation failure")
        module._wait_for_release_disposition = fail_after_operator_drain
        module.recover_drain()
    elif scenario == "complete":
        token = module.begin_drain()
        module.validate_restore(41, 902, token)
        status.payload["pid"] = 77
        status.payload["start_time"] = 903
        module.observe_replacement(41, 902, token)
        module.complete_replacement(41, 902, 77, 903, token)
    elif scenario == "complete-same-identity":
        drain.marker = {"principal": "operator"}
        token = module.begin_drain()
        module.validate_restore(41, 902, token)
        module.complete_replacement(41, 902, 41, 902, token)
    elif scenario == "complete-validation-failure":
        drain.marker = {"principal": "operator"}
        token = module.begin_drain()
        module.validate_restore(41, 902, token)
        status.payload["pid"] = 77
        status.payload["start_time"] = 903
        module.observe_replacement(41, 902, token)
        def fail_validation():
            raise module.ControlError("replacement cron tree is invalid")
        module.validate_cron_tree = fail_validation
        module.complete_replacement(41, 902, 77, 903, token)
    elif scenario == "complete-substitution":
        drain.marker = {"principal": "operator"}
        token = module.begin_drain()
        module.validate_restore(41, 902, token)
        status.payload["pid"] = 77
        status.payload["start_time"] = 903
        module.observe_replacement(41, 902, token)
        status.payload["pid"] = 88
        status.payload["start_time"] = 904
        module.complete_replacement(41, 902, 77, 903, token)
    elif scenario == "complete-release-substitution":
        drain.marker = {"principal": "operator"}
        token = module.begin_drain()
        module.validate_restore(41, 902, token)
        status.payload["pid"] = 77
        status.payload["start_time"] = 903
        module.observe_replacement(41, 902, token)
        validate_cron_tree = module.validate_cron_tree
        def substitute_after_validation():
            counts = validate_cron_tree()
            status.payload["pid"] = 88
            status.payload["start_time"] = 904
            return counts
        module.validate_cron_tree = substitute_after_validation
        module.complete_replacement(41, 902, 77, 903, token)
    elif scenario == "complete-release-failure":
        drain.marker = {"principal": "operator"}
        token = module.begin_drain()
        module.validate_restore(41, 902, token)
        status.payload["pid"] = 77
        status.payload["start_time"] = 903
        module.observe_replacement(41, 902, token)
        def fail_release(*_args, **_kwargs):
            raise module.ControlError("simulated replacement release failure")
        module._wait_for_release_disposition = fail_release
        module.complete_replacement(41, 902, 77, 903, token)
    elif scenario == "complete-release-rollback-failure":
        token = module.begin_drain()
        module.validate_restore(41, 902, token)
        status.payload["pid"] = 77
        status.payload["start_time"] = 903
        module.observe_replacement(41, 902, token)
        def fail_release(*_args, **_kwargs):
            raise module.ControlError("simulated replacement release failure")
        def fail_rollback(*_args, **_kwargs):
            raise module.ControlError("simulated marker rollback failure")
        module._wait_for_release_disposition = fail_release
        module._write_owned_drain = fail_rollback
        module.complete_replacement(41, 902, 77, 903, token)
    elif scenario == "complete-durable-order":
        token = module.begin_drain()
        module.validate_restore(41, 902, token)
        status.payload["pid"] = 77
        status.payload["start_time"] = 903
        module.observe_replacement(41, 902, token)
        release_events = []
        original_write_release_recovery = module._write_release_recovery
        original_remove_owned_drain = module._remove_owned_drain
        def write_release_recovery(drain_token, drain_started_at_ns):
            release_events.append("recovery-write-started")
            original_write_release_recovery(drain_token, drain_started_at_ns)
            release_events.append("recovery-write-durable")
        def remove_owned_drain(drain_token):
            release_events.append("drain-delete-started")
            original_remove_owned_drain(drain_token)
            release_events.append("drain-delete-durable")
        module._write_release_recovery = write_release_recovery
        module._remove_owned_drain = remove_owned_drain
        module.complete_replacement(41, 902, 77, 903, token)
        print("RELEASE_EVENTS:" + ",".join(release_events))
    elif scenario == "release-recovery-sync-failure":
        token = module.begin_drain()
        module.validate_restore(41, 902, token)
        status.payload["pid"] = 77
        status.payload["start_time"] = 903
        module.observe_replacement(41, 902, token)
        fail_directory_sync_on(1)
        module.complete_replacement(41, 902, 77, 903, token)
    elif scenario == "rearm-failure":
        token = module.begin_drain()
        module.validate_restore(41, 902, token)
        def fail_rearm(_not_before, _profile_homes):
            raise RuntimeError("simulated re-arm failure")
        cron_jobs.rearm_nemoclaw_drained_oneshots = fail_rearm
        module.recover_drain()
    elif scenario == "existing-recovery-sync-failure":
        token = module.begin_drain()
        module.validate_restore(41, 902, token)
        status.payload["pid"] = 77
        status.payload["start_time"] = 903
        module.observe_replacement(41, 902, token)
        module._write_release_recovery(token, module._owned_drain_started_at_ns(token))
        fail_directory_sync_on(1)
        module.complete_replacement(41, 902, 77, 903, token)
    elif scenario == "drain-unlink-sync-failure":
        token = module.begin_drain()
        module.validate_restore(41, 902, token)
        status.payload["pid"] = 77
        status.payload["start_time"] = 903
        module.observe_replacement(41, 902, token)
        fail_directory_sync_on(2)
        module.complete_replacement(41, 902, 77, 903, token)
    elif scenario == "recovery-unlink-sync-failure":
        token = module.begin_drain()
        module.validate_restore(41, 902, token)
        status.payload["pid"] = 77
        status.payload["start_time"] = 903
        module.observe_replacement(41, 902, token)
        fail_directory_sync_on(3)
        module.complete_replacement(41, 902, 77, 903, token)
    elif scenario == "rollback-publication-sync-failure":
        token = module.begin_drain()
        module.validate_restore(41, 902, token)
        status.payload["pid"] = 77
        status.payload["start_time"] = 903
        module.observe_replacement(41, 902, token)
        def fail_release(*_args, **_kwargs):
            raise module.ControlError("simulated replacement release failure")
        module._wait_for_release_disposition = fail_release
        fail_directory_sync_on(3)
        module.complete_replacement(41, 902, 77, 903, token)
    elif scenario == "prepare-recovery-only":
        module._write_release_recovery("a" * 32, RECOVERY_STARTED_AT_NS)
        module._load_gateway_modules = forbid_gateway_or_validation
        module.validate_cron_tree = forbid_gateway_or_validation
        module.prepare_recovery()
    elif scenario == "prepare-matching":
        module._write_owned_drain("a" * 32, started_at_ns=RECOVERY_STARTED_AT_NS)
        module._write_release_recovery("a" * 32, RECOVERY_STARTED_AT_NS)
        module._load_gateway_modules = forbid_gateway_or_validation
        module.validate_cron_tree = forbid_gateway_or_validation
        module.prepare_recovery()
    elif scenario == "prepare-matching-sync-failure":
        module._write_owned_drain("a" * 32, started_at_ns=RECOVERY_STARTED_AT_NS)
        module._write_release_recovery("a" * 32, RECOVERY_STARTED_AT_NS)
        module._load_gateway_modules = forbid_gateway_or_validation
        module.validate_cron_tree = forbid_gateway_or_validation
        fail_directory_sync_on(1)
        module.prepare_recovery()
    elif scenario == "prepare-noop":
        module._load_gateway_modules = forbid_gateway_or_validation
        module.validate_cron_tree = forbid_gateway_or_validation
        module.prepare_recovery()
    elif scenario == "prepare-existing-sync-failure":
        module._write_owned_drain("a" * 32)
        fail_directory_sync_on(1)
        module.prepare_recovery()
    elif scenario == "prepare-mismatch":
        module._write_owned_drain("a" * 32, started_at_ns=RECOVERY_STARTED_AT_NS)
        module._write_release_recovery("b" * 32, RECOVERY_STARTED_AT_NS)
        module._load_gateway_modules = forbid_gateway_or_validation
        module.validate_cron_tree = forbid_gateway_or_validation
        module.prepare_recovery()
    elif scenario == "prepare-recovery-unsafe-mode":
        module._write_release_recovery("a" * 32, RECOVERY_STARTED_AT_NS)
        os.chmod(module._release_recovery_path(), 0o600)
        module.prepare_recovery()
    elif scenario == "prepare-recovery-symlink":
        module._write_release_recovery("a" * 32, RECOVERY_STARTED_AT_NS)
        recovery = module._release_recovery_path()
        held = module.NEMOCLAW_HOME / "held-recovery.json"
        recovery.rename(held)
        recovery.symlink_to(held.name)
        module.prepare_recovery()
    elif scenario == "prepare-recovery-hardlink":
        module._write_release_recovery("a" * 32, RECOVERY_STARTED_AT_NS)
        os.link(
            module._release_recovery_path(),
            module.NEMOCLAW_HOME / "held-recovery.json",
        )
        module.prepare_recovery()
    elif scenario == "pending-release-recovery":
        module._write_release_recovery("a" * 32, RECOVERY_STARTED_AT_NS)
        module.begin_drain()
    elif scenario == "mismatched-release-recovery":
        module.begin_drain()
        module._write_release_recovery("b" * 32, RECOVERY_STARTED_AT_NS)
        module.recover_drain()
    elif scenario == "recover-release-rollback":
        token = module.begin_drain()
        module.validate_restore(41, 902, token)
        status.payload["pid"] = 77
        status.payload["start_time"] = 903
        module.observe_replacement(41, 902, token)
        original_wait_for_release = module._wait_for_release_disposition
        original_write_owned_drain = module._write_owned_drain
        def fail_release(*_args, **_kwargs):
            raise module.ControlError("simulated replacement release failure")
        def fail_rollback(*_args, **_kwargs):
            raise module.ControlError("simulated marker rollback failure")
        module._wait_for_release_disposition = fail_release
        module._write_owned_drain = fail_rollback
        try:
            module.complete_replacement(41, 902, 77, 903, token)
        except module.ControlError as error:
            if error.code != module.DRAIN_MARKER_ROLLBACK_FAILED_CODE:
                raise
            module._emit_control_error(error)
        else:
            raise AssertionError("release rollback unexpectedly succeeded")
        finally:
            module._wait_for_release_disposition = original_wait_for_release
            module._write_owned_drain = original_write_owned_drain
        module.recover_drain()
    elif scenario == "recover-preserves-gate-start":
        token = module.begin_drain()
        original_started_at = module._owned_drain_started_at(token)
        module.validate_restore(41, 902, token)
        status.payload["pid"] = 77
        status.payload["start_time"] = 903
        module.observe_replacement(41, 902, token)
        original_wait_for_release = module._wait_for_release_disposition
        original_write_owned_drain = module._write_owned_drain
        def fail_release(*_args, **_kwargs):
            raise module.ControlError("simulated replacement release failure")
        def fail_rollback(*_args, **_kwargs):
            raise module.ControlError("simulated marker rollback failure")
        module._wait_for_release_disposition = fail_release
        module._write_owned_drain = fail_rollback
        try:
            module.complete_replacement(41, 902, 77, 903, token)
        except module.ControlError as error:
            if error.code != module.DRAIN_MARKER_ROLLBACK_FAILED_CODE:
                raise
            module._emit_control_error(error)
        else:
            raise AssertionError("release rollback unexpectedly succeeded")
        finally:
            module._wait_for_release_disposition = original_wait_for_release
            module._write_owned_drain = original_write_owned_drain
        delayed_one_shot_due_at = datetime.now(timezone.utc)
        if delayed_one_shot_due_at <= original_started_at:
            raise AssertionError("delayed one-shot time did not follow gate acquisition")
        module.recover_drain()
        print("ORIGINAL_GATE_START:" + original_started_at.isoformat())
        print("DELAYED_ONESHOT_DUE:" + delayed_one_shot_due_at.isoformat())
    elif scenario == "recover":
        module.begin_drain()
        status.payload["pid"] = 77
        status.payload["start_time"] = 903
        module.recover_drain()
    elif scenario == "recover-operator":
        module.begin_drain()
        drain.marker = {"principal": "operator"}
        status.payload["pid"] = 77
        status.payload["start_time"] = 903
        module.recover_drain()
    elif scenario == "recover-noop":
        module.recover_drain()
    else:
        raise RuntimeError(f"unknown scenario: {scenario}")
except module.ControlError as error:
    module._emit_control_error(error)
    raise SystemExit(1)
finally:
    print(f"OPERATOR_MUTATIONS:{drain.write_calls}:{drain.clear_calls}")
    print(
        "OWN_MARKER:"
        + ("present" if module._marker_path().exists() else "absent")
    )
    print(
        "RECOVERY_STATE:"
        + ("present" if module._release_recovery_path().exists() else "absent")
    )
    print(f"CRON_VALIDATIONS:{cron_validations}")
    print(f"DURABILITY_SYNCS:{durability_sync_calls}")
    print("REARM_CALLS:" + ",".join(rearm_calls))
    if drain.marker is not None:
        print("FINAL_MARKER:" + drain.marker["principal"])
`;

function writeJson(target: string, payload: unknown): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(payload));
}

function readMaxJobsBytes(source: string): number {
  const match = readFileSync(source, "utf8").match(
    /MAX_JOBS_BYTES\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/u,
  );
  assert(match, `MAX_JOBS_BYTES is missing from ${source}`);
  return Number(match[1]) * Number(match[2]) * Number(match[3]);
}

describe("Hermes in-sandbox cron restore validator", () => {
  let root: string;
  let hermesHome: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-cron-helper-"));
    hermesHome = path.join(root, ".hermes");
    mkdirSync(hermesHome);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function validateTree() {
    return spawnSync(
      process.env.PYTHON || "python3",
      ["-I", HELPER, "validate-tree", "--home", hermesHome, "--sandbox-home", root],
      { encoding: "utf8" },
    );
  }

  function validatorDecisions(): { host: boolean; sandbox: boolean } {
    let host = true;
    try {
      validateHermesCronRestoreBackup(hermesHome);
    } catch {
      host = false;
    }
    return { host, sandbox: validateTree().status === 0 };
  }

  function runLifecycle(
    scenario:
      | "success"
      | "wrong-identity"
      | "missing-marker"
      | "preserve-operator"
      | "concurrent-operator"
      | "existing-owned-marker"
      | "link-failure"
      | "symlink-owned-marker"
      | "hardlinked-owned-marker"
      | "unsafe-lock-metadata"
      | "replacement-owned-marker"
      | "rollback-operator"
      | "complete"
      | "complete-same-identity"
      | "complete-validation-failure"
      | "complete-substitution"
      | "complete-release-substitution"
      | "complete-release-failure"
      | "complete-release-rollback-failure"
      | "complete-durable-order"
      | "release-recovery-sync-failure"
      | "rearm-failure"
      | "existing-recovery-sync-failure"
      | "drain-unlink-sync-failure"
      | "recovery-unlink-sync-failure"
      | "rollback-publication-sync-failure"
      | "prepare-recovery-only"
      | "prepare-matching"
      | "prepare-matching-sync-failure"
      | "prepare-noop"
      | "prepare-existing-sync-failure"
      | "prepare-mismatch"
      | "prepare-recovery-unsafe-mode"
      | "prepare-recovery-symlink"
      | "prepare-recovery-hardlink"
      | "pending-release-recovery"
      | "mismatched-release-recovery"
      | "recover-release-rollback"
      | "recover-preserves-gate-start"
      | "recover"
      | "recover-operator"
      | "recover-noop",
  ) {
    return spawnSync(
      process.env.PYTHON || "python3",
      ["-I", "-c", LIFECYCLE_HARNESS, HELPER, scenario, hermesHome],
      { encoding: "utf8" },
    );
  }

  it("accepts complete active scripts and ignores disabled missing scripts", () => {
    writeJson(path.join(hermesHome, "cron", "jobs.json"), [
      { script: "collect.py" },
      { enabled: false, script: "missing.py" },
    ]);
    mkdirSync(path.join(hermesHome, "scripts"));
    writeFileSync(path.join(hermesHome, "scripts", "collect.py"), "print('ok')\n", {
      mode: 0o600,
    });

    expect(validateHermesCronRestoreBackup(hermesHome)).toEqual({
      activeJobs: 1,
      scriptJobs: 1,
      requiresDispatchGate: true,
    });
    const result = validateTree();

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      active_jobs: 1,
      profiles: 1,
      script_jobs: 1,
    });
  });

  it("keeps host and sandbox cron-store size limits equal", () => {
    expect(readMaxJobsBytes(HOST_VALIDATOR)).toBe(readMaxJobsBytes(HELPER));
  });

  it("keeps host and sandbox decisions aligned for missing scripts", () => {
    writeJson(path.join(hermesHome, "cron", "jobs.json"), [{ script: "missing.py" }]);
    mkdirSync(path.join(hermesHome, "scripts"));

    expect(validatorDecisions()).toEqual({ host: false, sandbox: false });
  });

  it("keeps host and sandbox decisions aligned for script symlinks", () => {
    writeJson(path.join(hermesHome, "cron", "jobs.json"), [{ script: "linked.py" }]);
    mkdirSync(path.join(hermesHome, "scripts"));
    const target = path.join(root, "outside.py");
    writeFileSync(target, "print('outside')\n", { mode: 0o600 });
    symlinkSync(target, path.join(hermesHome, "scripts", "linked.py"));

    expect(validatorDecisions()).toEqual({ host: false, sandbox: false });
  });

  it.runIf(process.platform === "linux" && existsSync("/dev/shm"))(
    "keeps host and sandbox decisions aligned on a mounted filesystem",
    () => {
      const mountedRoot = mkdtempSync("/dev/shm/nemoclaw-hermes-cron-");
      const priorRoot = root;
      const priorHome = hermesHome;
      try {
        root = mountedRoot;
        hermesHome = path.join(root, ".hermes");
        writeJson(path.join(hermesHome, "cron", "jobs.json"), [{ script: "mounted.py" }]);
        mkdirSync(path.join(hermesHome, "scripts"));
        writeFileSync(path.join(hermesHome, "scripts", "mounted.py"), "print('ok')\n", {
          mode: 0o600,
        });

        expect(validatorDecisions()).toEqual({ host: true, sandbox: true });
      } finally {
        root = priorRoot;
        hermesHome = priorHome;
        rmSync(mountedRoot, { recursive: true, force: true });
      }
    },
  );

  it("fails closed when an active script has no readable permission bits", () => {
    writeJson(path.join(hermesHome, "cron", "jobs.json"), [{ script: "private.py" }]);
    mkdirSync(path.join(hermesHome, "scripts"));
    const scriptPath = path.join(hermesHome, "scripts", "private.py");
    writeFileSync(scriptPath, "print('private')\n");
    chmodSync(scriptPath, 0o000);

    const result = validateTree();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("active job #1 script is not readable");
  });

  it("pins one gateway identity across begin, validation, and recovery", () => {
    const result = runLifecycle("success");

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const receipts = result.stdout
      .split("\n")
      .filter((line) => line.startsWith(RECEIPT_PREFIX))
      .map((line) => JSON.parse(line.slice(RECEIPT_PREFIX.length)));
    expect(receipts.map((receipt) => receipt.action)).toEqual(["begin", "validate", "recover"]);
    expect(receipts.map((receipt) => receipt.disposition)).toEqual([
      "drain-acquired",
      "restore-validated",
      "dispatch-reactivated",
    ]);
    expect(receipts[0].drain_token).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    expect(receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pid: 41, start_time: 902 }),
        expect.objectContaining({ active_jobs: 1, profiles: 1, script_jobs: 1 }),
      ]),
    );
    expect(result.stdout).toContain("OPERATOR_MUTATIONS:0:0");
    expect(result.stdout).toContain("OWN_MARKER:absent");
    expect(result.stdout).toMatch(/REARM_CALLS:[^\n]+/u);
    expect(receipts.at(-1)).toMatchObject({ rearmed_oneshots: 1 });
  });

  it("rejects validation against a different gateway identity", () => {
    const result = runLifecycle("wrong-identity");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("gateway identity changed during cron restore");
  });

  it("rejects release after the drain marker disappears", () => {
    const result = runLifecycle("missing-marker");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("drain marker is not active");
    expect(result.stdout).toContain("OWN_MARKER:absent");
  });

  it("preserves an operator-owned drain across begin, validation, and release", () => {
    const result = runLifecycle("preserve-operator");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("FINAL_MARKER:operator");
    expect(result.stdout).toContain("OPERATOR_MUTATIONS:0:0");
    expect(result.stdout).toContain("OWN_MARKER:absent");
    const receipts = result.stdout
      .split("\n")
      .filter((line) => line.startsWith(RECEIPT_PREFIX))
      .map((line) => JSON.parse(line.slice(RECEIPT_PREFIX.length)));
    expect(receipts).toHaveLength(3);
    expect(receipts.every((receipt) => receipt.drain_acquired === true)).toBe(true);
    expect(receipts.every((receipt) => typeof receipt.drain_token === "string")).toBe(true);
    expect(receipts.at(-1)).toEqual(
      expect.objectContaining({
        disposition: "operator-drain-preserved",
        operator_drain_active: true,
        preserved_drain: true,
      }),
    );
  });

  it("preserves an operator drain created before release", () => {
    const result = runLifecycle("concurrent-operator");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("FINAL_MARKER:operator");
    expect(result.stdout).toContain("OPERATOR_MUTATIONS:0:0");
    expect(result.stdout).toContain('"disposition":"operator-drain-preserved"');
    expect(result.stdout).toContain("OWN_MARKER:absent");
  });

  it("fails closed without replacing a prior NemoClaw drain", () => {
    const result = runLifecycle("existing-owned-marker");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already requires recovery");
    expect(result.stdout).toContain("OPERATOR_MUTATIONS:0:0");
    expect(result.stdout).toContain("OWN_MARKER:present");
  });

  it("fails closed when atomic drain acquisition is unavailable", () => {
    const result = runLifecycle("link-failure");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("drain could not be acquired");
    expect(result.stdout).toContain("OPERATOR_MUTATIONS:0:0");
    expect(result.stdout).toContain("OWN_MARKER:absent");
  });

  it("fails closed when the drain marker is replaced by a symlink", () => {
    const result = runLifecycle("symlink-owned-marker");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("drain marker is unreadable");
    expect(result.stdout).toContain("OWN_MARKER:present");
  });

  it("fails closed when the drain marker gains another hard link", () => {
    const result = runLifecycle("hardlinked-owned-marker");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("drain marker metadata is unsafe");
    expect(result.stdout).toContain("OWN_MARKER:present");
  });

  it("fails closed when the root control lock has unsafe metadata", () => {
    const result = runLifecycle("unsafe-lock-metadata");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("control lock metadata is unsafe");
    expect(result.stdout).toContain("OWN_MARKER:absent");
  });

  it("does not release a NemoClaw marker with a different token", () => {
    const result = runLifecycle("replacement-owned-marker");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("drain ownership changed");
    expect(result.stdout).toContain("OPERATOR_MUTATIONS:0:0");
    expect(result.stdout).toContain("OWN_MARKER:present");
  });

  it("restores its marker without mutating an operator drain after failed release", () => {
    const result = runLifecycle("rollback-operator");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("simulated reactivation failure");
    expect(result.stdout).toContain("FINAL_MARKER:operator");
    expect(result.stdout).toContain("OPERATOR_MUTATIONS:0:0");
    expect(result.stdout).toContain("OWN_MARKER:present");
  });

  it("keeps the owned drain through gateway replacement and releases the validated replacement (#8472)", () => {
    const result = runLifecycle("complete");

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const receipts = result.stdout
      .split("\n")
      .filter((line) => line.startsWith(RECEIPT_PREFIX))
      .map((line) => JSON.parse(line.slice(RECEIPT_PREFIX.length)));
    expect(receipts.map((receipt) => receipt.action)).toEqual([
      "begin",
      "validate",
      "observe",
      "complete",
    ]);
    expect(receipts.at(-1)).toEqual(
      expect.objectContaining({
        active_jobs: 1,
        disposition: "dispatch-reactivated",
        pid: 77,
        profiles: 1,
        script_jobs: 1,
        start_time: 903,
      }),
    );
    expect(result.stdout).toContain("OWN_MARKER:absent");
  });

  it("keeps dispatch drained when the gateway identity was not replaced (#8472)", () => {
    const result = runLifecycle("complete-same-identity");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("gateway identity did not change during cron restore");
    expect(result.stdout).toContain("OPERATOR_MUTATIONS:0:0");
    expect(result.stdout).toContain("FINAL_MARKER:operator");
    expect(result.stdout).toContain("OWN_MARKER:present");
  });

  it("keeps dispatch drained when replacement validation fails (#8472)", () => {
    const result = runLifecycle("complete-validation-failure");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("replacement cron tree is invalid");
    expect(result.stdout).toContain("OPERATOR_MUTATIONS:0:0");
    expect(result.stdout).toContain("FINAL_MARKER:operator");
    expect(result.stdout).toContain("OWN_MARKER:present");
  });

  it("keeps dispatch drained when the health-bound replacement is substituted (#8472)", () => {
    const result = runLifecycle("complete-substitution");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("gateway identity changed during cron restore");
    expect(result.stdout).toContain("OPERATOR_MUTATIONS:0:0");
    expect(result.stdout).toContain("FINAL_MARKER:operator");
    expect(result.stdout).toContain("OWN_MARKER:present");
  });

  it("keeps the drain marker when substitution races final release (#8472)", () => {
    const result = runLifecycle("complete-release-substitution");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("gateway identity changed during cron restore");
    expect(result.stdout).toContain("OPERATOR_MUTATIONS:0:0");
    expect(result.stdout).toContain("FINAL_MARKER:operator");
    expect(result.stdout).toContain("OWN_MARKER:present");
  });

  it("restores the drain marker when replacement release verification fails (#8472)", () => {
    const result = runLifecycle("complete-release-failure");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("simulated replacement release failure");
    expect(result.stdout).toContain("OPERATOR_MUTATIONS:0:0");
    expect(result.stdout).toContain("FINAL_MARKER:operator");
    expect(result.stdout).toContain("OWN_MARKER:present");
  });

  it("emits the structured rollback-failure code when its marker cannot be restored (#8472)", () => {
    const result = runLifecycle("complete-release-rollback-failure");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "HERMES_CRON_RESTORE_ERROR: Hermes cron restore drain release failed and its marker could not be restored",
    );
    const signals = result.stderr
      .split(/\r?\n/u)
      .filter((line) => line.startsWith(CONTROL_ERROR_PREFIX));
    expect(signals).toHaveLength(1);
    expect(JSON.parse(signals[0].slice(CONTROL_ERROR_PREFIX.length))).toEqual({
      code: HERMES_CRON_RESTORE_DRAIN_MARKER_ROLLBACK_FAILED_CODE,
      message: "Hermes cron restore drain release failed and its marker could not be restored",
    });
    expect(result.stdout).toContain("OWN_MARKER:absent");
    expect(result.stdout).toContain("RECOVERY_STATE:present");
  });

  it("durably publishes recovery authority before deleting the drain marker (#8472)", () => {
    const result = runLifecycle("complete-durable-order");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "RELEASE_EVENTS:recovery-write-started,recovery-write-durable,drain-delete-started,drain-delete-durable",
    );
    expect(result.stdout).toContain("OWN_MARKER:absent");
    expect(result.stdout).toContain("RECOVERY_STATE:absent");
  });

  it("keeps the active marker when recovery-record durability fails (#8472)", () => {
    const result = runLifecycle("release-recovery-sync-failure");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("simulated state directory durability failure");
    expect(result.stdout).toContain("OWN_MARKER:present");
    expect(result.stdout).toContain("RECOVERY_STATE:present");
    expect(result.stdout).toContain("DURABILITY_SYNCS:1");
    expect(result.stdout).not.toContain('"action":"complete"');
  });

  it("keeps dispatch drained when delayed one-shots cannot be re-armed (#8472)", () => {
    const result = runLifecycle("rearm-failure");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Hermes cron restore could not re-arm delayed one-shots");
    expect(result.stdout).toContain("OWN_MARKER:present");
    expect(result.stdout).toContain("RECOVERY_STATE:present");
    expect(result.stdout).not.toContain('"action":"recover"');
  });

  it("rechecks existing recovery-record durability before marker deletion (#8472)", () => {
    const result = runLifecycle("existing-recovery-sync-failure");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("simulated state directory durability failure");
    expect(result.stdout).toContain("OWN_MARKER:present");
    expect(result.stdout).toContain("RECOVERY_STATE:present");
    expect(result.stdout).toContain("DURABILITY_SYNCS:1");
    expect(result.stdout).not.toContain('"action":"complete"');
  });

  it("restores the marker when its durable deletion cannot be proved (#8472)", () => {
    const result = runLifecycle("drain-unlink-sync-failure");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("simulated state directory durability failure");
    expect(result.stdout).toContain("OWN_MARKER:present");
    expect(result.stdout).toContain("RECOVERY_STATE:present");
    expect(result.stdout).toContain("DURABILITY_SYNCS:3");
    expect(result.stdout).not.toContain('"action":"complete"');
  });

  it("restores the marker when recovery-state deletion is not durable (#8472)", () => {
    const result = runLifecycle("recovery-unlink-sync-failure");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("release recovery could not be cleared");
    expect(result.stdout).toContain("OWN_MARKER:present");
    expect(result.stdout).toContain("RECOVERY_STATE:absent");
    expect(result.stdout).toContain("DURABILITY_SYNCS:4");
    expect(result.stdout).not.toContain('"action":"complete"');
  });

  it("does not report success when rollback publication is not durable (#8472)", () => {
    const result = runLifecycle("rollback-publication-sync-failure");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("drain release failed and its marker could not be restored");
    expect(result.stderr).toContain(
      `"code":"${HERMES_CRON_RESTORE_DRAIN_MARKER_ROLLBACK_FAILED_CODE}"`,
    );
    expect(result.stdout).toContain("OWN_MARKER:present");
    expect(result.stdout).toContain("RECOVERY_STATE:present");
    expect(result.stdout).toContain("DURABILITY_SYNCS:3");
    expect(result.stdout).not.toContain('"action":"complete"');
  });

  it("reacquires recovery authority without touching the gateway or cron tree (#8472)", () => {
    const result = runLifecycle("prepare-recovery-only");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain('"action":"prepare-recover"');
    expect(result.stdout).toContain('"disposition":"gate-prepared"');
    expect(result.stdout).toContain('"drain_acquired":true');
    expect(result.stdout).toContain("OWN_MARKER:present");
    expect(result.stdout).toContain("RECOVERY_STATE:present");
    expect(result.stdout).toContain("CRON_VALIDATIONS:0");
  });

  it("keeps matching prepared recovery authority idempotent (#8472)", () => {
    const result = runLifecycle("prepare-matching");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain('"disposition":"gate-prepared"');
    expect(result.stdout).toContain("OWN_MARKER:present");
    expect(result.stdout).toContain("RECOVERY_STATE:present");
    expect(result.stdout).toContain("CRON_VALIDATIONS:0");
  });

  it("blocks gateway preparation when matching recovery authority durability is unproved (#8472)", () => {
    const result = runLifecycle("prepare-matching-sync-failure");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("simulated state directory durability failure");
    expect(result.stdout).not.toContain('"action":"prepare-recover"');
    expect(result.stdout).toContain("OWN_MARKER:present");
    expect(result.stdout).toContain("RECOVERY_STATE:present");
    expect(result.stdout).toContain("DURABILITY_SYNCS:1");
    expect(result.stdout).toContain("CRON_VALIDATIONS:0");
  });

  it("returns a typed no-op when no recovery authority exists (#8472)", () => {
    const result = runLifecycle("prepare-noop");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain('"action":"prepare-recover"');
    expect(result.stdout).toContain('"disposition":"not-required"');
    expect(result.stdout).toContain('"drain_acquired":false');
    expect(result.stdout).toContain("OWN_MARKER:absent");
    expect(result.stdout).toContain("RECOVERY_STATE:absent");
    expect(result.stdout).toContain("CRON_VALIDATIONS:0");
  });

  it("blocks gateway preparation when existing marker durability is unproved (#8472)", () => {
    const result = runLifecycle("prepare-existing-sync-failure");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("simulated state directory durability failure");
    expect(result.stdout).not.toContain('"action":"prepare-recover"');
    expect(result.stdout).toContain("OWN_MARKER:present");
    expect(result.stdout).toContain("RECOVERY_STATE:absent");
    expect(result.stdout).toContain("DURABILITY_SYNCS:1");
  });

  it("fails preparation when recovery owners differ (#8472)", () => {
    const result = runLifecycle("prepare-mismatch");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("drain and release recovery ownership differ");
    expect(result.stdout).not.toContain('"action":"prepare-recover"');
    expect(result.stdout).toContain("OWN_MARKER:present");
    expect(result.stdout).toContain("RECOVERY_STATE:present");
    expect(result.stdout).toContain("CRON_VALIDATIONS:0");
  });

  it.each([
    ["prepare-recovery-unsafe-mode", "metadata is unsafe"],
    ["prepare-recovery-symlink", "is unreadable"],
    ["prepare-recovery-hardlink", "metadata is unsafe"],
  ] as const)("rejects unsafe recovery authority in %s (#8472)", (scenario, message) => {
    const result = runLifecycle(scenario);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stdout).not.toContain('"action":"prepare-recover"');
    expect(result.stdout).toContain("OWN_MARKER:absent");
    expect(result.stdout).toContain("RECOVERY_STATE:present");
    expect(result.stdout).toContain("CRON_VALIDATIONS:0");
  });

  it("blocks a new drain while release recovery remains pending (#8472)", () => {
    const result = runLifecycle("pending-release-recovery");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("release recovery already requires recovery");
    expect(result.stdout).toContain("OWN_MARKER:absent");
    expect(result.stdout).toContain("RECOVERY_STATE:present");
  });

  it("fails closed when the drain and release recovery owners differ (#8472)", () => {
    const result = runLifecycle("mismatched-release-recovery");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("drain and release recovery ownership differ");
    expect(result.stdout).toContain("OWN_MARKER:present");
    expect(result.stdout).toContain("RECOVERY_STATE:present");
    expect(result.stdout).toContain("CRON_VALIDATIONS:0");
  });

  it("reacquires and validates the gate from release recovery state (#8472)", () => {
    const result = runLifecycle("recover-release-rollback");

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "HERMES_CRON_RESTORE_ERROR: Hermes cron restore drain release failed and its marker could not be restored",
    );
    const receipts = result.stdout
      .split("\n")
      .filter((line) => line.startsWith(RECEIPT_PREFIX))
      .map((line) => JSON.parse(line.slice(RECEIPT_PREFIX.length)));
    expect(receipts.map((receipt) => receipt.action)).toEqual([
      "begin",
      "validate",
      "observe",
      "recover",
    ]);
    expect(receipts.at(-1)).toEqual(
      expect.objectContaining({
        active_jobs: 1,
        disposition: "dispatch-reactivated",
        profiles: 1,
        script_jobs: 1,
      }),
    );
    expect(result.stdout).toContain("CRON_VALIDATIONS:3");
    expect(result.stdout).toContain("OWN_MARKER:absent");
    expect(result.stdout).toContain("RECOVERY_STATE:absent");
  });

  it("retains the original gate time when recovery recreates the drain marker (#8472)", () => {
    const result = runLifecycle("recover-preserves-gate-start");

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "Hermes cron restore drain release failed and its marker could not be restored",
    );
    const originalGateStart = result.stdout.match(/^ORIGINAL_GATE_START:(.+)$/mu)?.[1];
    const rearmCalls = result.stdout.match(/^REARM_CALLS:(.+)$/mu)?.[1].split(",");
    expect(originalGateStart).toBeTruthy();
    expect(rearmCalls).toEqual([originalGateStart, originalGateStart]);
    const receipts = result.stdout
      .split("\n")
      .filter((line) => line.startsWith(RECEIPT_PREFIX))
      .map((line) => JSON.parse(line.slice(RECEIPT_PREFIX.length)));
    expect(receipts.at(-1)).toEqual(
      expect.objectContaining({
        action: "recover",
        disposition: "dispatch-reactivated",
        rearmed_oneshots: 1,
      }),
    );
    expect(result.stdout).toContain("ORIGINAL_GATE_START:");
    expect(result.stdout).toContain("DELAYED_ONESHOT_DUE:");
    expect(result.stdout).toContain("OWN_MARKER:absent");
    expect(result.stdout).toContain("RECOVERY_STATE:absent");
  });

  it("re-pins a restarted gateway before validating and reactivating dispatch", () => {
    const result = runLifecycle("recover");

    expect(result.status).toBe(0);
    const receipts = result.stdout
      .split("\n")
      .filter((line) => line.startsWith(RECEIPT_PREFIX))
      .map((line) => JSON.parse(line.slice(RECEIPT_PREFIX.length)));
    expect(receipts.map((receipt) => receipt.action)).toEqual(["begin", "recover"]);
    expect(receipts.at(-1)).toEqual(
      expect.objectContaining({
        active_jobs: 1,
        disposition: "dispatch-reactivated",
        pid: 77,
        profiles: 1,
        script_jobs: 1,
        start_time: 903,
      }),
    );
    expect(result.stdout).toContain("OWN_MARKER:absent");
  });

  it("removes only its marker when recovery finds an operator drain", () => {
    const result = runLifecycle("recover-operator");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"action":"recover"');
    expect(result.stdout).toContain('"disposition":"operator-drain-preserved"');
    expect(result.stdout).toContain("FINAL_MARKER:operator");
    expect(result.stdout).toContain("OPERATOR_MUTATIONS:0:0");
    expect(result.stdout).toContain("OWN_MARKER:absent");
  });

  it("reports that recovery is not required when its marker is absent", () => {
    const result = runLifecycle("recover-noop");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"action":"recover"');
    expect(result.stdout).toContain('"disposition":"not-required"');
    expect(result.stdout).toContain('"drain_acquired":false');
    expect(result.stdout).not.toContain('"drain_token"');
    expect(result.stdout).toContain("OPERATOR_MUTATIONS:0:0");
    expect(result.stdout).toContain("OWN_MARKER:absent");
  });
});
