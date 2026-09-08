// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import * as gatewayDrift from "../../adapters/openshell/gateway-drift";
import * as openshellRuntime from "../../adapters/openshell/runtime";
import * as gatewayRuntime from "../../gateway-runtime-action";
import * as dockerDriverRecovery from "../../onboard/docker-driver-sandbox-recovery";
import * as registry from "../../state/registry";
import * as registryPersistence from "../../state/registry/persistence";
import { type RebuildSandboxEntry, resolveRebuildLiveState } from "./rebuild-flow-helpers";
import {
  checkRebuildGatewaySchemaPreflight,
  runRebuildGatewayIntentPreflight,
} from "./rebuild-preflight-guards";

const driftIssue: gatewayDrift.OpenShellStateRpcIssue = {
  kind: "image_drift",
  drift: {
    containerName: "openshell-cluster-nemoclaw",
    currentImage: "ghcr.io/nvidia/openshell/cluster:0.0.36",
    currentVersion: "0.0.36",
    expectedVersion: "0.0.37",
  },
};

const recoveryStates = [
  "missing_named",
  "named_unhealthy",
  "named_unreachable",
  "connected_other",
] as const;

function makeSandboxEntry(gatewayName = "nemoclaw", gatewayPort = 8080): RebuildSandboxEntry {
  return {
    name: "alpha",
    provider: "ollama-local",
    model: "nvidia/nemotron",
    nimContainer: null,
    agent: null,
    nemoclawVersion: "0.1.0",
    dashboardPort: 18789,
    gatewayName,
    gatewayPort,
  };
}

function bail(message: string): never {
  throw new Error(message);
}

describe("rebuild gateway drift preflight", () => {
  let captureOpenshellSpy: MockInstance;
  let runOpenshellSpy: MockInstance;
  let recoverNamedGatewayRuntimeSpy: MockInstance;
  let getNamedGatewayLifecycleStateSpy: MockInstance;
  let recoverDockerDriverSandboxSpy: MockInstance;
  let errorSpy: MockInstance;
  let logSpy: MockInstance;

  beforeEach(() => {
    vi.spyOn(gatewayDrift, "detectOpenShellStateRpcPreflightIssue").mockReturnValue(null);
    vi.spyOn(gatewayDrift, "detectOpenShellStateRpcResultIssue").mockReturnValue(null);
    vi.spyOn(gatewayDrift, "printOpenShellStateRpcIssue").mockImplementation(() => undefined);
    captureOpenshellSpy = vi
      .spyOn(openshellRuntime, "captureOpenshell")
      .mockReturnValue({ status: 0, output: "alpha Ready" });
    runOpenshellSpy = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockReturnValue({ status: 0, output: "" } as never);
    recoverNamedGatewayRuntimeSpy = vi
      .spyOn(gatewayRuntime, "recoverNamedGatewayRuntime")
      .mockResolvedValue({
        recovered: true,
        attempted: true,
        before: { state: "healthy_named" },
        after: { state: "healthy_named" },
      } as never);
    getNamedGatewayLifecycleStateSpy = vi
      .spyOn(gatewayRuntime, "getNamedGatewayLifecycleState")
      .mockReturnValue({ state: "healthy_named", activeGateway: "nemoclaw", status: "" } as never);
    recoverDockerDriverSandboxSpy = vi
      .spyOn(dockerDriverRecovery, "recoverDockerDriverSandbox")
      .mockReturnValue({ recovered: false, via: null });
    vi.spyOn(registry, "getSandbox").mockReturnValue(makeSandboxEntry() as never);
    vi.spyOn(registryPersistence, "load").mockReturnValue({
      sandboxes: { alpha: makeSandboxEntry() },
    } as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects gateway image drift before confirming rebuild intent", async () => {
    vi.mocked(gatewayDrift.detectOpenShellStateRpcPreflightIssue).mockReturnValue(driftIssue);
    const confirmIntent = vi.fn();

    await expect(
      runRebuildGatewayIntentPreflight({
        checkGatewaySchema: () =>
          checkRebuildGatewaySchemaPreflight("alpha", makeSandboxEntry(), bail),
        confirmIntent,
      }),
    ).rejects.toThrow("OpenShell gateway schema mismatch.");

    expect(gatewayDrift.detectOpenShellStateRpcPreflightIssue).toHaveBeenCalledWith({
      gatewayName: "nemoclaw",
    });
    expect(gatewayDrift.printOpenShellStateRpcIssue).toHaveBeenCalledWith(driftIssue, {
      action: "rebuilding sandbox 'alpha'",
      command: "nemoclaw alpha rebuild",
    });
    expect(confirmIntent).not.toHaveBeenCalled();
    expect(captureOpenshellSpy).not.toHaveBeenCalled();
    expect(recoverNamedGatewayRuntimeSpy).not.toHaveBeenCalled();
  });

  it("binds gateway schema preflight to the frozen runtime target (#10514)", () => {
    const runtimeSelection = {
      gatewayName: "nemoclaw",
      localTlsDir: "/authority/tls",
      workspace: "default",
    };

    expect(
      checkRebuildGatewaySchemaPreflight(
        "alpha",
        makeSandboxEntry(),
        bail,
        runtimeSelection,
      ),
    ).toBe(true);
    expect(gatewayDrift.detectOpenShellStateRpcPreflightIssue).toHaveBeenCalledWith({
      gatewayName: "nemoclaw",
      runtimeSelection,
    });
  });

  it("prints the safe-abort diagnostic before bailing on gateway schema drift (#7794)", () => {
    vi.mocked(gatewayDrift.detectOpenShellStateRpcPreflightIssue).mockReturnValue(driftIssue);
    const nonThrowingBail = vi.fn();

    expect(
      checkRebuildGatewaySchemaPreflight("alpha", makeSandboxEntry(), nonThrowingBail as never),
    ).toBe(false);

    const diagnostics = errorSpy.mock.calls.flat().join("\n");
    expect(diagnostics).toContain("Rebuild preflight failed:");
    expect(diagnostics).toContain("OpenShell gateway schema is incompatible with this rebuild.");
    expect(diagnostics).toContain("Follow the gateway recovery guidance above");
    expect(diagnostics).toContain("Aborting rebuild — sandbox is untouched, no data was lost.");
    expect(nonThrowingBail).toHaveBeenCalledWith("OpenShell gateway schema mismatch.");
  });

  it.each([
    {
      recordedGateway: "nemoclaw",
      recordedPort: 8080,
      activeGateway: "other-gw",
    },
    {
      recordedGateway: "nemoclaw-9000",
      recordedPort: 9000,
      activeGateway: "nemoclaw",
    },
  ])(
    "refuses missing $recordedGateway even while $activeGateway is ambiently active, after the gateway-pinned lookup (#4497)",
    async ({ recordedGateway, recordedPort, activeGateway }) => {
      const entry = makeSandboxEntry(recordedGateway, recordedPort);
      const registrySnapshot = { sandboxes: { alpha: entry } };
      vi.mocked(registry.getSandbox).mockReturnValue(entry as never);
      vi.mocked(registryPersistence.load).mockReturnValue(registrySnapshot as never);
      captureOpenshellSpy
        .mockReturnValueOnce({ status: 0, output: "" })
        .mockReturnValueOnce({ status: 1, output: "Error:   × Not Found: sandbox not found" });
      getNamedGatewayLifecycleStateSpy.mockReturnValue({
        state: "connected_other",
        activeGateway,
        status: `Gateway: ${activeGateway}\nStatus: Connected`,
      } as never);
      const behaviorLog = vi.fn();

      await expect(resolveRebuildLiveState("alpha", entry, behaviorLog, bail)).rejects.toThrow(
        "Cannot rebuild an absent sandbox without its authoritative OpenShell policy",
      );
      expect(getNamedGatewayLifecycleStateSpy).not.toHaveBeenCalled();
      expect(runOpenshellSpy).toHaveBeenCalledWith(
        ["gateway", "select", recordedGateway],
        expect.objectContaining({ ignoreError: true }),
      );
      expect(captureOpenshellSpy).toHaveBeenNthCalledWith(
        1,
        ["sandbox", "list", "-g", recordedGateway],
        expect.objectContaining({ ignoreError: true }),
      );
      expect(captureOpenshellSpy).toHaveBeenNthCalledWith(
        2,
        ["sandbox", "get", "-g", recordedGateway, "alpha"],
        expect.anything(),
      );
      expect(recoverDockerDriverSandboxSpy).toHaveBeenCalledWith("alpha");
      expect(registryPersistence.load).not.toHaveBeenCalled();
      expect(errorSpy.mock.calls.flat().join("\n")).toContain(
        "absent from the live OpenShell gateway",
      );
      expect(errorSpy.mock.calls.flat().join("\n")).toContain("nemoclaw alpha destroy --yes");
      expect(behaviorLog.mock.calls.flat().join("\n")).not.toContain("Stale-sandbox recovery");
    },
  );

  it.each([
    { gatewayName: "nemoclaw", gatewayPort: 8080 },
    { gatewayName: "nemoclaw-12345", gatewayPort: 12345 },
  ])(
    "recovers $gatewayName and refuses rebuild after confirming the sandbox is absent (#4497)",
    async ({ gatewayName, gatewayPort }) => {
      const entry = makeSandboxEntry(gatewayName, gatewayPort);
      const registrySnapshot = { sandboxes: { alpha: entry } };
      vi.mocked(registry.getSandbox).mockReturnValue(entry as never);
      vi.mocked(registryPersistence.load).mockReturnValue(registrySnapshot as never);
      captureOpenshellSpy
        .mockReturnValueOnce({ status: 0, output: "beta Ready" })
        .mockReturnValueOnce({ status: 1, output: "Error:   × Not Found: sandbox not found" });
      getNamedGatewayLifecycleStateSpy.mockReturnValue({
        state: "healthy_named",
        activeGateway: gatewayName,
        status: `Gateway: ${gatewayName}\nStatus: Connected`,
      } as never);
      const behaviorLog = vi.fn();

      await expect(resolveRebuildLiveState("alpha", entry, behaviorLog, bail)).rejects.toThrow(
        "Cannot rebuild an absent sandbox without its authoritative OpenShell policy",
      );
      expect(recoverNamedGatewayRuntimeSpy).toHaveBeenCalledOnce();
      expect(recoverNamedGatewayRuntimeSpy).toHaveBeenCalledWith({
        gatewayName,
        recoverableStates: recoveryStates,
      });
      expect(recoverNamedGatewayRuntimeSpy.mock.invocationCallOrder[0]).toBeLessThan(
        captureOpenshellSpy.mock.invocationCallOrder[0]!,
      );
      expect(captureOpenshellSpy).toHaveBeenNthCalledWith(
        1,
        ["sandbox", "list", "-g", gatewayName],
        expect.objectContaining({ ignoreError: true }),
      );
      expect(captureOpenshellSpy).toHaveBeenNthCalledWith(
        2,
        ["sandbox", "get", "-g", gatewayName, "alpha"],
        expect.anything(),
      );
      expect(getNamedGatewayLifecycleStateSpy).not.toHaveBeenCalled();
      expect(recoverDockerDriverSandboxSpy).toHaveBeenCalledWith("alpha");
      expect(registryPersistence.load).not.toHaveBeenCalled();
      expect(errorSpy.mock.calls.flat().join("\n")).toContain(
        "absent from the live OpenShell gateway",
      );
      expect(errorSpy.mock.calls.flat().join("\n")).toContain("nemoclaw alpha destroy --yes");
      expect(behaviorLog.mock.calls.flat().join("\n")).not.toContain("Stale-sandbox recovery");
    },
  );

  it("permits absent-sandbox recovery only with a verified transaction policy handoff", async () => {
    const entry = makeSandboxEntry();
    const registrySnapshot = { sandboxes: { alpha: entry } };
    vi.mocked(registryPersistence.load).mockReturnValue(registrySnapshot as never);
    captureOpenshellSpy
      .mockReturnValueOnce({ status: 0, output: "beta Ready" })
      .mockReturnValueOnce({
        status: 1,
        output: "Error:   × Not Found: sandbox not found",
      });
    const behaviorLog = vi.fn();

    await expect(
      resolveRebuildLiveState("alpha", entry, behaviorLog, bail, {
        authoritativeRecoveryPolicyAvailable: true,
      }),
    ).resolves.toEqual({
      staleRecovery: true,
      staleRegistrySnapshot: registrySnapshot,
    });

    expect(registryPersistence.load).toHaveBeenCalledOnce();
    expect(behaviorLog.mock.calls.flat().join("\n")).toContain(
      "transaction-bound policy handoff is intact",
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("recovers the named gateway before a generic sandbox-list query fails (#10421)", async () => {
    const entry = makeSandboxEntry();
    captureOpenshellSpy.mockReturnValueOnce({
      status: 1,
      output: "unknown option: sandbox list",
    });

    await expect(resolveRebuildLiveState("alpha", entry, vi.fn(), bail)).rejects.toThrow(
      "Failed to query running sandboxes from OpenShell.",
    );

    expect(recoverNamedGatewayRuntimeSpy).toHaveBeenCalledOnce();
    expect(recoverNamedGatewayRuntimeSpy).toHaveBeenCalledWith({
      gatewayName: "nemoclaw",
      recoverableStates: recoveryStates,
    });
    expect(captureOpenshellSpy).toHaveBeenCalledOnce();
    expect(captureOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "list", "-g", "nemoclaw"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(getNamedGatewayLifecycleStateSpy).not.toHaveBeenCalled();
    expect(recoverDockerDriverSandboxSpy).not.toHaveBeenCalled();
    expect(registryPersistence.load).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("Failed to query running sandboxes");
  });
});
