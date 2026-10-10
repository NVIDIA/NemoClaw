// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { rebuildSandbox } from "./rebuild-pipeline";

const h = vi.hoisted(() => ({
  exitBail: vi.fn(),
  releaseSourceWindow: vi.fn(async () => {}),
  backupPhase: vi.fn(),
  destroyPhase: vi.fn(),
  preflightPhase: vi.fn(),
}));

vi.mock("./rebuild-preflight-phase", () => ({
  runRebuildPreflightPhase: h.preflightPhase,
  runHermesCronRestoreBackupPreflight: vi.fn(async () => null),
}));

vi.mock("./rebuild-backup-phase", () => ({
  captureRebuildPolicyDocument: vi.fn(async () => null),
  bindRebuildSnapshotGpuAuthority: vi.fn((options: unknown) => options),
  clearRebuildMcpHandoff: vi.fn(() => true),
  clearRebuildPolicyHandoff: vi.fn(() => true),
  readRebuildPolicyHandoff: vi.fn(() => null),
  readRebuildMcpHandoff: vi.fn(() => null),
  releaseRebuildSourceOpenClawWindow: h.releaseSourceWindow,
  retireRebuildSourceOpenClawWindowForDelete: vi.fn(async () => undefined),
  runRebuildBackupPhase: h.backupPhase,
  writeRebuildMcpHandoff: vi.fn(() => true),
  writeRebuildPolicyHandoff: vi.fn(() => true),
}));

vi.mock("./rebuild-destroy-phase", () => ({
  runRebuildDestroyPhase: h.destroyPhase,
}));

vi.mock("./rebuild-flow-helpers", () => ({
  delegateRebuildToOwningRegistry: vi.fn(async () => false),
  disposeRebuildAgentBaseImagePreflight: vi.fn(() => undefined),
  removeStaleRebuildDockerOrphan: vi.fn(() => undefined),
  snapshotOpenShellEnv: vi.fn(() => () => undefined),
}));

vi.mock("./rebuild-mcp-phase", () => ({
  observeMcpStateForRebuild: vi.fn(async () => ({ entries: [], runtimeSelection: null })),
}));

vi.mock("./rebuild-preflight-guards", () => ({
  assertSandboxRebuildCommandAvailable: vi.fn(() => undefined),
  revalidateManagedWorkloadRebuildBeforeDelete: vi.fn(() => null),
  revalidateRebuildRouteBeforeDelete: vi.fn(() => null),
}));

vi.mock("./rebuild-prepared-image-context", () => ({
  disposePreparedBuildContext: vi.fn(async () => undefined),
  verifyPreparedBuildContext: vi.fn(async () => true),
}));

vi.mock("./rebuild-prepared-recovery", () => ({
  revalidatePreparedRecoveryBeforeDelete: vi.fn(() => ({
    manifest: null,
    registrySnapshot: null,
  })),
}));

vi.mock("./rebuild-provider-preflight", () => ({
  inspectRebuildGatewayProviderRegistration: vi.fn(async () => null),
  validateRebuildHostInferenceCredential: vi.fn(async () => null),
  shouldVerifyRebuildGatewayProvider: vi.fn(() => false),
}));

vi.mock("./rebuild-recreate-journal", () => ({
  clearRebuildRecoveryBackup: vi.fn(() => undefined),
  findRebuildRecoveryBackup: vi.fn(() => null),
  fingerprintRebuildRecreateTargetIntent: vi.fn(() => "intent-fingerprint"),
  isRebuildRecoveryCleanupOnly: vi.fn(() => false),
  markRebuildRecoveryCleanupOnly: vi.fn(() => undefined),
  openRebuildRecreateJournal: vi.fn(() => ({
    id: "journal-1",
    acceptedTarget: null,
    completeAcceptedTarget: vi.fn(),
  })),
  assertRebuildRecoverySource: vi.fn(() => undefined),
  recordRebuildRecoveryBackup: vi.fn(() => undefined),
}));

vi.mock("./rebuild-recreate-phase", () => ({
  runRebuildRecreatePhase: vi.fn(async () => undefined),
}));

vi.mock("./rebuild-registry-rollback", () => ({
  createRebuildRegistryRollback: vi.fn(() => ({ recordRemoval: vi.fn() })),
}));

vi.mock("./rebuild-restore-phase", () => ({
  runRebuildRestorePhase: vi.fn(async () => undefined),
}));

vi.mock("../../state/registry", () => ({
  REGISTRY_FILE: "/tmp/nemoclaw-bail-sentinel-test/registry.json",
  load: vi.fn(() => ({ sandboxes: {} })),
  getSandbox: vi.fn(() => null),
  updateSandbox: vi.fn(() => true),
  restoreSandboxEntry: vi.fn(() => undefined),
  restoreSandboxEntryIfMissing: vi.fn(() => undefined),
}));

vi.mock("../../state/onboard-session", () => ({
  SESSION_FILE: "/tmp/nemoclaw-bail-sentinel-test/session.json",
  loadRebuildSession: vi.fn(() => null),
  loadSession: vi.fn(() => null),
}));

vi.mock("../../state/mcp-lifecycle-lock", () => ({
  withMcpLifecycleLock: vi.fn(async (_sandboxName: string, run: () => Promise<void>) => run()),
}));

vi.mock("../../onboard/portable-retirement-authority", () => ({
  withPortableOnboardRetirementBoundary: vi.fn(async (_config: unknown, run: () => Promise<void>) =>
    run(),
  ),
}));

vi.mock("../../state/migrations/removed-immutability", () => ({
  enforceRemovedImmutabilityMigrationBoundary: vi.fn(() => ({ stateRecord: null })),
  retireRemovedImmutabilityStateRecord: vi.fn(() => undefined),
}));

vi.mock("../../onboard/credential-env", () => ({
  hydrateCredentialEnv: vi.fn(() => ({})),
}));

describe("rebuild pipeline bail sentinel (#12919)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.releaseSourceWindow.mockImplementation(async () => undefined);
    h.preflightPhase.mockResolvedValue({
      sandboxEntry: { name: "alpha", agent: "openclaw" },
      rebuildAgent: "openclaw",
      versionCheck: null,
      targetConfig: {
        resumeConfig: null,
        sessionSnapshot: null,
        sessionMatchesSandbox: true,
        durableConfig: { webSearchConfig: null },
        hermesToolGateways: null,
        hasHermesToolGateways: false,
        credentialEnv: {},
        fromDockerfile: null,
      },
      recreateOptions: {
        targetGatewayName: "gw-alpha",
        targetGatewayPort: 7001,
        rebuildGatewayAuthority: { verified: true },
        runtimeSelection: null,
      },
      messagingPlan: null,
      recheckMessagingConflicts: null,
      baseImagePreflight: null,
      liveState: { staleRecovery: false, staleRegistrySnapshot: null },
      recoveryManifest: null,
      dcodePreflight: { cleanup: vi.fn(), revalidateBeforeDelete: vi.fn(async () => true) },
      preparedImage: null,
      routePreflightReceipt: null,
      stoppedSource: null,
      releaseOnboardLock: vi.fn(),
      log: vi.fn(),
      bail: h.exitBail,
    } as never);
    h.backupPhase.mockResolvedValue({
      ok: true,
      backupManifest: {
        backupPath: "/tmp/nemoclaw-bail-sentinel-test/backup.tar.zst",
        rebuildPolicyHandoff: null,
        rebuildMcpHandoff: null,
      },
      sourceOpenClawDoctorWindow: { windowToken: "source-window" },
    } as never);
    h.destroyPhase.mockResolvedValue({ removalReceipt: null } as never);
    h.exitBail.mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delegates a bail that fired before any window was held without touching the release", async () => {
    h.backupPhase.mockImplementationOnce(
      async (input: { bail: (message: string, code?: number) => never }) => {
        input.bail("injected backup failure: could not capture sandbox state");
      },
    );

    await rebuildSandbox("alpha");

    expect(h.exitBail).toHaveBeenCalledExactlyOnceWith(
      "injected backup failure: could not capture sandbox state",
    );
    expect(h.releaseSourceWindow).not.toHaveBeenCalled();
  });

  it("releases the held OpenClaw maintenance window before the delegated CLI bail exits (#12919)", async () => {
    h.destroyPhase.mockImplementationOnce(
      async (input: { bail: (message: string, code?: number) => never }) => {
        input.bail("injected late rebuild bail", 7);
      },
    );

    await rebuildSandbox("alpha");

    expect(h.exitBail).toHaveBeenCalledExactlyOnceWith("injected late rebuild bail", 7);
    expect(h.releaseSourceWindow).toHaveBeenCalledExactlyOnceWith({ windowToken: "source-window" });
    expect(h.releaseSourceWindow.mock.invocationCallOrder[0]).toBeLessThan(
      h.exitBail.mock.invocationCallOrder[0],
    );
  });

  it("keeps the original bail message when the window release itself fails (#12919)", async () => {
    h.releaseSourceWindow.mockRejectedValueOnce(new Error("release rejected"));
    h.destroyPhase.mockImplementationOnce(
      async (input: { bail: (message: string, code?: number) => never }) => {
        input.bail("injected late rebuild bail");
      },
    );

    await expect(rebuildSandbox("alpha")).resolves.toBeUndefined();

    expect(h.exitBail).toHaveBeenCalledExactlyOnceWith("injected late rebuild bail");
    const warnings = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(warnings).toContain("OpenClaw maintenance window could not be released");
    expect(warnings).toContain("release rejected");
  });

  it("still releases the window and does not convert non-bail failures into exits", async () => {
    h.destroyPhase.mockImplementationOnce(async () => {
      throw new Error("destroy exploded");
    });

    await expect(rebuildSandbox("alpha")).rejects.toThrow("destroy exploded");

    expect(h.exitBail).not.toHaveBeenCalled();
    expect(h.releaseSourceWindow).toHaveBeenCalledExactlyOnceWith({ windowToken: "source-window" });
  });

  it("preserves the bail message and exit code when the real bail throws instead of exiting", async () => {
    h.exitBail.mockImplementationOnce((message: string, code?: number) => {
      throw new Error(`exit:${code}:${message}`);
    });
    h.destroyPhase.mockImplementationOnce(
      async (input: { bail: (message: string, code?: number) => never }) => {
        input.bail("injected late rebuild bail", 7);
      },
    );

    await expect(rebuildSandbox("alpha")).rejects.toThrow("exit:7:injected late rebuild bail");
    expect(h.releaseSourceWindow.mock.invocationCallOrder[0]).toBeLessThan(
      h.exitBail.mock.invocationCallOrder[0],
    );
  });
});
