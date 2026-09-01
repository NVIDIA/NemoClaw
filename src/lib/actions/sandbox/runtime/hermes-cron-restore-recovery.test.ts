// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectSandbox: vi.fn(),
  getSessionAgent: vi.fn(),
  inspectPortableAgentReceiptDisposition: vi.fn(),
  prepareHermesCronRestoreRecovery: vi.fn(),
  recoverHermesCronRestore: vi.fn(),
  withMcpLifecycleLock: vi.fn(
    async (_sandboxName: string, operation: () => Promise<void>, _options: unknown) => operation(),
  ),
}));

vi.mock("../../../agent/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../agent/runtime")>()),
  getSessionAgent: mocks.getSessionAgent,
}));

vi.mock("../../../state/mcp-lifecycle-lock", () => ({
  withMcpLifecycleLock: mocks.withMcpLifecycleLock,
}));

vi.mock("../../../onboard/experimental/portable-agent-lifecycle", () => ({
  inspectPortableAgentReceiptDisposition: mocks.inspectPortableAgentReceiptDisposition,
}));

vi.mock("../connect", () => ({
  connectSandbox: mocks.connectSandbox,
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
    mocks.connectSandbox.mockImplementation(async () => {
      events.push("connect");
    });
    mocks.recoverHermesCronRestore.mockImplementation(() => {
      events.push("recover");
      return "dispatch-reactivated";
    });

    await recoverSandboxWithHermesCronRestore("alpha");

    expect(mocks.withMcpLifecycleLock).toHaveBeenCalledWith("alpha", expect.any(Function), {
      timeoutMs: 30_000,
    });
    expect(events).toEqual(["prepare", "connect", "recover"]);
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
