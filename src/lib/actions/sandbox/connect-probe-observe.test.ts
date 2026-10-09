// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import {
  connectModulePath,
  createConnectHarness,
  requireDist,
} from "../../../../test/support/connect-flow-test-harness";
import { HermesPortableRecoveryRollbackError } from "../../onboard/experimental/hermes-portable-lifecycle";

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

  it("does not require portable authority for an ordinary Hermes probe-only recovery", async () => {
    const harness = createConnectHarness({ agentName: "hermes" });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.inspectPortableReceiptDispositionSpy).toHaveBeenCalled();
    expect(harness.qualifyHermesPortableAcceptedReadinessAuthoritySpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("prints classified Portable recovery and rollback results without nested diagnostics (#11248)", async () => {
    const harness = createConnectHarness({
      agentName: "hermes",
      portableReceiptDisposition: { kind: "hermes", phase: "active" },
    });
    const nestedDiagnostic = "Bearer do-not-print";
    harness.recoverPortableDemoLifecycleSpy.mockImplementation(() => {
      throw new HermesPortableRecoveryRollbackError(
        "startup-launch",
        "openshell-terminal-settlement",
        new Error(nestedDiagnostic),
        new Error(nestedDiagnostic),
      );
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    const output = harness.errorSpy.mock.calls.map(([line]) => String(line)).join("\n");
    expect(output).toContain("primary=startup-launch");
    expect(output).toContain("rollback=openshell-terminal-settlement-unproved");
    expect(output).not.toContain(nestedDiagnostic);
    expect(harness.ensureLiveSandboxSpy).not.toHaveBeenCalled();
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
      registryEntry: { stopped: true },
      dockerRuntime: { containerName: "openshell-alpha", running: false, paused: false },
      listOutputs: ["alpha Error", "alpha Provisioning", "alpha Ready"],
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    const sandboxSubcommandInvocations = (subcommand: string) =>
      harness.captureOpenshellSpy.mock.calls
        .map((call, index) => ({
          call,
          order: harness.captureOpenshellSpy.mock.invocationCallOrder[index]!,
        }))
        .filter(
          ({ call }) =>
            Array.isArray(call?.[0]) &&
            (call[0] as string[])[0] === "sandbox" &&
            (call[0] as string[])[1] === subcommand,
        );
    // A bare `docker start` would leave the sandbox phase at Stopped, so the
    // start has to go through OpenShell (#11790).
    const startInvocations = sandboxSubcommandInvocations("start");
    expect(startInvocations).toHaveLength(1);
    expect(harness.dockerStartSpy).not.toHaveBeenCalled();
    const listInvocations = sandboxSubcommandInvocations("list");
    expect(listInvocations.length).toBeGreaterThan(0);
    // The sandbox must be started before recovery starts polling for readiness,
    // otherwise the wait loop observes a stopped sandbox until it times out.
    expect(startInvocations[0]!.order).toBeLessThan(listInvocations[0]!.order);
    expect(listInvocations).toHaveLength(4);
    expect(harness.registryUpdateSpy).toHaveBeenCalledWith("alpha", { stopped: false });
    expect(harness.registryEntries[0]?.stopped).toBe(false);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("waits for a just-started Hermes gateway before process recovery", async () => {
    const harness = createConnectHarness({
      agentName: "hermes",
      sessionAgent: { name: "hermes" },
      registryEntry: { stopped: true },
      dockerRuntime: { containerName: "openshell-alpha", running: false, paused: false },
      listOutput: "alpha Ready",
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.waitForStartedHermesGatewayProcessSpy).toHaveBeenCalledWith(
      "alpha",
      "nemoclaw",
      { log: console.log },
    );
    expect(harness.waitForStartedHermesGatewayProcessSpy.mock.invocationCallOrder[0]).toBeLessThan(
      harness.checkAndRecoverSpy.mock.invocationCallOrder[0]!,
    );
    const recoveryOptions = harness.checkAndRecoverSpy.mock.calls[0]?.[1];
    expect(recoveryOptions?.isSandboxGatewayRunningImpl).toBeTypeOf("function");
    await expect(recoveryOptions?.isSandboxGatewayRunningImpl?.("alpha")).resolves.toBe(true);
  });

  it("reuses the Hermes process observation accepted by the start command", async () => {
    const harness = createConnectHarness({
      agentName: "hermes",
      gatewayProcessSettlement: null,
      sessionAgent: { name: "hermes" },
      registryEntry: { stopped: true },
      listOutput: "alpha Ready",
    });

    await expect(
      harness.connectSandbox("alpha", {
        managedHermesGatewayProcessObserved: true,
        probeOnly: true,
      }),
    ).resolves.toBeUndefined();

    expect(harness.waitForStartedHermesGatewayProcessSpy).toHaveBeenCalledOnce();
    const recoveryOptions = harness.checkAndRecoverSpy.mock.calls[0]?.[1];
    expect(recoveryOptions?.isSandboxGatewayRunningImpl).toBeTypeOf("function");
    await expect(recoveryOptions?.isSandboxGatewayRunningImpl?.("alpha")).resolves.toBe(true);
  });

  it("stops before recovery when a just-started Hermes gateway stays stopped", async () => {
    const harness = createConnectHarness({
      agentName: "hermes",
      sessionAgent: { name: "hermes" },
      gatewayProcessSettlement: false,
      registryEntry: { stopped: true },
      dockerRuntime: { containerName: "openshell-alpha", running: false, paused: false },
      listOutput: "alpha Ready",
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.waitForStartedHermesGatewayProcessSpy).toHaveBeenCalledOnce();
    expect(harness.errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "did not become observable and running before the startup settlement window expired",
      ),
    );
    expect(harness.checkAndRecoverSpy).not.toHaveBeenCalled();
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
  });

  it("retains stop intent when a recovered container cannot publish the registry update", async () => {
    const harness = createConnectHarness({
      registryEntry: { stopped: true },
      dockerRuntime: { containerName: "openshell-alpha", running: false, paused: false },
      listOutputs: ["alpha Error", "alpha Provisioning", "alpha Ready"],
    });
    harness.registryUpdateSpy.mockReturnValue(false);

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "could not clear its intentional-stop record",
    );

    expect(harness.registryUpdateSpy).toHaveBeenCalledWith("alpha", { stopped: false });
    expect(harness.registryEntries[0]?.stopped).toBe(true);
    expect(harness.checkAndRecoverSpy).not.toHaveBeenCalled();
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
  });

  it("clears stop intent before probe-only process recovery fails", async () => {
    const harness = createConnectHarness({
      registryEntry: { stopped: true },
      dockerRuntime: { containerName: "openshell-alpha", running: false, paused: false },
      listOutputs: ["alpha Error", "alpha Provisioning", "alpha Ready"],
      processCheck: { checked: false, wasRunning: false, recovered: false },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.registryEntries[0]?.stopped).toBe(false);
    expect(harness.registryUpdateSpy.mock.invocationCallOrder[0]).toBeLessThan(
      harness.checkAndRecoverSpy.mock.invocationCallOrder[0],
    );
  });

  it.each([
    {
      condition: "Docker reports a failed start",
      dockerRuntime: { containerName: "openshell-alpha", running: false, paused: false },
      dockerStartStatus: 1,
      sandboxLifecycleStartStatus: 1,
      expectedDockerStartCalls: 0,
    },
    {
      condition: "Docker reports no start status",
      dockerRuntime: { containerName: "openshell-alpha", running: false, paused: false },
      dockerStartStatus: null,
      sandboxLifecycleStartStatus: 1,
      expectedDockerStartCalls: 0,
    },
    {
      condition: "the container is already running",
      dockerRuntime: { containerName: "openshell-alpha", running: true, paused: false },
      dockerStartStatus: 0,
      sandboxLifecycleStartStatus: 0,
      expectedDockerStartCalls: 0,
    },
    {
      condition: "the container is paused",
      dockerRuntime: { containerName: "openshell-alpha", running: false, paused: true },
      dockerStartStatus: 0,
      sandboxLifecycleStartStatus: 0,
      expectedDockerStartCalls: 0,
    },
    {
      condition: "Docker cannot resolve a container",
      dockerRuntime: { containerName: null, running: false, paused: false },
      dockerStartStatus: 0,
      sandboxLifecycleStartStatus: 0,
      expectedDockerStartCalls: 0,
    },
  ])("keeps Error terminal when $condition (#10466)", async (testCase) => {
    const harness = createConnectHarness({
      agentName: "hermes",
      sessionAgent: { name: "hermes" },
      dockerRuntime: testCase.dockerRuntime,
      dockerStartStatus: testCase.dockerStartStatus,
      sandboxLifecycleStartStatus: testCase.sandboxLifecycleStartStatus,
      listOutput: "alpha Error",
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.dockerStartSpy).toHaveBeenCalledTimes(testCase.expectedDockerStartCalls);
    // A terminal Error is observed once and never polled again.
    expect(
      harness.captureOpenshellSpy.mock.calls.filter(
        ([args]) => Array.isArray(args) && args[0] === "sandbox" && args[1] === "list",
      ),
    ).toHaveLength(1);
    expect(harness.checkAndRecoverSpy).not.toHaveBeenCalled();
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
    expect(harness.waitForStartedHermesGatewayProcessSpy).not.toHaveBeenCalled();
  });

  it("fails before recovery when the initial Error persists after the start (#10466)", async () => {
    const harness = createConnectHarness({
      dockerRuntime: { containerName: "openshell-alpha", running: false, paused: false },
      sandboxGetPhase: "Stopped",
      listOutputs: Array.from({ length: 21 }, () => "alpha Error"),
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(
      harness.captureOpenshellSpy.mock.calls.filter(
        ([args]) => Array.isArray(args) && args[0] === "sandbox" && args[1] === "start",
      ),
    ).toHaveLength(1);
    expect(
      harness.captureOpenshellSpy.mock.calls.filter(
        ([args]) => Array.isArray(args) && args[0] === "sandbox" && args[1] === "list",
      ),
    ).toHaveLength(21);
    expect(harness.checkAndRecoverSpy).not.toHaveBeenCalled();
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
  });

  it("continues readiness polling when OpenShell cannot start the container (#8967)", async () => {
    const harness = createConnectHarness({
      dockerRuntime: { containerName: "openshell-alpha", running: false, paused: false },
      dockerStartStatus: 1,
      sandboxLifecycleStartStatus: 1,
      sandboxGetPhase: "Stopped",
      listOutput: "alpha Ready",
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.dockerStartSpy).not.toHaveBeenCalled();
    expect(harness.errorSpy.mock.calls.map(([line]) => String(line)).join("\n")).toContain(
      "OpenShell could not start sandbox 'alpha': OpenShell is unavailable (Error, code 1).",
    );
    expect(
      harness.captureOpenshellSpy.mock.calls.some(
        ([args]) => Array.isArray(args) && args[0] === "sandbox" && args[1] === "list",
      ),
    ).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("does not fall back to Docker when OpenShell reports no lifecycle-start status (#8967)", async () => {
    const harness = createConnectHarness({
      dockerRuntime: { containerName: "openshell-alpha", running: false, paused: false },
      sandboxLifecycleStartStatus: null,
      sandboxGetPhase: "Stopped",
      listOutput: "alpha Ready",
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.dockerStartSpy).not.toHaveBeenCalled();
    const lifecycleStartIndices = harness.captureOpenshellSpy.mock.calls.flatMap(([args], index) =>
      Array.isArray(args) && args[0] === "sandbox" && args[1] === "start" ? [index] : [],
    );
    expect(lifecycleStartIndices).toHaveLength(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("leaves a running container untouched on probe-only recovery (#8967)", async () => {
    const harness = createConnectHarness({
      agentName: "hermes",
      sessionAgent: { name: "hermes" },
      dockerRuntime: { containerName: "openshell-alpha", running: true, paused: false },
      sandboxGetPhase: "Ready",
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.dockerStartSpy).not.toHaveBeenCalled();
    expect(
      harness.captureOpenshellSpy.mock.calls.some(
        ([args]) => Array.isArray(args) && args[0] === "sandbox" && args[1] === "start",
      ),
    ).toBe(false);
    expect(harness.waitForStartedHermesGatewayProcessSpy).not.toHaveBeenCalled();
  });

  it("starts a running container whose sandbox is still Stopped (#11790)", async () => {
    const harness = createConnectHarness({
      dockerRuntime: { containerName: "openshell-alpha", running: true, paused: false },
      sandboxGetPhase: "Stopped",
      listOutput: "alpha Ready",
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    // Without this, recover exhausts its readiness timeout on a sandbox that a
    // single lifecycle start would have returned to Ready.
    const sandboxInvocations = (subcommand: string) =>
      harness.captureOpenshellSpy.mock.calls
        .map((call, index) => ({
          call,
          order: harness.captureOpenshellSpy.mock.invocationCallOrder[index]!,
        }))
        .filter(
          ({ call }) =>
            Array.isArray(call?.[0]) &&
            (call[0] as string[])[0] === "sandbox" &&
            (call[0] as string[])[1] === subcommand,
        );
    const startInvocations = sandboxInvocations("start");
    const listInvocations = sandboxInvocations("list");
    expect(startInvocations).toHaveLength(1);
    expect(listInvocations.length).toBeGreaterThan(0);
    expect(startInvocations[0]!.order).toBeLessThan(listInvocations[0]!.order);
    expect(harness.dockerStartSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("starts a stopped sibling-root sandbox through its owning gateway", async () => {
    const harness = createConnectHarness({
      registryEntry: { gatewayName: "nemoclaw", gatewayPort: 8245 },
      sandboxGetPhase: "Stopped",
      listOutput: "alpha Ready",
    });
    const selectedRegistry = requireDist("../../src/lib/state/registry.js");
    selectedRegistry.getSandbox.mockReturnValue(null);

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.captureOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "get", "-g", "nemoclaw-8245", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(harness.connectManagedOpenShellSdkSpy).toHaveBeenCalledWith(
      { kind: "named", gatewayName: "nemoclaw-8245" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(harness.captureOpenshellSpy).toHaveBeenCalledWith([
      "sandbox",
      "start",
      "-g",
      "nemoclaw-8245",
      "alpha",
    ]);
    expect(exitSpy).not.toHaveBeenCalled();
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
