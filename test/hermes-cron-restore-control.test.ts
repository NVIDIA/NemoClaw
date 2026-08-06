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
import { validateHermesCronRestoreBackup } from "../src/lib/state/rebuild/hermes-cron-restore-backup";

const HELPER = path.resolve("agents/hermes/cron-restore-control.py");
const HOST_VALIDATOR = path.resolve("src/lib/state/rebuild/hermes-cron-restore-backup.ts");
const RECEIPT_PREFIX = "NEMOCLAW_HERMES_CRON_RESTORE_V1:";
const LIFECYCLE_HARNESS = String.raw`
import importlib.util
import os
import sys
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
module.validate_cron_tree = lambda: {
    "profiles": 1,
    "active_jobs": 1,
    "script_jobs": 1,
}

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

try:
    if scenario == "success":
        token = module.begin_drain()
        module.validate_restore(41, 902, token)
        module.release_drain(41, 902, token)
    elif scenario == "wrong-identity":
        token = module.begin_drain()
        module.validate_restore(42, 902, token)
    elif scenario == "missing-marker":
        token = module.begin_drain()
        module._marker_path().unlink()
        module.release_drain(41, 902, token)
    elif scenario == "preserve-operator":
        drain.marker = {"principal": "operator"}
        token = module.begin_drain()
        module.validate_restore(41, 902, token)
        module.release_drain(41, 902, token)
    elif scenario == "concurrent-operator":
        token = module.begin_drain()
        module.validate_restore(41, 902, token)
        drain.marker = {"principal": "operator"}
        module.release_drain(41, 902, token)
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
        module.release_drain(41, 902, token)
    elif scenario == "hardlinked-owned-marker":
        token = module.begin_drain()
        marker = module._marker_path()
        held = module.NEMOCLAW_HOME / "held-marker.json"
        os.link(marker, held)
        module.release_drain(41, 902, token)
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
        module.release_drain(41, 902, token)
    elif scenario == "rollback-operator":
        token = module.begin_drain()
        module.validate_restore(41, 902, token)
        def fail_after_operator_drain(*_args, **_kwargs):
            drain.marker = {"principal": "operator"}
            raise module.ControlError("simulated reactivation failure")
        module._wait_for_release_disposition = fail_after_operator_drain
        module.release_drain(41, 902, token)
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
    print(str(error), file=sys.stderr)
    raise SystemExit(1)
finally:
    print(f"OPERATOR_MUTATIONS:{drain.write_calls}:{drain.clear_calls}")
    print(
        "OWN_MARKER:"
        + ("present" if module._marker_path().exists() else "absent")
    )
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

  it("pins one gateway identity across begin, validation, and release", () => {
    const result = runLifecycle("success");

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const receipts = result.stdout
      .split("\n")
      .filter((line) => line.startsWith(RECEIPT_PREFIX))
      .map((line) => JSON.parse(line.slice(RECEIPT_PREFIX.length)));
    expect(receipts.map((receipt) => receipt.action)).toEqual(["begin", "validate", "release"]);
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
