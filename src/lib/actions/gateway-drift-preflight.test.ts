// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

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

    spies.push(
      detectPreflightIssueSpy,
      detectResultIssueSpy,
      printIssueSpy,
      captureOpenshellSpy,
      backupSandboxStateSpy,
      classifyUpgradeableSandboxesSpy,
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

  it("backup-all fails before sandbox list when gateway image drift is detected", () => {
    detectPreflightIssueSpy.mockReturnValue(driftIssue);

    expect(() => backupAll()).toThrow("process.exit(1)");

    expect(printIssueSpy).toHaveBeenCalledWith(
      driftIssue,
      expect.objectContaining({ command: "nemoclaw backup-all" }),
    );
    expect(captureOpenshellSpy).not.toHaveBeenCalled();
    expect(backupSandboxStateSpy).not.toHaveBeenCalled();
  });

  it("backup-all fails closed on protobuf mismatch instead of treating sandboxes as stopped", () => {
    const protobufIssue: OpenShellStateRpcIssue = {
      kind: "protobuf_mismatch",
      output: "Sandbox.metadata: SandboxResponse.sandbox: invalid wire type value: 6",
    };
    captureOpenshellSpy.mockReturnValue({ status: 1, output: protobufIssue.output });
    detectResultIssueSpy.mockReturnValue(protobufIssue);

    expect(() => backupAll()).toThrow("process.exit(1)");

    expect(printIssueSpy).toHaveBeenCalledWith(
      protobufIssue,
      expect.objectContaining({ command: "nemoclaw backup-all" }),
    );
    expect(captureOpenshellSpy).toHaveBeenCalledWith(["sandbox", "list"]);
    expect(backupSandboxStateSpy).not.toHaveBeenCalled();
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
  });
});
