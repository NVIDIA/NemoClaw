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

  it("re-observes the live sandbox after delayed readiness before process or forward recovery (#7173)", async () => {
    const harness = createConnectHarness({
      registryEntry: { gatewayPort: 8091 },
      listOutputs: ["alpha Starting", "alpha Ready"],
      processCheck: {
        checked: true,
        wasRunning: true,
        recovered: false,
        forwardRecovered: true,
      },
    });

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
    expect(listInvocations).toHaveLength(2);
    const listArgs = harness.captureOpenshellSpy.mock.calls
      .map((call) => call[0])
      .filter(
        (args): args is string[] =>
          Array.isArray(args) && args[0] === "sandbox" && args[1] === "list",
      );
    expect(listArgs).toEqual([
      ["sandbox", "list", "-g", "nemoclaw-8091"],
      ["sandbox", "list", "-g", "nemoclaw-8091"],
    ]);
    const liveLookupOrder = harness.ensureLiveSandboxSpy.mock.invocationCallOrder;
    expect(liveLookupOrder).toHaveLength(2);
    const recoveryOrder = harness.checkAndRecoverSpy.mock.invocationCallOrder;
    expect(recoveryOrder).toHaveLength(1);
    expect(listInvocations[1]).toBeLessThan(liveLookupOrder[1]);
    expect(liveLookupOrder[1]).toBeLessThan(recoveryOrder[0]);
    expect(harness.logSpy).toHaveBeenCalledWith(
      expect.stringContaining("restored dashboard port forward"),
    );
  });

  it("does not run process or forward recovery for a terminal sandbox phase (#7173)", async () => {
    const harness = createConnectHarness({ listOutput: "alpha Error" });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.ensureLiveSandboxSpy).toHaveBeenCalledOnce();
    expect(harness.checkAndRecoverSpy).not.toHaveBeenCalled();
  });

  it("suggests a longer equivalent retry when probe-only readiness times out", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(300_001);
    const harness = createConnectHarness({ listOutput: "alpha Starting" });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    const errors = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(errors).toContain("Timed out after 300s waiting for sandbox 'alpha'");
    expect(errors).toContain("NEMOCLAW_CONNECT_TIMEOUT=600 nemoclaw alpha connect --probe-only");
    expect(harness.checkAndRecoverSpy).not.toHaveBeenCalled();
  });
});
