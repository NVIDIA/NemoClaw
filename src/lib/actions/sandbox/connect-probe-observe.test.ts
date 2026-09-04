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

  it("runs portable lifecycle recovery before the live sandbox lookup (#8441)", async () => {
    const harness = createConnectHarness();

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.recoverPortableDemoLifecycleSpy).toHaveBeenCalledOnce();
    expect(harness.recoverPortableDemoLifecycleSpy).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ agent: "openclaw" }),
      "nemoclaw",
    );
    expect(harness.recoverPortableDemoLifecycleSpy.mock.invocationCallOrder[0]).toBeLessThan(
      harness.ensureLiveSandboxSpy.mock.invocationCallOrder[0]!,
    );
  });

  it("settles completed Portable pairing before publishing probe readiness (#9207)", async () => {
    const harness = createConnectHarness({
      portablePairingSettlementResult: { kind: "settled" },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.settlePortablePairingSpy).toHaveBeenCalledWith("alpha");
    expect(harness.runAutoPairSpy).not.toHaveBeenCalled();
    expect(harness.settlePortablePairingSpy.mock.invocationCallOrder[0]).toBeLessThan(
      harness.publishLaunchReadinessSpy.mock.invocationCallOrder[0]!,
    );
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
    expect(listInvocations).toHaveLength(3);
    const listArgs = harness.captureOpenshellSpy.mock.calls
      .map((call) => call[0])
      .filter(
        (args): args is string[] =>
          Array.isArray(args) && args[0] === "sandbox" && args[1] === "list",
      );
    expect(listArgs).toEqual([
      ["sandbox", "list", "-g", "nemoclaw-8091"],
      ["sandbox", "list", "-g", "nemoclaw-8091"],
      ["sandbox", "list", "-g", "nemoclaw-8091"],
    ]);
    const liveLookupOrder = harness.ensureLiveSandboxSpy.mock.invocationCallOrder;
    expect(liveLookupOrder).toHaveLength(2);
    const recoveryOrder = harness.checkAndRecoverSpy.mock.invocationCallOrder;
    expect(recoveryOrder).toHaveLength(1);
    expect(listInvocations[1]).toBeLessThan(liveLookupOrder[1]);
    expect(liveLookupOrder[1]).toBeLessThan(recoveryOrder[0]);
    expect(recoveryOrder[0]).toBeLessThan(listInvocations[2]!);
    expect(listInvocations[2]).toBeLessThan(
      harness.publishLaunchReadinessSpy.mock.invocationCallOrder[0]!,
    );
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

  it("waits through the initial Error after starting a stopped container (#10466)", async () => {
    const harness = createConnectHarness({
      dockerRuntime: { containerName: "openshell-alpha", running: false, paused: false },
      listOutputs: ["alpha Error", "alpha Provisioning", "alpha Ready"],
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.dockerStartSpy).toHaveBeenCalledOnce();
    expect(harness.dockerStartSpy).toHaveBeenCalledWith(
      "openshell-alpha",
      expect.objectContaining({ ignoreError: true }),
    );
    const listInvocations = harness.captureOpenshellSpy.mock.calls
      .map((call, index) => ({
        call,
        order: harness.captureOpenshellSpy.mock.invocationCallOrder[index]!,
      }))
      .filter(
        ({ call }) =>
          Array.isArray(call?.[0]) &&
          (call[0] as string[])[0] === "sandbox" &&
          (call[0] as string[])[1] === "list",
      );
    expect(listInvocations.length).toBeGreaterThan(0);
    // The container must be started before recovery starts polling for readiness,
    // otherwise the wait loop observes a stopped container until it times out.
    expect(harness.dockerStartSpy.mock.invocationCallOrder[0]!).toBeLessThan(
      listInvocations[0]!.order,
    );
    expect(listInvocations).toHaveLength(4);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it.each([
    {
      condition: "Docker reports a failed start",
      dockerRuntime: { containerName: "openshell-alpha", running: false, paused: false },
      dockerStartStatus: 1,
      expectedStartCalls: 1,
    },
    {
      condition: "Docker reports no start status",
      dockerRuntime: { containerName: "openshell-alpha", running: false, paused: false },
      dockerStartStatus: null,
      expectedStartCalls: 1,
    },
    {
      condition: "the container is already running",
      dockerRuntime: { containerName: "openshell-alpha", running: true, paused: false },
      dockerStartStatus: 0,
      expectedStartCalls: 0,
    },
    {
      condition: "the container is paused",
      dockerRuntime: { containerName: "openshell-alpha", running: false, paused: true },
      dockerStartStatus: 0,
      expectedStartCalls: 0,
    },
    {
      condition: "Docker cannot resolve a container",
      dockerRuntime: { containerName: null, running: false, paused: false },
      dockerStartStatus: 0,
      expectedStartCalls: 0,
    },
  ])("keeps Error terminal when $condition (#10466)", async (testCase) => {
    const harness = createConnectHarness({
      dockerRuntime: testCase.dockerRuntime,
      dockerStartStatus: testCase.dockerStartStatus,
      listOutput: "alpha Error",
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.dockerStartSpy).toHaveBeenCalledTimes(testCase.expectedStartCalls);
    expect(harness.captureOpenshellSpy).toHaveBeenCalledTimes(1);
    expect(harness.checkAndRecoverSpy).not.toHaveBeenCalled();
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
  });

  it("fails before recovery when the initial Error persists after Docker starts (#10466)", async () => {
    const harness = createConnectHarness({
      dockerRuntime: { containerName: "openshell-alpha", running: false, paused: false },
      listOutputs: Array.from({ length: 21 }, () => "alpha Error"),
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.dockerStartSpy).toHaveBeenCalledOnce();
    expect(harness.captureOpenshellSpy).toHaveBeenCalledTimes(21);
    expect(harness.checkAndRecoverSpy).not.toHaveBeenCalled();
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
  });

  it("continues readiness polling when Docker cannot start a stopped container (#8967)", async () => {
    const harness = createConnectHarness({
      dockerRuntime: { containerName: "openshell-alpha", running: false, paused: false },
      dockerStartStatus: 1,
      listOutput: "alpha Ready",
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.dockerStartSpy).toHaveBeenCalledOnce();
    expect(harness.errorSpy.mock.calls.map(([line]) => String(line)).join("\n")).toContain(
      "Docker could not start container 'openshell-alpha' (exit 1); continuing with readiness checks.",
    );
    expect(
      harness.captureOpenshellSpy.mock.calls.some(
        ([args]) => Array.isArray(args) && args[0] === "sandbox" && args[1] === "list",
      ),
    ).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("leaves a running container untouched on probe-only recovery (#8967)", async () => {
    const harness = createConnectHarness({
      dockerRuntime: { containerName: "openshell-alpha", running: true, paused: false },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.dockerStartSpy).not.toHaveBeenCalled();
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
