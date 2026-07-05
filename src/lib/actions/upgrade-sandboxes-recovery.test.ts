// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, describe, expect, it, vi } from "vitest";

type UpgradeSandboxes = typeof import("./upgrade-sandboxes")["upgradeSandboxes"];

const requireDist = createRequire(import.meta.url);
const upgradeModulePath = "./upgrade-sandboxes.js";

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

function createRecoveryHarness(
  names: string[],
  options: {
    gatewayNames?: Record<string, string>;
    liveOutput?: string;
    latestBackup?: ReturnType<typeof makeManifest> | null;
    registryOverrides?: Record<
      string,
      Partial<{
        agent: "openclaw" | "hermes" | null;
        agentVersion: string | null;
        nemoclawVersion: string | null;
      }>
    >;
    staleNames?: string[];
    useRealManagedEvidence?: boolean;
  } = {},
): {
  upgradeSandboxes: UpgradeSandboxes;
  rebuildSpy: ReturnType<typeof vi.fn>;
  latestBackupSpy: ReturnType<typeof vi.spyOn>;
  managedEvidenceSpy: ReturnType<typeof vi.spyOn>;
} {
  delete require.cache[requireDist.resolve(upgradeModulePath)];
  vi.stubEnv("NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE", "1");

  const coreVersion = requireDist("../core/version.js");
  const sandboxList = requireDist("../openshell-sandbox-list.js");
  const sandboxVersion = requireDist("../sandbox/version.js");
  const registry = requireDist("../state/registry.js");
  const sandboxState = requireDist("../state/sandbox.js");
  const rebuild = requireDist("./sandbox/rebuild.js");

  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(coreVersion, "getVersion").mockReturnValue("0.0.71");
  vi.spyOn(sandboxList, "captureSandboxListWithGatewayPreflightOrExit").mockResolvedValue({
    status: 0,
    output: options.liveOutput ?? names.map((name) => `${name} Error`).join("\n"),
  });
  vi.spyOn(registry, "listSandboxes").mockReturnValue({
    sandboxes: names.map((name) => ({
      name,
      agent: null,
      agentVersion: "2026.5.27",
      gatewayName: options.gatewayNames?.[name],
      nemoclawVersion: "0.0.71",
      ...options.registryOverrides?.[name],
    })),
  });
  vi.spyOn(sandboxVersion, "checkAgentVersion").mockImplementation((...args: unknown[]) => {
    const name = String(args[0]);
    return {
      sandboxVersion: options.staleNames?.includes(name) === true ? "2026.5.26" : "2026.5.27",
      expectedVersion: "2026.5.27",
      isStale: options.staleNames?.includes(name) === true,
      detectionMethod: "registry",
    };
  });
  const latestBackupSpy = vi
    .spyOn(sandboxState, "getLatestBackup")
    .mockImplementation((...args: unknown[]) =>
      options.latestBackup === undefined ? makeManifest(String(args[0])) : options.latestBackup,
    );
  vi.spyOn(sandboxState, "validateRebuildRecoveryManifest").mockImplementation(
    (...args: unknown[]) => ({
      ok: true as const,
      manifest: args[2] as ReturnType<typeof makeManifest>,
    }),
  );
  const managedEvidenceSpy = options.useRealManagedEvidence
    ? vi.spyOn(sandboxState, "hasPositiveManagedImageEvidence")
    : vi.spyOn(sandboxState, "hasPositiveManagedImageEvidence").mockReturnValue(true);
  const rebuildSpy = vi.spyOn(rebuild, "rebuildSandbox").mockResolvedValue(undefined);

  return {
    upgradeSandboxes: requireDist(upgradeModulePath).upgradeSandboxes,
    rebuildSpy,
    latestBackupSpy,
    managedEvidenceSpy,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete require.cache[requireDist.resolve(upgradeModulePath)];
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
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to recover 'alpha': alpha failed"),
    );
  });

  it("fails closed for a probed v0.0.55 custom image with matching backup agent version", async () => {
    const probedAgentVersion = "2026.5.27";
    const harness = createRecoveryHarness(["custom-box"], {
      latestBackup: {
        ...makeManifest("custom-box"),
        agentVersion: probedAgentVersion,
      },
      registryOverrides: {
        "custom-box": {
          agentVersion: probedAgentVersion,
          nemoclawVersion: null,
        },
      },
      useRealManagedEvidence: true,
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    await expect(harness.upgradeSandboxes({ auto: true })).rejects.toThrow("process.exit(1)");

    expect(harness.managedEvidenceSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentVersion: probedAgentVersion,
        nemoclawVersion: null,
      }),
    );
    expect(harness.rebuildSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("registry has no NemoClaw-managed image fingerprint"),
    );
  });

  it("warns and does not recover a stale registered sandbox absent from the selected gateway", async () => {
    const harness = createRecoveryHarness(["registered-elsewhere"], {
      gatewayNames: { "registered-elsewhere": "gateway-b" },
      liveOutput: "selected-gateway-box Ready",
      latestBackup: null,
      staleNames: ["registered-elsewhere"],
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    await expect(harness.upgradeSandboxes({ auto: true })).resolves.toBeUndefined();

    expect(harness.rebuildSpy).not.toHaveBeenCalled();
    expect(harness.latestBackupSpy).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Skipping 1 sandbox(es) not observed on the selected gateway"),
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("attempts both a live stale rebuild and a prepared non-Ready recovery", async () => {
    const harness = createRecoveryHarness(["stale-box", "recovery-box"], {
      liveOutput: "stale-box Ready\nrecovery-box Error",
      staleNames: ["stale-box"],
    });

    await expect(harness.upgradeSandboxes({ auto: true })).resolves.toBeUndefined();

    expect(harness.rebuildSpy).toHaveBeenCalledTimes(2);
    expect(harness.rebuildSpy).toHaveBeenNthCalledWith(1, "stale-box", ["--yes"], {
      throwOnError: true,
      recoveryManifest: undefined,
    });
    expect(harness.rebuildSpy).toHaveBeenNthCalledWith(2, "recovery-box", ["--yes"], {
      throwOnError: true,
      recoveryManifest: expect.objectContaining({ sandboxName: "recovery-box" }),
    });
  });

  it("fails closed for a live Error sandbox with no latest backup", async () => {
    const harness = createRecoveryHarness(["broken-box"], {
      latestBackup: null,
      staleNames: ["broken-box"],
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    await expect(harness.upgradeSandboxes({ auto: true })).rejects.toThrow("process.exit(1)");

    expect(harness.rebuildSpy).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("broken-box"));
    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining("verify their recorded gateway or start them first"),
    );
  });

  it("continues after one live sandbox's backup assessment throws", async () => {
    const harness = createRecoveryHarness(["alpha", "beta"]);
    harness.latestBackupSpy
      .mockImplementationOnce(() => {
        throw new Error("ENOTDIR: unreadable backup root");
      })
      .mockImplementationOnce((name: string) => makeManifest(name));
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    await expect(harness.upgradeSandboxes({ auto: true })).rejects.toThrow("process.exit(1)");

    expect(harness.rebuildSpy).toHaveBeenCalledOnce();
    expect(harness.rebuildSpy).toHaveBeenCalledWith("beta", ["--yes"], {
      throwOnError: true,
      recoveryManifest: expect.objectContaining({ sandboxName: "beta" }),
    });
  });
});
