// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import type { OpenShellStateRpcIssue } from "../adapters/openshell/gateway-drift";

type BackupAll = typeof import("../../../dist/lib/actions/maintenance")["backupAll"];
type UpgradeSandboxes =
  typeof import("../../../dist/lib/actions/upgrade-sandboxes")["upgradeSandboxes"];

const requireDist = createRequire(import.meta.url);

const driftIssue: OpenShellStateRpcIssue = {
  kind: "image_drift",
  drift: {
    containerName: "openshell-cluster-nemoclaw",
    currentImage: "ghcr.io/nvidia/openshell/cluster:0.0.36",
    currentVersion: "0.0.36",
    expectedVersion: "0.0.37",
  },
};

const hostProcessDriftIssue: OpenShellStateRpcIssue = {
  kind: "host_process_drift",
  drift: {
    gatewayBin: "/home/u/.local/bin/openshell-gateway",
    currentVersion: "0.0.43",
    expectedVersion: "0.0.44",
  },
};

function mockExit() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as never);
}

describe("gateway drift preflight for maintenance actions", () => {
  let backupAll: BackupAll;
  let upgradeSandboxes: UpgradeSandboxes;
  let exitSpy: ReturnType<typeof mockExit>;
  let errorSpy: MockInstance;
  let spies: MockInstance[];
  let captureOpenshellSpy: MockInstance;
  let backupSandboxStateSpy: MockInstance;
  let classifyUpgradeableSandboxesSpy: MockInstance;
  let detectPreflightIssueSpy: MockInstance;
  let detectResultIssueSpy: MockInstance;
  let printIssueSpy: MockInstance;
  let recoverNamedGatewayRuntimeSpy: MockInstance;

  beforeEach(async () => {
    spies = [];
    exitSpy = mockExit();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const gatewayDrift = requireDist("../../../dist/lib/adapters/openshell/gateway-drift.js");
    const openshellRuntime = requireDist("../../../dist/lib/adapters/openshell/runtime.js");
    const registry = requireDist("../../../dist/lib/state/registry.js");
    const sandboxState = requireDist("../../../dist/lib/state/sandbox.js");
    const sandboxVersion = requireDist("../../../dist/lib/sandbox/version.js");
    const upgradeDomain = requireDist("../../../dist/lib/domain/maintenance/upgrade.js");
    const rebuild = requireDist("../../../dist/lib/actions/sandbox/rebuild.js");
    const gatewayRuntime = requireDist("../../../dist/lib/gateway-runtime-action.js");

    detectPreflightIssueSpy = vi
      .spyOn(gatewayDrift, "detectOpenShellStateRpcPreflightIssue")
      .mockReturnValue(null);
    detectResultIssueSpy = vi
      .spyOn(gatewayDrift, "detectOpenShellStateRpcResultIssue")
      .mockReturnValue(null);
    printIssueSpy = vi
      .spyOn(gatewayDrift, "printOpenShellStateRpcIssue")
      .mockImplementation(() => undefined);
    captureOpenshellSpy = vi
      .spyOn(openshellRuntime, "captureOpenshell")
      .mockReturnValue({ status: 0, output: "alpha Ready" });
    backupSandboxStateSpy = vi.spyOn(sandboxState, "backupSandboxState").mockReturnValue({
      success: true,
      backedUpDirs: ["workspace"],
      backedUpFiles: [],
      failedDirs: [],
      failedFiles: [],
      manifest: { backupPath: "/tmp/backup" },
    } as never);
    classifyUpgradeableSandboxesSpy = vi
      .spyOn(upgradeDomain, "classifyUpgradeableSandboxes")
      .mockReturnValue({ stale: [], unknown: [] });
    recoverNamedGatewayRuntimeSpy = vi
      .spyOn(gatewayRuntime, "recoverNamedGatewayRuntime")
      .mockResolvedValue({ recovered: true });

    spies.push(
      detectPreflightIssueSpy,
      detectResultIssueSpy,
      printIssueSpy,
      captureOpenshellSpy,
      backupSandboxStateSpy,
      classifyUpgradeableSandboxesSpy,
      recoverNamedGatewayRuntimeSpy,
      vi.spyOn(registry, "listSandboxes").mockReturnValue({
        sandboxes: [{ name: "alpha", provider: "nvidia-prod", model: "nemotron" }],
      } as never),
      vi.spyOn(sandboxVersion, "checkAgentVersion").mockReturnValue({} as never),
      vi.spyOn(upgradeDomain, "shouldSkipUpgradeConfirmation").mockReturnValue(true),
      vi.spyOn(upgradeDomain, "splitRebuildableSandboxes").mockReturnValue({
        rebuildable: [],
        stopped: [],
      }),
      vi.spyOn(rebuild, "rebuildSandbox").mockResolvedValue(undefined),
    );

    ({ backupAll } = requireDist("../../../dist/lib/actions/maintenance.js"));
    ({ upgradeSandboxes } = requireDist("../../../dist/lib/actions/upgrade-sandboxes.js"));
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("backup-all fails before sandbox list when gateway image drift is detected", async () => {
    detectPreflightIssueSpy.mockReturnValue(driftIssue);

    await expect(backupAll()).rejects.toThrow("process.exit(1)");

    expect(printIssueSpy).toHaveBeenCalledWith(
      driftIssue,
      expect.objectContaining({ command: "nemoclaw backup-all" }),
    );
    expect(captureOpenshellSpy).not.toHaveBeenCalled();
    expect(backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(recoverNamedGatewayRuntimeSpy).not.toHaveBeenCalled();
  });

  it("backup-all fails before sandbox list on host-process gateway binary drift", async () => {
    detectPreflightIssueSpy.mockReturnValue(hostProcessDriftIssue);

    await expect(backupAll()).rejects.toThrow("process.exit(1)");

    expect(printIssueSpy).toHaveBeenCalledWith(
      hostProcessDriftIssue,
      expect.objectContaining({ command: "nemoclaw backup-all" }),
    );
    expect(captureOpenshellSpy).not.toHaveBeenCalled();
    expect(backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(recoverNamedGatewayRuntimeSpy).not.toHaveBeenCalled();
  });

  it("upgrade-sandboxes fails before sandbox list on host-process gateway binary drift", async () => {
    detectPreflightIssueSpy.mockReturnValue(hostProcessDriftIssue);

    await expect(upgradeSandboxes({ check: true })).rejects.toThrow("process.exit(1)");

    expect(printIssueSpy).toHaveBeenCalledWith(
      hostProcessDriftIssue,
      expect.objectContaining({ command: "nemoclaw upgrade-sandboxes" }),
    );
    expect(captureOpenshellSpy).not.toHaveBeenCalled();
    expect(classifyUpgradeableSandboxesSpy).not.toHaveBeenCalled();
    expect(recoverNamedGatewayRuntimeSpy).not.toHaveBeenCalled();
  });

  it("backup-all recovers the named gateway and retries the sandbox list before backing up", async () => {
    captureOpenshellSpy
      .mockReturnValueOnce({ status: 1, output: "client error (Connect): Connection refused" })
      .mockReturnValueOnce({ status: 0, output: "alpha Ready" });

    await backupAll();

    expect(recoverNamedGatewayRuntimeSpy).toHaveBeenCalledWith({
      recoverableStates: [
        "missing_named",
        "named_unhealthy",
        "named_unreachable",
        "connected_other",
      ],
    });
    expect(captureOpenshellSpy).toHaveBeenCalledTimes(2);
    expect(captureOpenshellSpy).toHaveBeenNthCalledWith(1, ["sandbox", "list"]);
    expect(captureOpenshellSpy).toHaveBeenNthCalledWith(2, ["sandbox", "list"]);
    expect(backupSandboxStateSpy).toHaveBeenCalledWith("alpha");
  });

  it("backup-all does not recover generic sandbox list failures", async () => {
    captureOpenshellSpy.mockReturnValue({ status: 1, output: "usage: openshell sandbox list" });

    await expect(backupAll()).rejects.toThrow("process.exit(1)");

    expect(recoverNamedGatewayRuntimeSpy).not.toHaveBeenCalled();
    expect(captureOpenshellSpy).toHaveBeenCalledTimes(1);
    expect(backupSandboxStateSpy).not.toHaveBeenCalled();
  });

  it("backup-all skips sandboxes that are not in Ready phase", async () => {
    const registry = requireDist("../../../dist/lib/state/registry.js");
    (registry.listSandboxes as ReturnType<typeof vi.fn>).mockReturnValue({
      sandboxes: [
        { name: "alpha", provider: "nvidia-prod", model: "nemotron" },
        { name: "beta", provider: "nvidia-prod", model: "nemotron" },
      ],
    });
    captureOpenshellSpy.mockReturnValue({
      status: 0,
      output: [
        "NAME              NAMESPACE  CREATED              PHASE",
        "alpha             openshell  2026-03-24 10:00:00  Ready",
        "beta              openshell  2026-03-24 10:01:00  Error",
      ].join("\n"),
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    spies.push(logSpy);

    await backupAll();

    expect(backupSandboxStateSpy).toHaveBeenCalledWith("alpha");
    expect(backupSandboxStateSpy).not.toHaveBeenCalledWith("beta");
    expect(logSpy.mock.calls.flat().join("\n")).toContain("Skipping 'beta' (not running)");
  });

  it("backup-all fails closed on protobuf mismatch instead of treating sandboxes as stopped", async () => {
    const protobufIssue: OpenShellStateRpcIssue = {
      kind: "protobuf_mismatch",
      output: "Sandbox.metadata: SandboxResponse.sandbox: invalid wire type value: 6",
    };
    captureOpenshellSpy.mockReturnValue({ status: 1, output: protobufIssue.output });
    detectResultIssueSpy.mockReturnValue(protobufIssue);

    await expect(backupAll()).rejects.toThrow("process.exit(1)");

    expect(printIssueSpy).toHaveBeenCalledWith(
      protobufIssue,
      expect.objectContaining({ command: "nemoclaw backup-all" }),
    );
    expect(captureOpenshellSpy).toHaveBeenCalledWith(["sandbox", "list"]);
    expect(backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(recoverNamedGatewayRuntimeSpy).not.toHaveBeenCalled();
  });

  it("upgrade-sandboxes fails before sandbox list when gateway image drift is detected", async () => {
    detectPreflightIssueSpy.mockReturnValue(driftIssue);

    await expect(upgradeSandboxes({ check: true })).rejects.toThrow("process.exit(1)");

    expect(printIssueSpy).toHaveBeenCalledWith(
      driftIssue,
      expect.objectContaining({ command: "nemoclaw upgrade-sandboxes" }),
    );
    expect(captureOpenshellSpy).not.toHaveBeenCalled();
    expect(classifyUpgradeableSandboxesSpy).not.toHaveBeenCalled();
    expect(recoverNamedGatewayRuntimeSpy).not.toHaveBeenCalled();
  });

  it("upgrade-sandboxes recovers the named gateway and retries before classifying sandboxes", async () => {
    captureOpenshellSpy
      .mockReturnValueOnce({ status: 1, output: "client error (Connect): Connection refused" })
      .mockReturnValueOnce({ status: 0, output: "alpha Ready" });

    await upgradeSandboxes({ check: true });

    expect(recoverNamedGatewayRuntimeSpy).toHaveBeenCalledWith({
      recoverableStates: [
        "missing_named",
        "named_unhealthy",
        "named_unreachable",
        "connected_other",
      ],
    });
    expect(captureOpenshellSpy).toHaveBeenCalledTimes(2);
    expect(classifyUpgradeableSandboxesSpy).toHaveBeenCalledWith(
      [{ name: "alpha", provider: "nvidia-prod", model: "nemotron" }],
      new Set(["alpha"]),
      expect.any(Function),
      // #5026: the running NemoClaw build is passed so image drift is detected.
      expect.objectContaining({ currentNemoclawVersion: expect.any(String) }),
    );
  });

  it("upgrade-sandboxes does not recover generic sandbox list failures", async () => {
    captureOpenshellSpy.mockReturnValue({ status: 1, output: "unknown option: --json" });

    await expect(upgradeSandboxes({ check: true })).rejects.toThrow("process.exit(1)");

    expect(recoverNamedGatewayRuntimeSpy).not.toHaveBeenCalled();
    expect(captureOpenshellSpy).toHaveBeenCalledTimes(1);
    expect(classifyUpgradeableSandboxesSpy).not.toHaveBeenCalled();
  });

  it("upgrade-sandboxes fails closed on protobuf mismatch before classifying stopped sandboxes", async () => {
    const protobufIssue: OpenShellStateRpcIssue = {
      kind: "protobuf_mismatch",
      output: "Sandbox.metadata: SandboxResponse.sandbox: invalid wire type value: 6",
    };
    captureOpenshellSpy.mockReturnValue({ status: 1, output: protobufIssue.output });
    detectResultIssueSpy.mockReturnValue(protobufIssue);

    await expect(upgradeSandboxes({ check: true })).rejects.toThrow("process.exit(1)");

    expect(printIssueSpy).toHaveBeenCalledWith(
      protobufIssue,
      expect.objectContaining({ command: "nemoclaw upgrade-sandboxes" }),
    );
    expect(captureOpenshellSpy).toHaveBeenCalledWith(["sandbox", "list"]);
    expect(classifyUpgradeableSandboxesSpy).not.toHaveBeenCalled();
    expect(recoverNamedGatewayRuntimeSpy).not.toHaveBeenCalled();
  });
});
