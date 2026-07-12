// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import * as coreVersion from "../core/version";
import * as sandboxList from "../openshell-sandbox-list";
import * as sandboxVersion from "../sandbox/version";
import * as registry from "../state/registry";
import * as sandboxState from "../state/sandbox";
import { upgradeSandboxes, upgradeSandboxesDependencies } from "./upgrade-sandboxes";

type UpgradeSandboxes = typeof upgradeSandboxes;

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
    gatewayPort?: number;
    liveOutput?: string;
    latestBackup?: ReturnType<typeof makeManifest> | null;
    registryOverrides?: Record<
      string,
      Partial<{
        agent: "openclaw" | "hermes" | "langchain-deepagents-code" | null;
        agentVersion: string | null;
        nemoclawVersion: string | null;
        fromDockerfile: string | null;
      }>
    >;
    confirmedLegacyManagedNames?: string[] | string;
    staleNames?: string[];
    useRealManagedEvidence?: boolean;
  } = {},
): {
  upgradeSandboxes: UpgradeSandboxes;
  rebuildSpy: ReturnType<typeof vi.fn>;
  latestBackupSpy: ReturnType<typeof vi.spyOn>;
  managedEvidenceSpy: ReturnType<typeof vi.spyOn>;
  liveListSpy: ReturnType<typeof vi.spyOn>;
} {
  vi.stubEnv("NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE", "1");
  vi.stubEnv(
    "NEMOCLAW_CONFIRMED_LEGACY_MANAGED_SANDBOXES",
    typeof options.confirmedLegacyManagedNames === "string"
      ? options.confirmedLegacyManagedNames
      : JSON.stringify(options.confirmedLegacyManagedNames ?? []),
  );

  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(upgradeSandboxesDependencies, "getGatewayPort").mockReturnValue(
    options.gatewayPort ?? 8080,
  );
  vi.spyOn(coreVersion, "getVersion").mockReturnValue("0.0.71");
  const liveListSpy = vi
    .spyOn(sandboxList, "captureSandboxListWithGatewayPreflightOrExit")
    .mockResolvedValue({
      status: 0,
      output: options.liveOutput ?? names.map((name) => `${name} Error`).join("\n"),
    });
  vi.spyOn(registry, "listSandboxes").mockReturnValue({
    defaultSandbox: null,
    sandboxes: names.map((name) => ({
      name,
      agent: null,
      agentVersion: "2026.5.27",
      gatewayName: options.gatewayNames?.[name],
      gatewayPort: options.gatewayPort,
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
      verificationFailed: false,
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
  const rebuildSpy = vi
    .spyOn(upgradeSandboxesDependencies, "rebuildSandbox")
    .mockResolvedValue(undefined);

  return {
    upgradeSandboxes,
    rebuildSpy,
    latestBackupSpy,
    managedEvidenceSpy,
    liveListSpy,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

  it("fails closed for an absent same-gateway legacy sandbox without a managed fingerprint", async () => {
    const harness = createRecoveryHarness(["legacy-box"], {
      liveOutput: "other-box Ready",
      registryOverrides: {
        "legacy-box": { nemoclawVersion: null },
      },
      useRealManagedEvidence: true,
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    await expect(harness.upgradeSandboxes({ auto: true })).rejects.toThrow("process.exit(1)");

    expect(harness.liveListSpy).toHaveBeenCalledTimes(2);
    expect(harness.latestBackupSpy).toHaveBeenCalledWith("legacy-box");
    expect(harness.rebuildSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("registry has no NemoClaw-managed image fingerprint"),
    );
  });

  it("recovers an explicitly confirmed v0.0.55 managed-image row (#6114)", async () => {
    const harness = createRecoveryHarness(["legacy-box"], {
      confirmedLegacyManagedNames: ["legacy-box"],
      registryOverrides: {
        "legacy-box": { agent: null, nemoclawVersion: null },
      },
      useRealManagedEvidence: true,
    });

    await expect(harness.upgradeSandboxes({ auto: true })).resolves.toBeUndefined();

    expect(harness.rebuildSpy).toHaveBeenCalledWith("legacy-box", ["--yes"], {
      throwOnError: true,
      recoveryManifest: expect.objectContaining({ sandboxName: "legacy-box" }),
      allowLegacyManagedImageRecovery: true,
    });
  });

  it("does not apply legacy confirmation to another sandbox name (#6114)", async () => {
    const harness = createRecoveryHarness(["legacy-box"], {
      confirmedLegacyManagedNames: ["other-box"],
      registryOverrides: {
        "legacy-box": { agent: null, nemoclawVersion: null },
      },
      useRealManagedEvidence: true,
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    await expect(harness.upgradeSandboxes({ auto: true })).rejects.toThrow("process.exit(1)");

    expect(harness.rebuildSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(console.warn).toHaveBeenCalledWith(
      '  Warning: confirmed legacy managed-image sandbox "other-box" is not registered; ignoring it.',
    );
  });

  it.each([
    "not-json",
    '{"legacy-box":true}',
    '["legacy-box",1]',
  ])("rejects malformed scoped confirmation %s (#6114)", async (confirmedLegacyManagedNames) => {
    const harness = createRecoveryHarness(["legacy-box"], {
      confirmedLegacyManagedNames,
      registryOverrides: {
        "legacy-box": { agent: null, nemoclawVersion: null },
      },
      useRealManagedEvidence: true,
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    await expect(harness.upgradeSandboxes({ auto: true })).rejects.toThrow("process.exit(1)");

    expect(harness.rebuildSpy).not.toHaveBeenCalled();
  });

  it("does not let legacy confirmation override a recorded custom image (#6114)", async () => {
    const harness = createRecoveryHarness(["custom-box"], {
      confirmedLegacyManagedNames: ["custom-box"],
      registryOverrides: {
        "custom-box": {
          agent: null,
          nemoclawVersion: null,
          fromDockerfile: "/tmp/custom.Dockerfile",
        },
      },
      useRealManagedEvidence: true,
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    await expect(harness.upgradeSandboxes({ auto: true })).rejects.toThrow("process.exit(1)");

    expect(harness.rebuildSpy).not.toHaveBeenCalled();
  });

  it("does not authorize DCode with a legacy managed-image confirmation (#6114)", async () => {
    const harness = createRecoveryHarness(["dcode-box"], {
      confirmedLegacyManagedNames: ["dcode-box"],
      registryOverrides: {
        "dcode-box": { agent: "langchain-deepagents-code", nemoclawVersion: null },
      },
      useRealManagedEvidence: true,
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    await expect(harness.upgradeSandboxes({ auto: true })).rejects.toThrow("process.exit(1)");

    expect(harness.rebuildSpy).not.toHaveBeenCalled();
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

  it("flags an own-gateway orphan with the dedicated marker and remediation when backup recovery is unavailable (#6520)", async () => {
    // The direct #6520 repro: `nemoclaw uninstall --yes` preserves
    // sandboxes.json but removes the gateway and Docker image; a same-version
    // reinstall classifies the recorded sandbox "current", so staleness never
    // fires. The orphan marker must fire anyway — it is derived from
    // registry-vs-live observation, not version classification.
    const harness = createRecoveryHarness(["my-assistant"], {
      liveOutput: "other-box Ready",
    });
    vi.stubEnv("NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE", "0");

    await expect(harness.upgradeSandboxes({ auto: true })).resolves.toBeUndefined();

    expect(harness.rebuildSpy).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalledWith("  All sandboxes are up to date.");
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "1 recorded sandbox(es) were not found on their recorded gateway: my-assistant",
      ),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("cannot be recovered automatically"),
    );
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("destroy` to clear"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("onboard` to rebuild"));
  });

  it("does not double-report an unknown-version orphan under the Unknown version list (#6520)", async () => {
    // An orphan with no cached or probeable version would otherwise land in
    // the "Unknown version" bucket ("start them and rerun") AND the orphan
    // block (destroy/onboard) — conflicting guidance for the same record.
    const harness = createRecoveryHarness(["my-assistant"], {
      liveOutput: "other-box Ready",
    });
    vi.stubEnv("NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE", "0");
    vi.spyOn(sandboxVersion, "checkAgentVersion").mockReturnValue({
      sandboxVersion: null,
      expectedVersion: "2026.5.27",
      isStale: false,
      verificationFailed: true,
      detectionMethod: "registry",
    });

    await expect(harness.upgradeSandboxes({ auto: true })).resolves.toBeUndefined();

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("were not found on their recorded gateway: my-assistant"),
    );
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("Unknown version"));
  });

  it("prints the orphan diagnosis in --check mode so check and auto agree (#6520)", async () => {
    const harness = createRecoveryHarness(["my-assistant"], {
      liveOutput: "other-box Ready",
      latestBackup: null,
      staleNames: ["my-assistant"],
    });
    vi.stubEnv("NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE", "0");

    await expect(harness.upgradeSandboxes({ check: true })).resolves.toBeUndefined();

    expect(harness.rebuildSpy).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("were not found on their recorded gateway: my-assistant"),
    );
  });

  it("also flags a stale own-gateway orphan alongside the generic skip line (#6520)", async () => {
    // The versioned-reinstall repro (v0.0.77 sandbox, v0.0.76 tag): the
    // sandbox is stale+stopped, prints the generic skip line, and must ALSO
    // be flagged as an orphan since its own gateway does not observe it.
    const harness = createRecoveryHarness(["my-assistant"], {
      liveOutput: "other-box Ready",
      latestBackup: null,
      staleNames: ["my-assistant"],
    });
    vi.stubEnv("NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE", "0");

    await expect(harness.upgradeSandboxes({ auto: true })).resolves.toBeUndefined();

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Skipping 1 sandbox(es) not observed on the selected gateway"),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("were not found on their recorded gateway: my-assistant"),
    );
  });

  it("does not flag a sandbox bound to another live gateway as orphaned (#6520)", async () => {
    const harness = createRecoveryHarness(["registered-elsewhere"], {
      gatewayNames: { "registered-elsewhere": "gateway-b" },
      liveOutput: "selected-box Ready",
    });
    vi.stubEnv("NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE", "0");

    await expect(harness.upgradeSandboxes({ auto: true })).resolves.toBeUndefined();

    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining("were not found on their recorded gateway"),
    );
    expect(console.log).toHaveBeenCalledWith("  All sandboxes are up to date.");
  });

  it("does not flag a sandbox that becomes Ready on the confirming listing as orphaned (#6520)", async () => {
    const harness = createRecoveryHarness(["reconnecting-box"], {
      staleNames: ["reconnecting-box"],
    });
    harness.liveListSpy
      .mockResolvedValueOnce({ status: 0, output: "other-box Ready" })
      .mockResolvedValueOnce({ status: 0, output: "reconnecting-box Ready" });

    await expect(harness.upgradeSandboxes({ auto: true })).resolves.toBeUndefined();

    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining("were not found on their recorded gateway"),
    );
  });

  it("does not flag an absent sandbox that prepared-backup recovery restores as orphaned (#6520)", async () => {
    const harness = createRecoveryHarness(["orphaned-box"], {
      liveOutput: "other-box Ready",
    });

    await expect(harness.upgradeSandboxes({ auto: true })).resolves.toBeUndefined();

    expect(harness.rebuildSpy).toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining("were not found on their recorded gateway"),
    );
  });

  it("recovers a registered sandbox absent from the selected gateway when it resolves to the selected gateway", async () => {
    const harness = createRecoveryHarness(["orphaned-box"], {
      liveOutput: "other-box Ready",
    });

    await expect(harness.upgradeSandboxes({ auto: true })).resolves.toBeUndefined();

    expect(harness.latestBackupSpy).toHaveBeenCalledWith("orphaned-box");
    expect(harness.rebuildSpy).toHaveBeenCalledWith("orphaned-box", ["--yes"], {
      throwOnError: true,
      recoveryManifest: expect.objectContaining({ sandboxName: "orphaned-box" }),
    });
  });

  it("does not recover an absent sandbox bound to a different gateway even when a validated backup exists", async () => {
    const harness = createRecoveryHarness(["registered-elsewhere"], {
      gatewayNames: { "registered-elsewhere": "gateway-b" },
      liveOutput: "selected-box Ready",
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

  it("targets both sandbox-list probes at the selected gateway before absent recovery (#6114)", async () => {
    const harness = createRecoveryHarness(["orphaned-box"], {
      gatewayPort: 12345,
      liveOutput: "other-box Ready",
    });
    harness.liveListSpy
      .mockResolvedValueOnce({ status: 0, output: "other-box Ready" })
      .mockResolvedValueOnce({ status: 0, output: "still-other-box Ready" });

    await expect(harness.upgradeSandboxes({ auto: true })).resolves.toBeUndefined();

    expect(harness.liveListSpy).toHaveBeenCalledTimes(2);
    const expectedContext = expect.objectContaining({
      action: expect.any(String),
      command: expect.any(String),
    });
    const expectedGateway = { gatewayName: "nemoclaw-12345" };
    expect(harness.liveListSpy).toHaveBeenNthCalledWith(1, expectedContext, expectedGateway);
    expect(harness.liveListSpy).toHaveBeenNthCalledWith(2, expectedContext, expectedGateway);
    expect(harness.rebuildSpy).toHaveBeenCalledWith("orphaned-box", ["--yes"], {
      throwOnError: true,
      recoveryManifest: expect.objectContaining({ sandboxName: "orphaned-box" }),
    });
  });

  it("does not recover a healthy non-default sandbox based on the current gateway's absence (#6114)", async () => {
    const targetGatewayName = "nemoclaw-12345";
    const harness = createRecoveryHarness(["healthy-box"], { gatewayPort: 12345 });
    harness.liveListSpy.mockImplementation(async (...args: unknown[]) =>
      (args[1] as { gatewayName?: string } | undefined)?.gatewayName === targetGatewayName
        ? { status: 0, output: "healthy-box Ready" }
        : { status: 0, output: "default-other-box Ready" },
    );

    await expect(harness.upgradeSandboxes({ auto: true })).resolves.toBeUndefined();

    expect(harness.liveListSpy).toHaveBeenCalledOnce();
    expect(harness.liveListSpy).toHaveBeenCalledWith(expect.any(Object), {
      gatewayName: targetGatewayName,
    });
    expect(harness.latestBackupSpy).not.toHaveBeenCalled();
    expect(harness.rebuildSpy).not.toHaveBeenCalled();
  });

  it("does not assess or rebuild an absent sandbox with a tampered gateway binding (#6114)", async () => {
    const harness = createRecoveryHarness(["tampered-box"], {
      gatewayNames: { "tampered-box": "attacker" },
      liveOutput: "other-box Ready",
    });

    await expect(harness.upgradeSandboxes({ auto: true })).resolves.toBeUndefined();

    expect(harness.liveListSpy).toHaveBeenCalledOnce();
    expect(harness.latestBackupSpy).not.toHaveBeenCalled();
    expect(harness.rebuildSpy).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      '  Warning: sandbox "tampered-box" has an invalid persisted gateway binding; skipping prepared-backup recovery.',
    );
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("attacker"));
  });

  it("does not assess or rebuild a non-Ready sandbox with a tampered gateway binding (#6114)", async () => {
    const harness = createRecoveryHarness(["tampered-box"], {
      gatewayNames: { "tampered-box": "attacker" },
      liveOutput: "tampered-box Error",
    });

    await expect(harness.upgradeSandboxes({ auto: true })).resolves.toBeUndefined();

    expect(harness.liveListSpy).toHaveBeenCalledOnce();
    expect(harness.latestBackupSpy).not.toHaveBeenCalled();
    expect(harness.rebuildSpy).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      '  Warning: sandbox "tampered-box" has an invalid persisted gateway binding; skipping prepared-backup recovery.',
    );
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("attacker"));
  });

  it("does not recover a non-Ready sandbox bound to another valid gateway (#6114)", async () => {
    const harness = createRecoveryHarness(["registered-elsewhere"], {
      gatewayNames: { "registered-elsewhere": "nemoclaw-12345" },
      liveOutput: "registered-elsewhere Provisioning",
    });

    await expect(harness.upgradeSandboxes({ auto: true })).resolves.toBeUndefined();

    expect(harness.liveListSpy).toHaveBeenCalledOnce();
    expect(harness.latestBackupSpy).not.toHaveBeenCalled();
    expect(harness.rebuildSpy).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("does not recover an absent sandbox when a confirming second listing shows it has become Ready", async () => {
    const harness = createRecoveryHarness(["reconnecting-box"], {
      staleNames: ["reconnecting-box"],
    });
    harness.liveListSpy
      .mockResolvedValueOnce({ status: 0, output: "other-box Ready" })
      .mockResolvedValueOnce({ status: 0, output: "reconnecting-box Ready" });

    await expect(harness.upgradeSandboxes({ auto: true })).resolves.toBeUndefined();

    expect(harness.liveListSpy).toHaveBeenCalledTimes(2);
    expect(harness.latestBackupSpy).not.toHaveBeenCalled();
    expect(harness.rebuildSpy).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Skipping 1 sandbox(es) not observed on the selected gateway"),
    );
  });

  it.each([
    "Provisioning",
    "Error",
  ])("recovers an absent sandbox when confirmation reports the %s phase (#6114)", async (phase) => {
    const harness = createRecoveryHarness(["orphaned-box"], {
      liveOutput: "other-box Ready",
    });
    harness.liveListSpy
      .mockResolvedValueOnce({ status: 0, output: "other-box Ready" })
      .mockResolvedValueOnce({ status: 0, output: `orphaned-box ${phase}` });

    await expect(harness.upgradeSandboxes({ auto: true })).resolves.toBeUndefined();

    expect(harness.liveListSpy).toHaveBeenCalledTimes(2);
    expect(harness.latestBackupSpy).toHaveBeenCalledWith("orphaned-box");
    expect(harness.rebuildSpy).toHaveBeenCalledWith("orphaned-box", ["--yes"], {
      throwOnError: true,
      recoveryManifest: expect.objectContaining({ sandboxName: "orphaned-box" }),
    });
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
