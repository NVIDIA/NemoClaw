// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import * as gatewayDrift from "../../adapters/openshell/gateway-drift";
import * as openshellRuntime from "../../adapters/openshell/runtime";
import * as gatewayRuntime from "../../gateway-runtime-action";
import * as dockerDriverRecovery from "../../onboard/docker-driver-sandbox-recovery";
import * as registry from "../../state/registry";
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
    policies: [],
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
    vi.spyOn(registry, "load").mockReturnValue({
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
  ])("refuses stale recovery when $activeGateway is active instead of recorded gateway $recordedGateway (#4497)", async ({
    recordedGateway,
    recordedPort,
    activeGateway,
  }) => {
    const entry = makeSandboxEntry(recordedGateway, recordedPort);
    vi.mocked(registry.getSandbox).mockReturnValue(entry as never);
    captureOpenshellSpy
      .mockReturnValueOnce({ status: 0, output: "" })
      .mockReturnValueOnce({ status: 1, output: "Error:   × Not Found: sandbox not found" })
      .mockReturnValueOnce({ status: 1, output: "Error:   × Not Found: sandbox not found" });
    getNamedGatewayLifecycleStateSpy.mockReturnValue({
      state: "connected_other",
      activeGateway,
      status: `Gateway: ${activeGateway}\nStatus: Connected`,
    } as never);
    const behaviorLog = vi.fn();

    await expect(resolveRebuildLiveState("alpha", entry, behaviorLog, bail)).rejects.toThrow(
      "Could not confirm live state",
    );

    expect(getNamedGatewayLifecycleStateSpy).toHaveBeenCalledWith(recordedGateway);
    expect(runOpenshellSpy).toHaveBeenCalledWith(
      ["gateway", "select", recordedGateway],
      expect.objectContaining({ ignoreError: true }),
    );
    const output = errorSpy.mock.calls.flat().join("\n");
    expect(output).toContain("NOT been removed");
    expect(output).toContain(`openshell gateway select ${recordedGateway}`);
    expect(registry.load).not.toHaveBeenCalled();
    expect(recoverDockerDriverSandboxSpy).not.toHaveBeenCalled();
    expect([...logSpy.mock.calls, ...behaviorLog.mock.calls].flat().join("\n")).not.toContain(
      "No live workspace state to back up",
    );
  });

  it.each([
    { gatewayName: "nemoclaw", gatewayPort: 8080 },
    { gatewayName: "nemoclaw-12345", gatewayPort: 12345 },
  ])("recovers $gatewayName and returns stale state after confirming the sandbox is absent (#4497)", async ({
    gatewayName,
    gatewayPort,
  }) => {
    const entry = makeSandboxEntry(gatewayName, gatewayPort);
    const registrySnapshot = { sandboxes: { alpha: entry } };
    vi.mocked(registry.getSandbox).mockReturnValue(entry as never);
    vi.mocked(registry.load).mockReturnValue(registrySnapshot as never);
    captureOpenshellSpy
      .mockReturnValueOnce({
        status: 1,
        output: "client error (Connect): Connection refused",
      })
      .mockReturnValueOnce({ status: 0, output: "beta Ready" })
      .mockReturnValueOnce({ status: 1, output: "Error:   × Not Found: sandbox not found" });
    getNamedGatewayLifecycleStateSpy.mockReturnValue({
      state: "healthy_named",
      activeGateway: gatewayName,
      status: `Gateway: ${gatewayName}\nStatus: Connected`,
    } as never);
    const behaviorLog = vi.fn();

    const result = await resolveRebuildLiveState("alpha", entry, behaviorLog, bail);

    expect(result).toEqual({
      staleRecovery: true,
      staleRegistrySnapshot: registrySnapshot,
    });
    expect(result?.staleRegistrySnapshot).not.toBe(registrySnapshot);
    expect(recoverNamedGatewayRuntimeSpy).toHaveBeenCalledTimes(2);
    expect(recoverNamedGatewayRuntimeSpy).toHaveBeenNthCalledWith(1, {
      gatewayName,
      recoverableStates: recoveryStates,
    });
    expect(recoverNamedGatewayRuntimeSpy).toHaveBeenNthCalledWith(2, {
      gatewayName,
      recoverableStates: recoveryStates,
    });
    expect(captureOpenshellSpy).toHaveBeenNthCalledWith(1, ["sandbox", "list"]);
    expect(captureOpenshellSpy).toHaveBeenNthCalledWith(2, ["sandbox", "list"]);
    expect(captureOpenshellSpy).toHaveBeenNthCalledWith(
      3,
      ["sandbox", "get", "alpha"],
      expect.anything(),
    );
    expect(getNamedGatewayLifecycleStateSpy).toHaveBeenCalledWith(gatewayName);
    expect(recoverDockerDriverSandboxSpy).toHaveBeenCalledWith("alpha");
    expect(registry.load).toHaveBeenCalledOnce();
    expect(logSpy.mock.calls.flat().join("\n")).toContain("absent from the live OpenShell gateway");
    expect(behaviorLog.mock.calls.flat().join("\n")).toContain("Stale-sandbox recovery");
  });

  it("fails without a sandbox-list retry after a generic query error", async () => {
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
    expect(captureOpenshellSpy).toHaveBeenCalledWith(["sandbox", "list"]);
    expect(getNamedGatewayLifecycleStateSpy).not.toHaveBeenCalled();
    expect(recoverDockerDriverSandboxSpy).not.toHaveBeenCalled();
    expect(registry.load).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("Failed to query running sandboxes");
  });
});
