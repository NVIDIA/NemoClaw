// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, describe, expect, it, vi } from "vitest";

type UpgradeSandboxes = typeof import("./upgrade-sandboxes")["upgradeSandboxes"];

const requireDist = createRequire(import.meta.url);
const upgradeModulePath = "./upgrade-sandboxes.js";
const originalRecoverySignal = process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE;

// Warm the CommonJS source graph outside the first test's timeout. Each harness
// still reloads the entry module after installing its dependency spies.
requireDist(upgradeModulePath);
delete require.cache[requireDist.resolve(upgradeModulePath)];

function makeManifest(sandboxName: string) {
  const timestamp = `2026-07-01T06-50-4${sandboxName.length}-044Z`;
  return {
    version: 1,
    sandboxName,
    timestamp,
    agentType: "openclaw",
    agentVersion: "2026.5.27",
    expectedVersion: "2026.5.27",
    stateDirs: ["workspace"],
    backedUpDirs: ["workspace"],
    stateFiles: [],
    dir: "/sandbox/.openclaw",
    backupPath: `/tmp/rebuild-backups/${sandboxName}/${timestamp}`,
    blueprintDigest: null,
    policyPresets: [],
    customPolicies: [],
    snapshotVersion: 1,
  };
}

function createRecoveryHarness(names: string[]): {
  upgradeSandboxes: UpgradeSandboxes;
  rebuildSpy: ReturnType<typeof vi.fn>;
  managedEvidenceSpy: ReturnType<typeof vi.spyOn>;
} {
  delete require.cache[requireDist.resolve(upgradeModulePath)];
  process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE = "1";

  const gatewayDrift = requireDist("../adapters/openshell/gateway-drift.js");
  const coreVersion = requireDist("../core/version.js");
  const sandboxList = requireDist("../openshell-sandbox-list.js");
  const sandboxVersion = requireDist("../sandbox/version.js");
  const registry = requireDist("../state/registry.js");
  const sandboxState = requireDist("../state/sandbox.js");
  const rebuild = requireDist("./sandbox/rebuild.js");

  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(gatewayDrift, "detectOpenShellStateRpcPreflightIssue").mockReturnValue(null);
  vi.spyOn(gatewayDrift, "detectOpenShellStateRpcResultIssue").mockReturnValue(null);
  vi.spyOn(coreVersion, "getVersion").mockReturnValue("0.0.71");
  vi.spyOn(sandboxList, "captureSandboxListWithGatewayRecovery").mockResolvedValue({
    result: {
      status: 0,
      output: names.map((name) => `${name} Error`).join("\n"),
    },
    recoveryAttempted: false,
    recoverySucceeded: false,
  });
  vi.spyOn(registry, "listSandboxes").mockReturnValue({
    sandboxes: names.map((name) => ({
      name,
      agent: null,
      agentVersion: "2026.5.27",
      nemoclawVersion: "0.0.71",
    })),
  });
  vi.spyOn(sandboxVersion, "checkAgentVersion").mockReturnValue({
    sandboxVersion: "2026.5.27",
    expectedVersion: "2026.5.27",
    isStale: false,
    detectionMethod: "registry",
  });
  vi.spyOn(sandboxState, "getLatestBackup").mockImplementation((...args: unknown[]) =>
    makeManifest(String(args[0])),
  );
  vi.spyOn(sandboxState, "validateRebuildRecoveryManifest").mockImplementation(
    (...args: unknown[]) => ({
      ok: true as const,
      manifest: args[2] as ReturnType<typeof makeManifest>,
    }),
  );
  const managedEvidenceSpy = vi
    .spyOn(sandboxState, "hasPositiveManagedImageEvidence")
    .mockReturnValue(true);
  const rebuildSpy = vi.spyOn(rebuild, "rebuildSandbox").mockResolvedValue(undefined);

  return {
    upgradeSandboxes: requireDist(upgradeModulePath).upgradeSandboxes,
    rebuildSpy,
    managedEvidenceSpy,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete require.cache[requireDist.resolve(upgradeModulePath)];
  if (originalRecoverySignal === undefined) {
    delete process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE;
  } else {
    process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE = originalRecoverySignal;
  }
});

describe("upgrade-sandboxes prepared backup recovery (#6114)", () => {
  it("passes every non-Ready sandbox's validated manifest into rebuild", async () => {
    const harness = createRecoveryHarness(["alpha", "beta"]);

    await expect(harness.upgradeSandboxes({ auto: true })).resolves.toBeUndefined();

    expect(harness.rebuildSpy).toHaveBeenCalledTimes(2);
    for (const name of ["alpha", "beta"]) {
      expect(harness.rebuildSpy).toHaveBeenCalledWith(name, ["--yes"], {
        throwOnError: true,
        recoveryManifest: expect.objectContaining({ sandboxName: name }),
      });
    }
  });

  it("continues through all eligible sandboxes before reporting a recovery failure", async () => {
    const harness = createRecoveryHarness(["alpha", "beta"]);
    harness.rebuildSpy.mockRejectedValueOnce(new Error("alpha failed"));
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    await expect(harness.upgradeSandboxes({ auto: true })).rejects.toThrow("process.exit(1)");

    expect(harness.rebuildSpy).toHaveBeenCalledTimes(2);
    expect(harness.rebuildSpy.mock.calls.map((call) => call[0])).toEqual(["alpha", "beta"]);
  });

  it("fails closed without rebuilding a legacy custom-image backup", async () => {
    const harness = createRecoveryHarness(["custom-box"]);
    harness.managedEvidenceSpy.mockReturnValue(false);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    await expect(harness.upgradeSandboxes({ auto: true })).rejects.toThrow("process.exit(1)");

    expect(harness.rebuildSpy).not.toHaveBeenCalled();
  });
});
