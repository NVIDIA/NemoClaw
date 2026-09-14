// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectSandbox: vi.fn(),
  restoreSandboxStartupState: vi.fn(),
  waitForManagedGatewaySupervisor: vi.fn(),
  getSessionAgent: vi.fn(),
  inspectPortableAgentReceiptDisposition: vi.fn(),
  prepareHermesCronRestoreRecovery: vi.fn(),
  recoverHermesCronRestore: vi.fn(),
  withSandboxLifecycleLock: vi.fn(
    async (_sandboxName: string, operation: () => Promise<void>, _options: unknown) => operation(),
  ),
}));

vi.mock("../../../agent/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../agent/runtime")>()),
  getSessionAgent: mocks.getSessionAgent,
}));

vi.mock("../lifecycle/lock", () => ({
  withSandboxLifecycleLock: mocks.withSandboxLifecycleLock,
}));

vi.mock("../../../onboard/experimental/portable-agent-lifecycle", () => ({
  inspectPortableAgentReceiptDisposition: mocks.inspectPortableAgentReceiptDisposition,
}));

vi.mock("../connect", () => ({
  connectSandbox: mocks.connectSandbox,
  restoreSandboxStartupState: mocks.restoreSandboxStartupState,
  waitForManagedGatewaySupervisor: mocks.waitForManagedGatewaySupervisor,
}));

vi.mock("../rebuild-hermes-post-restore", () => ({
  prepareHermesCronRestoreRecovery: mocks.prepareHermesCronRestoreRecovery,
  recoverHermesCronRestore: mocks.recoverHermesCronRestore,
}));

import { recoverSandboxWithHermesCronRestore } from "./hermes-cron-restore-recovery";

describe("sandbox recovery with a Hermes cron restore gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connectSandbox.mockResolvedValue(undefined);
    mocks.restoreSandboxStartupState.mockResolvedValue({
      checked: true,
      wasRunning: true,
      recovered: false,
    });
    mocks.waitForManagedGatewaySupervisor.mockReturnValue(true);
    mocks.inspectPortableAgentReceiptDisposition.mockReturnValue({ kind: "absent" });
    mocks.prepareHermesCronRestoreRecovery.mockReturnValue("not-required");
    mocks.recoverHermesCronRestore.mockReturnValue("not-required");
  });

  it("prepares the Hermes gate before gateway repair under the sandbox mutation lock", async () => {
    mocks.getSessionAgent.mockReturnValue({ name: "hermes" });
    const events: string[] = [];
    mocks.prepareHermesCronRestoreRecovery.mockImplementation(() => {
      events.push("prepare");
      return "gate-prepared";
    });
    mocks.restoreSandboxStartupState.mockImplementation(async () => {
      events.push("restore");
      return { checked: true, wasRunning: false, recovered: true };
    });
    mocks.connectSandbox.mockImplementation(async () => {
      events.push("connect");
    });
    mocks.recoverHermesCronRestore.mockImplementation(() => {
      events.push("recover");
      return "dispatch-reactivated";
    });

    await recoverSandboxWithHermesCronRestore("alpha");

    expect(mocks.withSandboxLifecycleLock).toHaveBeenCalledWith("alpha", expect.any(Function), {
      timeoutMs: 30_000,
    });
    expect(events).toEqual(["prepare", "restore", "connect", "recover"]);
    expect(mocks.prepareHermesCronRestoreRecovery).toHaveBeenCalledWith("alpha");
    expect(mocks.connectSandbox).toHaveBeenCalledWith("alpha", {
      probeOnly: true,
      requireLaunchReadinessPublication: false,
    });
    expect(mocks.recoverHermesCronRestore).toHaveBeenCalledWith("alpha");
  });

  it("routes schema-5 recovery directly to receipt-owned probe without cron mutation (#9203)", async () => {
    mocks.inspectPortableAgentReceiptDisposition.mockReturnValue({
      kind: "hermes",
      phase: "active",
    });
    mocks.getSessionAgent.mockReturnValue({ name: "hermes" });

    await recoverSandboxWithHermesCronRestore("alpha");

    expect(mocks.connectSandbox).toHaveBeenCalledWith("alpha", {
      probeOnly: true,
      requireLaunchReadinessPublication: false,
    });
    expect(mocks.prepareHermesCronRestoreRecovery).not.toHaveBeenCalled();
    expect(mocks.restoreSandboxStartupState).not.toHaveBeenCalled();
    expect(mocks.recoverHermesCronRestore).not.toHaveBeenCalled();
  });

  it("does not repair the gateway when Hermes gate preparation fails", async () => {
    mocks.getSessionAgent.mockReturnValue({ name: "hermes" });
    mocks.prepareHermesCronRestoreRecovery.mockImplementation(() => {
      throw new Error("recovery authority is unsafe");
    });

    await expect(recoverSandboxWithHermesCronRestore("alpha")).rejects.toThrow(
      "recovery authority is unsafe",
    );
    expect(mocks.connectSandbox).not.toHaveBeenCalled();
    expect(mocks.recoverHermesCronRestore).not.toHaveBeenCalled();
  });

  it("keeps legacy Hermes recovery compatible when preparation is unsupported", async () => {
    mocks.getSessionAgent.mockReturnValue({ name: "hermes" });
    mocks.prepareHermesCronRestoreRecovery.mockReturnValue("unsupported");
    mocks.recoverHermesCronRestore.mockReturnValue("unsupported");

    await recoverSandboxWithHermesCronRestore("alpha");

    expect(mocks.prepareHermesCronRestoreRecovery).toHaveBeenCalledWith("alpha");
    expect(mocks.connectSandbox).toHaveBeenCalledWith("alpha", {
      probeOnly: true,
      requireLaunchReadinessPublication: false,
    });
    expect(mocks.recoverHermesCronRestore).toHaveBeenCalledWith("alpha");
  });

  it("does not invoke Hermes control for another agent", async () => {
    mocks.getSessionAgent.mockReturnValue({ name: "openclaw" });

    await recoverSandboxWithHermesCronRestore("alpha");

    expect(mocks.connectSandbox).toHaveBeenCalledWith("alpha", {
      probeOnly: true,
      requireLaunchReadinessPublication: false,
    });
    expect(mocks.prepareHermesCronRestoreRecovery).not.toHaveBeenCalled();
    expect(mocks.recoverHermesCronRestore).not.toHaveBeenCalled();
  });

  it("stops before readiness when startup recovery fails", async () => {
    mocks.getSessionAgent.mockReturnValue({ name: "openclaw" });
    mocks.restoreSandboxStartupState.mockResolvedValue({
      checked: true,
      wasRunning: false,
      recovered: false,
      recoveryFailureDetail: "supervisor reconstruction failed",
    });

    await expect(recoverSandboxWithHermesCronRestore("alpha")).rejects.toThrow(
      "supervisor reconstruction failed",
    );
    expect(mocks.connectSandbox).not.toHaveBeenCalled();
  });

  it("settles a recreated supervisor before readiness", async () => {
    mocks.getSessionAgent.mockReturnValue({ name: "openclaw" });
    mocks.restoreSandboxStartupState
      .mockResolvedValueOnce({
        checked: true,
        wasRunning: false,
        recovered: false,
        recoveryFailureDetail: "SUPERVISOR_NOT_RUNNING",
      })
      .mockResolvedValueOnce({ checked: true, wasRunning: true, recovered: true });

    await recoverSandboxWithHermesCronRestore("alpha");

    expect(mocks.waitForManagedGatewaySupervisor).toHaveBeenCalledWith("alpha");
    expect(mocks.restoreSandboxStartupState).toHaveBeenCalledTimes(2);
    expect(mocks.connectSandbox).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "dispatch-reactivated",
      "Hermes cron dispatch resumed after restored jobs and scripts were validated.",
    ],
    [
      "operator-drain-preserved",
      "Hermes cron restore gate cleared; the independent operator drain remains active.",
    ],
  ] as const)("reports the %s outcome", async (outcome, expected) => {
    mocks.getSessionAgent.mockReturnValue({ name: "hermes" });
    mocks.recoverHermesCronRestore.mockReturnValue(outcome);
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line = "") => {
      lines.push(String(line));
    });
    try {
      await recoverSandboxWithHermesCronRestore("alpha");
    } finally {
      log.mockRestore();
    }

    expect(lines).toContain(`  ${expected}`);
  });
});
