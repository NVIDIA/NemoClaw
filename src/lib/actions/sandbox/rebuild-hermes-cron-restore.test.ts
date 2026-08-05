// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateHermesCronRestoreBackup } from "../../state/rebuild/hermes-cron-restore-backup";

const processMocks = vi.hoisted(() => ({
  dockerSpawnSync: vi.fn(),
  privilegedSandboxExecArgv: vi.fn((_sandboxName: string, command: string[]) => [
    "exec",
    "container-id",
    ...command,
  ]),
}));

vi.mock("../../adapters/docker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/docker")>()),
  dockerSpawnSync: processMocks.dockerSpawnSync,
}));

vi.mock("../../sandbox/privileged-exec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sandbox/privileged-exec")>()),
  isDirectSandboxFallbackUnavailableError: () => false,
  privilegedSandboxExecArgv: processMocks.privilegedSandboxExecArgv,
}));

import {
  beginHermesCronRestore,
  recoverHermesCronRestore,
  releaseHermesCronRestore,
  runHermesCronRestoreTransaction,
  validateHermesCronRestore,
} from "./rebuild-hermes-post-restore";

const RECEIPT_PREFIX = "NEMOCLAW_HERMES_CRON_RESTORE_V1:";

function writeJson(target: string, payload: unknown): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(payload));
}

function writeScript(target: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, "print('ok')\n", { mode: 0o600 });
}

type ReceiptAction = "begin" | "validate" | "release" | "recover";

function receipt(
  action: ReceiptAction,
  pid = 41,
  startTime = 902,
  drainToken = "restore-token",
  overrides: Record<string, unknown> = {},
): string {
  const actionFields: Record<ReceiptAction, Record<string, unknown>> = {
    begin: {
      active_agents: 0,
      disposition: "drain-acquired",
      operator_drain_active: false,
    },
    validate: {
      active_jobs: 1,
      disposition: "restore-validated",
      operator_drain_active: false,
      profiles: 1,
      script_jobs: 1,
    },
    release: {
      active_agents: 0,
      disposition: "dispatch-reactivated",
      operator_drain_active: false,
      preserved_drain: false,
    },
    recover: {
      active_agents: 0,
      active_jobs: 1,
      disposition: "dispatch-reactivated",
      operator_drain_active: false,
      preserved_drain: false,
      profiles: 1,
      script_jobs: 1,
    },
  };
  return `${RECEIPT_PREFIX}${JSON.stringify({
    version: 1,
    action,
    pid,
    start_time: startTime,
    drain_acquired: true,
    drain_token: drainToken,
    ...actionFields[action],
    ...overrides,
  })}`;
}

function notRequiredRecoveryReceipt(overrides: Record<string, unknown> = {}): string {
  return `${RECEIPT_PREFIX}${JSON.stringify({
    version: 1,
    action: "recover",
    pid: 41,
    start_time: 902,
    drain_acquired: false,
    active_agents: 0,
    disposition: "not-required",
    operator_drain_active: false,
    preserved_drain: false,
    ...overrides,
  })}`;
}

describe("Hermes cron rebuild restore contract", () => {
  let backupPath: string;

  beforeEach(() => {
    processMocks.dockerSpawnSync.mockReset();
    processMocks.privilegedSandboxExecArgv.mockClear();
    backupPath = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-cron-"));
  });

  afterEach(() => {
    rmSync(backupPath, { recursive: true, force: true });
  });

  it("validates active default and named-profile scripts before deletion", () => {
    writeJson(path.join(backupPath, "cron", "jobs.json"), {
      jobs: [
        { enabled: true, script: "collect.py" },
        { enabled: false, script: "disabled-missing.py" },
        { state: "paused", script: "paused-missing.py" },
      ],
    });
    writeScript(path.join(backupPath, "scripts", "collect.py"));
    writeJson(path.join(backupPath, "profiles", "research", "cron", "jobs.json"), [
      {
        script: "/sandbox/.hermes/profiles/research/scripts/report.sh",
      },
    ]);
    writeScript(path.join(backupPath, "profiles", "research", "scripts", "report.sh"));

    expect(validateHermesCronRestoreBackup(backupPath)).toEqual({
      activeJobs: 2,
      scriptJobs: 2,
      requiresDispatchGate: true,
    });
  });

  it("blocks a backup whose active job script is absent", () => {
    writeJson(path.join(backupPath, "cron", "jobs.json"), [{ script: "missing.py" }]);
    mkdirSync(path.join(backupPath, "scripts"));

    expect(() => validateHermesCronRestoreBackup(backupPath)).toThrow(
      "active job #1 script is missing or unreadable",
    );
  });

  it("blocks unreadable and escaping script inputs", () => {
    writeJson(path.join(backupPath, "cron", "jobs.json"), [{ script: "private.py" }]);
    const scriptPath = path.join(backupPath, "scripts", "private.py");
    writeScript(scriptPath);
    chmodSync(scriptPath, 0o000);

    expect(() => validateHermesCronRestoreBackup(backupPath)).toThrow(
      "active job #1 script is not readable",
    );

    chmodSync(scriptPath, 0o600);
    writeJson(path.join(backupPath, "cron", "jobs.json"), [{ script: "/tmp/outside.py" }]);
    expect(() => validateHermesCronRestoreBackup(backupPath)).toThrow(
      "script path resolves outside",
    );
  });

  it("binds validation and release to the begin receipt identity", () => {
    processMocks.dockerSpawnSync.mockImplementation((argv: string[]) => {
      const action = argv.includes("validate")
        ? "validate"
        : argv.includes("release")
          ? "release"
          : "begin";
      return { status: 0, stdout: receipt(action), stderr: "" };
    });

    const identity = beginHermesCronRestore("alpha");
    validateHermesCronRestore("alpha", identity);
    releaseHermesCronRestore("alpha", identity);

    expect(identity).toEqual({ pid: 41, start_time: 902, drain_token: "restore-token" });
    expect(processMocks.privilegedSandboxExecArgv).toHaveBeenCalledTimes(3);
    expect(processMocks.privilegedSandboxExecArgv.mock.calls[1]?.[1]).toEqual([
      "/opt/hermes/.venv/bin/python",
      "-I",
      "/usr/local/lib/nemoclaw/hermes-cron-restore-control.py",
      "validate",
      "--pid",
      "41",
      "--start-time",
      "902",
      "--drain-token",
      "restore-token",
    ]);
    expect(processMocks.privilegedSandboxExecArgv.mock.calls[2]?.[1]).toContain("release");
  });

  it("passes an untrusted drain token as one argv value", () => {
    const untrustedToken = "restore-token'; touch /tmp/advisor-owned; #";
    processMocks.dockerSpawnSync.mockImplementation((argv: string[]) => ({
      status: 0,
      stdout: receipt(argv.includes("validate") ? "validate" : "begin", 41, 902, untrustedToken),
      stderr: "",
    }));

    const identity = beginHermesCronRestore("alpha");
    validateHermesCronRestore("alpha", identity);

    const validateArgv = processMocks.privilegedSandboxExecArgv.mock.calls[1]?.[1];
    expect(validateArgv?.at(-1)).toBe(untrustedToken);
  });

  it("rejects a control receipt that changes gateway identity", () => {
    processMocks.dockerSpawnSync.mockReturnValue({
      status: 0,
      stdout: receipt("release", 42, 902),
      stderr: "",
    });

    expect(() => releaseHermesCronRestore("alpha", { pid: 41, start_time: 902 })).toThrow(
      "changed gateway identity",
    );
  });

  it("keeps dispatch drained when state restore is incomplete", () => {
    processMocks.dockerSpawnSync.mockReturnValue({
      status: 0,
      stdout: receipt("begin"),
      stderr: "",
    });

    expect(() =>
      runHermesCronRestoreTransaction("alpha", () => ({ restoreSucceeded: false })),
    ).toThrow("state restore was incomplete");
    expect(processMocks.dockerSpawnSync).toHaveBeenCalledOnce();
    expect(processMocks.privilegedSandboxExecArgv.mock.calls[0]?.[1]).toContain("begin");
  });

  it("orders drain, restore, validation, and release", () => {
    const events: string[] = [];
    processMocks.dockerSpawnSync.mockImplementation((argv: string[]) => {
      const action = argv.includes("validate")
        ? "validate"
        : argv.includes("release")
          ? "release"
          : "begin";
      events.push(action);
      return { status: 0, stdout: receipt(action), stderr: "" };
    });

    runHermesCronRestoreTransaction(
      "alpha",
      () => {
        events.push("restore");
        return { restoreSucceeded: true };
      },
      (state) => events.push(state),
    );

    expect(events).toEqual(["begin", "acquired", "restore", "validate", "release", "released"]);
  });
  it.each([
    ["dispatch-reactivated", false],
    ["operator-drain-preserved", true],
  ] as const)("returns the %s recovery disposition", (disposition, operatorDrainActive) => {
    processMocks.dockerSpawnSync.mockReturnValue({
      status: 0,
      stdout: receipt("recover", 41, 902, "restore-token", {
        disposition,
        operator_drain_active: operatorDrainActive,
        preserved_drain: operatorDrainActive,
      }),
      stderr: "",
    });

    expect(recoverHermesCronRestore("alpha")).toBe(disposition);
    expect(processMocks.privilegedSandboxExecArgv).toHaveBeenCalledWith(
      "alpha",
      [
        "/opt/hermes/.venv/bin/python",
        "-I",
        "/usr/local/lib/nemoclaw/hermes-cron-restore-control.py",
        "recover",
      ],
      false,
      true,
    );
  });

  it("composes the recovery transport budget from every controller phase (#7806)", () => {
    processMocks.dockerSpawnSync.mockImplementation((argv: string[]) => ({
      status: 0,
      stdout: receipt(argv.includes("recover") ? "recover" : "begin"),
      stderr: "",
    }));

    beginHermesCronRestore("alpha");
    recoverHermesCronRestore("alpha");

    expect(processMocks.dockerSpawnSync.mock.calls[0]?.[1]).toMatchObject({ timeout: 70_000 });
    expect(processMocks.dockerSpawnSync.mock.calls[1]?.[1]).toMatchObject({ timeout: 130_000 });
  });

  it("returns not-required when no NemoClaw recovery gate exists", () => {
    processMocks.dockerSpawnSync.mockReturnValue({
      status: 0,
      stdout: notRequiredRecoveryReceipt(),
      stderr: "",
    });

    expect(recoverHermesCronRestore("alpha")).toBe("not-required");
  });

  it("accepts not-required while preserving an independent operator drain", () => {
    processMocks.dockerSpawnSync.mockReturnValue({
      status: 0,
      stdout: notRequiredRecoveryReceipt({
        operator_drain_active: true,
        preserved_drain: true,
      }),
      stderr: "",
    });

    expect(recoverHermesCronRestore("alpha")).toBe("not-required");
  });

  it("rejects an inconsistent recovery receipt", () => {
    processMocks.dockerSpawnSync.mockReturnValue({
      status: 0,
      stdout: receipt("recover", 41, 902, "restore-token", {
        disposition: "operator-drain-preserved",
        operator_drain_active: true,
        preserved_drain: false,
      }),
      stderr: "",
    });

    expect(() => recoverHermesCronRestore("alpha")).toThrow("receipt failed validation");
  });

  it.each([
    `/opt/hermes/.venv/bin/python: can't open file '/usr/local/lib/nemoclaw/hermes-cron-restore-control.py': [Errno 2] No such file or directory`,
    "hermes-cron-restore-control.py: error: argument action: invalid choice: 'recover'",
  ])("keeps recovery compatible with a legacy Hermes sandbox: %s", (stderr) => {
    processMocks.dockerSpawnSync.mockReturnValue({ status: 2, stdout: "", stderr });

    expect(recoverHermesCronRestore("alpha")).toBe("unsupported");
  });

  it("does not hide a current controller recovery failure", () => {
    processMocks.dockerSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "Hermes cron restore drain marker is invalid",
    });

    expect(() => recoverHermesCronRestore("alpha")).toThrow(
      "Hermes cron recover failed: Hermes cron restore drain marker is invalid",
    );
  });
});
