// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import {
  connectModulePath,
  createConnectHarness,
  requireDist,
} from "../../../../test/support/connect-flow-test-harness";

describe("connectSandbox probe-only observe mode", () => {
  let exitSpy: MockInstance;

  beforeEach(() => {
    process.env.NEMOCLAW_TEST_NO_SLEEP = "1";
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    delete process.env.NEMOCLAW_TEST_NO_SLEEP;
    delete process.env.NEMOCLAW_CONNECT_TIMEOUT;
    delete require.cache[requireDist.resolve(connectModulePath)];
  });

  it("passes gatewayRecovery=observe to ensureLiveSandboxOrExit on probeOnly", async () => {
    const harness = createConnectHarness();

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.ensureLiveSandboxSpy).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ allowNonReadyPhase: true, gatewayRecovery: "observe" }),
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("uses gatewayRecovery=recover on the full connect path", async () => {
    const harness = createConnectHarness();

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");

    expect(harness.ensureLiveSandboxSpy).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ allowNonReadyPhase: true, gatewayRecovery: "recover" }),
    );
  });

  it("polls sandbox readiness before running in-sandbox process recovery on probeOnly", async () => {
    const harness = createConnectHarness();

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    const listInvocations = harness.captureOpenshellSpy.mock.invocationCallOrder.filter(
      (_, index) => {
        const call = harness.captureOpenshellSpy.mock.calls[index];
        return (
          Array.isArray(call?.[0]) &&
          (call[0] as string[])[0] === "sandbox" &&
          (call[0] as string[])[1] === "list"
        );
      },
    );
    expect(listInvocations.length).toBeGreaterThan(0);
    const recoveryOrder = harness.checkAndRecoverSpy.mock.invocationCallOrder;
    expect(recoveryOrder.length).toBeGreaterThan(0);
    expect(listInvocations[0]).toBeLessThan(recoveryOrder[0]);
  });

  it("exits on timeout when sandbox never reports Ready on probeOnly", async () => {
    process.env.NEMOCLAW_CONNECT_TIMEOUT = "1";
    const harness = createConnectHarness({ listOutput: "alpha Starting" });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    const errors = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(errors).toContain("Timed out after 1s waiting for sandbox 'alpha'");
  });
});
