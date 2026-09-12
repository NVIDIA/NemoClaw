// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateHermesCronRestoreBackup } from "../../state/rebuild/hermes-cron-restore-backup";

const processMocks = vi.hoisted(() => ({
  executePrivilegedSandboxCommand: vi.fn(),
}));

vi.mock("./process-recovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./process-recovery")>()),
  executePrivilegedSandboxCommand: processMocks.executePrivilegedSandboxCommand,
}));

import {
  beginHermesCronRestore,
  completeHermesCronRestoreAfterGatewayReplacement,
  HERMES_CRON_RESTORE_DRAIN_MARKER_ROLLBACK_FAILED_CODE,
  isHermesCronRestoreDrainMarkerRollbackFailure,
  observeHermesCronReplacement,
  prepareHermesCronRestoreRecovery,
  recoverHermesCronRestore,
  runHermesCronRestoreTransaction,
  validateHermesCronRestore,
} from "./rebuild-hermes-post-restore";

const RECEIPT_PREFIX = "NEMOCLAW_HERMES_CRON_RESTORE_V1:";
const CONTROL_ERROR_PREFIX = "NEMOCLAW_HERMES_CRON_RESTORE_ERROR_V1:";

function writeJson(target: string, payload: unknown): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(payload));
}

function writeScript(target: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, "print('ok')\n", { mode: 0o600 });
}

type ReceiptAction = "begin" | "validate" | "observe" | "complete" | "recover";

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
    observe: {
      active_agents: 0,
      disposition: "replacement-observed",
      operator_drain_active: false,
    },
    complete: {
      active_agents: 0,
      active_jobs: 1,
      disposition: "dispatch-reactivated",
      operator_drain_active: false,
      preserved_drain: false,
      profiles: 1,
      rearmed_oneshots: 1,
      script_jobs: 1,
    },
    recover: {
      active_agents: 0,
      active_jobs: 1,
      disposition: "dispatch-reactivated",
      operator_drain_active: false,
      preserved_drain: false,
      profiles: 1,
      rearmed_oneshots: 1,
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

function completionFailure(stderr: string): unknown {
  processMocks.executePrivilegedSandboxCommand.mockReturnValue({ status: 1, stdout: "", stderr });
  try {
    completeHermesCronRestoreAfterGatewayReplacement(
      "alpha",
      { pid: 41, start_time: 902, drain_token: "restore-token" },
      { pid: 77, start_time: 903, drain_token: "restore-token" },
    );
  } catch (error) {
    return error;
  }
  throw new Error("Hermes cron completion unexpectedly succeeded");
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

function preparationReceipt(
  disposition: "gate-prepared" | "not-required",
  overrides: Record<string, unknown> = {},
): string {
  return `${RECEIPT_PREFIX}${JSON.stringify({
    version: 1,
    action: "prepare-recover",
    drain_acquired: disposition === "gate-prepared",
    disposition,
    ...overrides,
  })}`;
}

describe("Hermes cron rebuild restore contract", () => {
  let backupPath: string;

  beforeEach(() => {
    processMocks.executePrivilegedSandboxCommand.mockReset();
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

  it("binds validation to the begin receipt identity", () => {
    processMocks.executePrivilegedSandboxCommand.mockImplementation(
      (_sandboxName: string, argv: string[]) => {
        const action = argv.includes("validate") ? "validate" : "begin";
        return { status: 0, stdout: receipt(action), stderr: "" };
      },
    );

    const identity = beginHermesCronRestore("alpha");
    validateHermesCronRestore("alpha", identity);

    expect(identity).toEqual({ pid: 41, start_time: 902, drain_token: "restore-token" });
    expect(processMocks.executePrivilegedSandboxCommand).toHaveBeenCalledTimes(2);
    expect(processMocks.executePrivilegedSandboxCommand.mock.calls[1]?.[1]).toEqual([
      "/opt/hermes/.venv/bin/python",
      "-I",
      "/usr/local/lib/nemoclaw/hermes-cron-restore-control.py",
      "validate",
      "--pid",
      "41",
      "--start-time",
      "902",
      "--drain-token=restore-token",
    ]);
  });

  it("passes an untrusted drain token as one argv value", () => {
    const untrustedToken = "restore-token'; touch /tmp/advisor-owned; #";
    processMocks.executePrivilegedSandboxCommand.mockImplementation(
      (_sandboxName: string, argv: string[]) => ({
        status: 0,
        stdout: receipt(argv.includes("validate") ? "validate" : "begin", 41, 902, untrustedToken),
        stderr: "",
      }),
    );

    const identity = beginHermesCronRestore("alpha");
    validateHermesCronRestore("alpha", identity);

    const validateArgv = processMocks.executePrivilegedSandboxCommand.mock.calls[1]?.[1];
    expect(validateArgv?.at(-1)).toBe(`--drain-token=${untrustedToken}`);
  });

  it("keeps a leading-hyphen drain token attached to its option", () => {
    const leadingHyphenToken = "-restore-token";
    processMocks.executePrivilegedSandboxCommand.mockImplementation(
      (_sandboxName: string, argv: string[]) => ({
        status: 0,
        stdout: receipt(
          argv.includes("validate") ? "validate" : "begin",
          41,
          902,
          leadingHyphenToken,
        ),
        stderr: "",
      }),
    );

    const identity = beginHermesCronRestore("alpha");
    validateHermesCronRestore("alpha", identity);

    expect(processMocks.executePrivilegedSandboxCommand.mock.calls[1]?.[1]).toContain(
      "--drain-token=-restore-token",
    );
  });

  it("keeps dispatch drained when state restore is incomplete", () => {
    processMocks.executePrivilegedSandboxCommand.mockReturnValue({
      status: 0,
      stdout: receipt("begin"),
      stderr: "",
    });

    expect(() =>
      runHermesCronRestoreTransaction("alpha", () => ({ restoreSucceeded: false })),
    ).toThrow("state restore was incomplete");
    expect(processMocks.executePrivilegedSandboxCommand).toHaveBeenCalledOnce();
    expect(processMocks.executePrivilegedSandboxCommand.mock.calls[0]?.[1]).toContain("begin");
  });

  it("keeps dispatch held after restore validation until gateway replacement (#8472)", () => {
    const events: string[] = [];
    processMocks.executePrivilegedSandboxCommand.mockImplementation(
      (_sandboxName: string, argv: string[]) => {
        const action = argv.includes("validate") ? "validate" : "begin";
        events.push(action);
        return { status: 0, stdout: receipt(action), stderr: "" };
      },
    );

    const transaction = runHermesCronRestoreTransaction(
      "alpha",
      () => {
        events.push("restore");
        return { restoreSucceeded: true, restored: "state" };
      },
      (state) => events.push(state),
    );

    expect(events).toEqual(["begin", "acquired", "restore", "validate"]);
    expect(transaction).toEqual({
      identity: { drain_token: "restore-token", pid: 41, start_time: 902 },
      result: { restoreSucceeded: true, restored: "state" },
    });
  });

  it("completes the held gate against the replacement gateway identity (#8472)", () => {
    processMocks.executePrivilegedSandboxCommand.mockReturnValue({
      status: 0,
      stdout: receipt("complete", 77, 903),
      stderr: "",
    });

    expect(
      completeHermesCronRestoreAfterGatewayReplacement(
        "alpha",
        {
          pid: 41,
          start_time: 902,
          drain_token: "restore-token",
        },
        { pid: 77, start_time: 903, drain_token: "restore-token" },
      ),
    ).toEqual({ pid: 77, start_time: 903, drain_token: "restore-token" });
    expect(processMocks.executePrivilegedSandboxCommand).toHaveBeenCalledWith(
      "alpha",
      [
        "/opt/hermes/.venv/bin/python",
        "-I",
        "/usr/local/lib/nemoclaw/hermes-cron-restore-control.py",
        "complete",
        "--pid",
        "41",
        "--start-time",
        "902",
        "--drain-token=restore-token",
        "--replacement-pid",
        "77",
        "--replacement-start-time",
        "903",
      ],
      130_000,
    );
  });

  it("rejects completion that did not bind to a replacement identity (#8472)", () => {
    processMocks.executePrivilegedSandboxCommand.mockReturnValue({
      status: 0,
      stdout: receipt("complete"),
      stderr: "",
    });

    expect(() =>
      completeHermesCronRestoreAfterGatewayReplacement(
        "alpha",
        {
          pid: 41,
          start_time: 902,
          drain_token: "restore-token",
        },
        { pid: 77, start_time: 903, drain_token: "restore-token" },
      ),
    ).toThrow("changed the verified replacement gateway identity");
  });

  it("rejects completion without the held drain token before transport (#8472)", () => {
    expect(() =>
      completeHermesCronRestoreAfterGatewayReplacement(
        "alpha",
        {
          pid: 41,
          start_time: 902,
        },
        { pid: 77, start_time: 903, drain_token: "restore-token" },
      ),
    ).toThrow("requires the held drain token");
    expect(processMocks.executePrivilegedSandboxCommand).not.toHaveBeenCalled();
  });

  it("rejects completion when the replacement carries a different drain token (#8472)", () => {
    expect(() =>
      completeHermesCronRestoreAfterGatewayReplacement(
        "alpha",
        { pid: 41, start_time: 902, drain_token: "restore-token" },
        { pid: 77, start_time: 903, drain_token: "different-token" },
      ),
    ).toThrow("changed the held drain token");
    expect(processMocks.executePrivilegedSandboxCommand).not.toHaveBeenCalled();
  });

  it("classifies the structured drain-marker rollback failure (#8472)", () => {
    const message = "Hermes cron restore drain release failed and its marker could not be restored";
    const failure = completionFailure(
      [
        `HERMES_CRON_RESTORE_ERROR: ${message}`,
        `${CONTROL_ERROR_PREFIX}${JSON.stringify({
          code: HERMES_CRON_RESTORE_DRAIN_MARKER_ROLLBACK_FAILED_CODE,
          message,
        })}`,
      ].join("\n"),
    );

    expect(isHermesCronRestoreDrainMarkerRollbackFailure(failure)).toBe(true);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(message);
  });

  it("does not classify matching prose without the structured failure code (#8472)", () => {
    const message = "Hermes cron restore drain release failed and its marker could not be restored";
    const failure = completionFailure(`HERMES_CRON_RESTORE_ERROR: ${message}`);

    expect(isHermesCronRestoreDrainMarkerRollbackFailure(failure)).toBe(false);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(message);
  });

  it("rejects completion while replacement agents are still active (#8472)", () => {
    processMocks.executePrivilegedSandboxCommand.mockReturnValue({
      status: 0,
      stdout: receipt("complete", 77, 903, "restore-token", { active_agents: 1 }),
      stderr: "",
    });

    expect(() =>
      completeHermesCronRestoreAfterGatewayReplacement(
        "alpha",
        {
          pid: 41,
          start_time: 902,
          drain_token: "restore-token",
        },
        { pid: 77, start_time: 903, drain_token: "restore-token" },
      ),
    ).toThrow("receipt failed validation");
  });

  it.each([
    ["missing", undefined],
    ["negative", -1],
    ["fractional", 0.5],
  ])("rejects a %s rearmed one-shot count", (_label, rearmedOneshots) => {
    const overrides =
      rearmedOneshots === undefined
        ? { rearmed_oneshots: undefined }
        : { rearmed_oneshots: rearmedOneshots };
    const stdout = receipt("complete", 77, 903, "restore-token", overrides);
    processMocks.executePrivilegedSandboxCommand.mockReturnValue({
      status: 0,
      stdout,
      stderr: "",
    });

    expect(() =>
      completeHermesCronRestoreAfterGatewayReplacement(
        "alpha",
        { pid: 41, start_time: 902, drain_token: "restore-token" },
        { pid: 77, start_time: 903, drain_token: "restore-token" },
      ),
    ).toThrow("receipt failed validation");
  });

  it("observes the replacement identity without releasing the held gate (#8472)", () => {
    processMocks.executePrivilegedSandboxCommand.mockReturnValue({
      status: 0,
      stdout: receipt("observe", 77, 903),
      stderr: "",
    });

    expect(
      observeHermesCronReplacement("alpha", {
        pid: 41,
        start_time: 902,
        drain_token: "restore-token",
      }),
    ).toEqual({ pid: 77, start_time: 903, drain_token: "restore-token" });
    expect(processMocks.executePrivilegedSandboxCommand.mock.calls[0]?.[1]).toEqual([
      "/opt/hermes/.venv/bin/python",
      "-I",
      "/usr/local/lib/nemoclaw/hermes-cron-restore-control.py",
      "observe",
      "--pid",
      "41",
      "--start-time",
      "902",
      "--drain-token=restore-token",
    ]);
  });

  it.each([
    ["dispatch-reactivated", false],
    ["operator-drain-preserved", true],
  ] as const)("returns the %s recovery disposition", (disposition, operatorDrainActive) => {
    processMocks.executePrivilegedSandboxCommand.mockReturnValue({
      status: 0,
      stdout: receipt("recover", 41, 902, "restore-token", {
        disposition,
        operator_drain_active: operatorDrainActive,
        preserved_drain: operatorDrainActive,
      }),
      stderr: "",
    });

    expect(recoverHermesCronRestore("alpha")).toBe(disposition);
    expect(processMocks.executePrivilegedSandboxCommand).toHaveBeenCalledWith(
      "alpha",
      [
        "/opt/hermes/.venv/bin/python",
        "-I",
        "/usr/local/lib/nemoclaw/hermes-cron-restore-control.py",
        "recover",
      ],
      130_000,
    );
  });

  it.each(["gate-prepared", "not-required"] as const)(
    "returns the %s pre-repair disposition",
    (disposition) => {
      processMocks.executePrivilegedSandboxCommand.mockReturnValue({
        status: 0,
        stdout: preparationReceipt(disposition),
        stderr: "",
      });

      expect(prepareHermesCronRestoreRecovery("alpha")).toBe(disposition);
      expect(processMocks.executePrivilegedSandboxCommand).toHaveBeenCalledWith(
        "alpha",
        [
          "/opt/hermes/.venv/bin/python",
          "-I",
          "/usr/local/lib/nemoclaw/hermes-cron-restore-control.py",
          "prepare-recover",
        ],
        25_000,
      );
    },
  );

  it("rejects an inconsistent pre-repair receipt", () => {
    processMocks.executePrivilegedSandboxCommand.mockReturnValue({
      status: 0,
      stdout: preparationReceipt("gate-prepared", { drain_acquired: false }),
      stderr: "",
    });

    expect(() => prepareHermesCronRestoreRecovery("alpha")).toThrow(
      "prepare-recover receipt failed validation",
    );
  });

  it.each([
    `/opt/hermes/.venv/bin/python: can't open file '/usr/local/lib/nemoclaw/hermes-cron-restore-control.py': [Errno 2] No such file or directory`,
    "hermes-cron-restore-control.py: error: argument action: invalid choice: 'prepare-recover'",
  ])("keeps pre-repair compatible with a legacy Hermes sandbox: %s", (stderr) => {
    processMocks.executePrivilegedSandboxCommand.mockReturnValue({ status: 2, stdout: "", stderr });

    expect(prepareHermesCronRestoreRecovery("alpha")).toBe("unsupported");
  });

  it("does not hide a current controller pre-repair failure", () => {
    processMocks.executePrivilegedSandboxCommand.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "NemoClaw cron restore release recovery record metadata is unsafe",
    });

    expect(() => prepareHermesCronRestoreRecovery("alpha")).toThrow(
      "Hermes cron prepare-recover failed: NemoClaw cron restore release recovery record metadata is unsafe",
    );
  });

  it("composes the recovery transport budget from every controller phase (#7806)", () => {
    processMocks.executePrivilegedSandboxCommand.mockImplementation(
      (_sandboxName: string, argv: string[]) => {
        const stdout = argv.includes("prepare-recover")
          ? preparationReceipt("not-required")
          : receipt(argv.includes("recover") ? "recover" : "begin");
        return { status: 0, stdout, stderr: "" };
      },
    );

    beginHermesCronRestore("alpha");
    prepareHermesCronRestoreRecovery("alpha");
    recoverHermesCronRestore("alpha");

    expect(processMocks.executePrivilegedSandboxCommand.mock.calls[0]?.[2]).toBe(70_000);
    expect(processMocks.executePrivilegedSandboxCommand.mock.calls[1]?.[2]).toBe(25_000);
    expect(processMocks.executePrivilegedSandboxCommand.mock.calls[2]?.[2]).toBe(130_000);
  });

  it("returns not-required when no NemoClaw recovery gate exists", () => {
    processMocks.executePrivilegedSandboxCommand.mockReturnValue({
      status: 0,
      stdout: notRequiredRecoveryReceipt(),
      stderr: "",
    });

    expect(recoverHermesCronRestore("alpha")).toBe("not-required");
  });

  it("rejects a rearmed one-shot count when no recovery gate exists", () => {
    processMocks.executePrivilegedSandboxCommand.mockReturnValue({
      status: 0,
      stdout: notRequiredRecoveryReceipt({ rearmed_oneshots: 0 }),
      stderr: "",
    });

    expect(() => recoverHermesCronRestore("alpha")).toThrow("receipt failed validation");
  });

  it("accepts not-required while preserving an independent operator drain", () => {
    processMocks.executePrivilegedSandboxCommand.mockReturnValue({
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
    processMocks.executePrivilegedSandboxCommand.mockReturnValue({
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
    processMocks.executePrivilegedSandboxCommand.mockReturnValue({ status: 2, stdout: "", stderr });

    expect(recoverHermesCronRestore("alpha")).toBe("unsupported");
  });

  it("does not hide a current controller recovery failure", () => {
    processMocks.executePrivilegedSandboxCommand.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "Hermes cron restore drain marker is invalid",
    });

    expect(() => recoverHermesCronRestore("alpha")).toThrow(
      "Hermes cron recover failed: Hermes cron restore drain marker is invalid",
    );
  });
});
