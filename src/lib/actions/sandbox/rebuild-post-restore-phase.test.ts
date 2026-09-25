// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as agentDefs from "../../agent/defs";
import * as agentRuntime from "../../agent/runtime";
import * as mutableConfigPerms from "../../sandbox/mutable-config-perms";
import * as registry from "../../state/registry";
import * as sandboxVersion from "../../sandbox/version";
import * as messagingHostForward from "./messaging-host-forward-lifecycle";
import * as restoreWindow from "./runtime/openclaw-lifecycle";
import * as rebuildConfigHash from "./rebuild-config-hash";
import * as rebuildHermesPostRestore from "./rebuild-hermes-post-restore";
import * as rebuildMcp from "./rebuild-mcp-phase";
import * as rebuildMessaging from "./rebuild-messaging-phase";
import {
  printHermesOperatorConfigRestoreReport,
  runRebuildPostRestorePhase,
} from "./rebuild-post-restore-phase";
import * as sessionModels from "./reconcile-session-models";

const processRecovery = restoreWindow;

describe("rebuild post-restore phase", () => {
  const runtimeKindByAgent = {
    openclaw: "gateway",
    hermes: "gateway",
    "langchain-deepagents-code": "terminal",
    pi: "terminal",
  } as const;
  let agentName: keyof typeof runtimeKindByAgent;
  let order: string[];

  beforeEach(() => {
    agentName = "openclaw";
    order = [];
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(agentRuntime, "getSessionAgent").mockImplementation(() =>
      agentName === "openclaw" ? null : ({ name: agentName } as never),
    );
    vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue("test agent");
    vi.spyOn(agentDefs, "loadAgent").mockImplementation(
      () =>
        ({
          name: agentName,
          expectedVersion: null,
          runtime: { kind: runtimeKindByAgent[agentName] },
        }) as never,
    );
    vi.spyOn(restoreWindow, "beginUnregisteredOpenClawPostRestoreDoctor").mockImplementation(
      async (sandboxName, runtimeSelection) => {
        order.push("doctor-begin");
        return {
          ok: true,
          window: {
            sandboxName,
            ...(runtimeSelection ? { runtimeSelection } : {}),
          },
        };
      },
    );
    vi.spyOn(restoreWindow, "finishUnregisteredOpenClawPostRestoreDoctor").mockImplementation(
      async () => {
        order.push("doctor-finish");
        return { ok: true };
      },
    );
    vi.spyOn(restoreWindow, "abortUnregisteredOpenClawPostRestoreDoctor").mockImplementation(
      async () => {
        order.push("doctor-abort");
        return { ok: true };
      },
    );
    vi.spyOn(sessionModels, "reconcileStalePinnedSessionModelsAfterRebuild").mockImplementation(
      async () => {
        order.push("reconcile");
      },
    );
    vi.spyOn(rebuildMessaging, "reapplyMessagingManifestBeforeOpenClawStart").mockImplementation(
      async () => {
        order.push("messaging");
      },
    );
    vi.spyOn(rebuildMessaging, "finalizePendingMessagingRemovalsAfterRestore").mockImplementation(
      (plan) => plan,
    );
    vi.spyOn(
      rebuildConfigHash,
      "refreshMutableOpenClawConfigHashAfterPostRestoreWrites",
    ).mockImplementation(async () => {
      order.push("config-hash");
      return true;
    });
    vi.spyOn(rebuildConfigHash, "verifyFinalMutableOpenClawConfigHash").mockImplementation(
      async () => {
        order.push("config-hash-final");
        return true;
      },
    );
    vi.spyOn(mutableConfigPerms, "repairMutableConfigPerms").mockImplementation(() => {
      order.push("permissions");
      return {
        applied: true,
        verified: true,
        errors: [],
      };
    });
    vi.spyOn(mutableConfigPerms, "inspectMutableHermesConfigPerms").mockReturnValue({
      verified: true,
      errors: [],
    });
    vi.spyOn(rebuildMcp, "restoreMcpAfterRebuild").mockImplementation(async () => {
      order.push("mcp");
      return true;
    });
    vi.spyOn(rebuildHermesPostRestore, "restartHermesGatewayAfterStateRestore").mockImplementation(
      async (_sandboxName, targetAgentName) =>
        targetAgentName === "hermes" ? "restarted" : "not-applicable",
    );
    vi.spyOn(rebuildHermesPostRestore, "verifyHermesGatewayAfterStateRestore").mockImplementation(
      async (_sandboxName, targetAgentName) =>
        targetAgentName === "hermes" ? "healthy" : "not-applicable",
    );
    vi.spyOn(
      rebuildHermesPostRestore,
      "verifyHermesGatewayAfterStateRestoreForCronGate",
    ).mockResolvedValue({
      state: "healthy",
      replacementIdentity: { pid: 77, start_time: 903, drain_token: "restore-token" },
    });
    vi.spyOn(
      rebuildHermesPostRestore,
      "completeHermesCronRestoreAfterGatewayReplacement",
    ).mockReturnValue({ pid: 77, start_time: 903, drain_token: "restore-token" });
    vi.spyOn(
      rebuildHermesPostRestore,
      "isHermesCronRestoreDrainMarkerRollbackFailure",
    ).mockReturnValue(false);
    vi.spyOn(registry, "getSandbox").mockImplementation(
      () => ({ agent: agentName === "openclaw" ? null : agentName }) as never,
    );
    vi.spyOn(registry, "updateSandbox").mockReturnValue(true);
    vi.spyOn(sandboxVersion, "checkAgentVersion").mockResolvedValue({
      sandboxVersion: null,
      expectedVersion: null,
      isStale: false,
      verificationFailed: true,
      detectionMethod: "unavailable",
      unavailableReason: "no-expected-version",
    });
    vi.spyOn(messagingHostForward, "ensureMessagingHostForwardAfterRebuild").mockImplementation(
      async () => {
        order.push("host-forward");
        return true;
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function input() {
    return {
      sandboxName: "alpha",
      targetAgentName: agentName,
      messagingPlan: null,
      backupManifest: null,
      mcpEntries: [],
      restoreSucceeded: true,
      failedPresets: [],
      finalBuiltinPresets: [],
      failedPresetRemovals: [],
      policyPresetReconciliationVerified: true,
      preparedBackupRecovery: false,
      versionCheck: { expectedVersion: null } as never,
      log: vi.fn(),
      bail: vi.fn() as never,
    };
  }

  it("completes offline restoration before one doctor start and final sealing (#7102, #9946)", async () => {
    await runRebuildPostRestorePhase(input());

    expect(order).toEqual([
      "doctor-begin",
      "reconcile",
      "messaging",
      "permissions",
      "mcp",
      "permissions",
      "doctor-finish",
      "config-hash",
      "config-hash-final",
      "host-forward",
      "config-hash-final",
    ]);
    expect(
      processRecovery.beginUnregisteredOpenClawPostRestoreDoctor,
    ).toHaveBeenCalledExactlyOnceWith("alpha", undefined);
    expect(processRecovery.finishUnregisteredOpenClawPostRestoreDoctor).toHaveBeenCalledOnce();
    expect(processRecovery.abortUnregisteredOpenClawPostRestoreDoctor).not.toHaveBeenCalled();
  });

  it("reuses the maintenance window established before filesystem restore", async () => {
    const window = { sandboxName: "alpha" };
    vi.mocked(processRecovery.beginUnregisteredOpenClawPostRestoreDoctor).mockClear();

    await runRebuildPostRestorePhase({ ...input(), openClawDoctorWindow: window });

    expect(processRecovery.beginUnregisteredOpenClawPostRestoreDoctor).not.toHaveBeenCalled();
    expect(processRecovery.finishUnregisteredOpenClawPostRestoreDoctor).toHaveBeenCalledWith(
      window,
    );
    expect(order).toEqual([
      "reconcile",
      "messaging",
      "permissions",
      "mcp",
      "permissions",
      "doctor-finish",
      "config-hash",
      "config-hash-final",
      "host-forward",
      "config-hash-final",
    ]);
  });

  it("re-establishes mutable config permissions after MCP writers settle", async () => {
    let repairAttempt = 0;
    vi.mocked(mutableConfigPerms.repairMutableConfigPerms).mockImplementation(() => {
      repairAttempt += 1;
      order.push(`permissions:${String(repairAttempt)}`);
      return repairAttempt === 1
        ? { applied: true, verified: true, errors: [] }
        : {
            applied: true,
            verified: false,
            errors: ["config.json mode changed after MCP restore"],
          };
    });
    const args = input();

    const verification = await runRebuildPostRestorePhase(args);

    expect(order).toEqual([
      "doctor-begin",
      "reconcile",
      "messaging",
      "permissions:1",
      "mcp",
      "permissions:2",
      "doctor-finish",
      "config-hash",
      "config-hash-final",
      "host-forward",
      "config-hash-final",
    ]);
    expect(verification).toEqual({ mutableConfigPermissionsVerified: false });
    expect(args.bail).not.toHaveBeenCalled();
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain(
      "Mutable config permissions were not verified",
    );
  });

  it("uses the verified final permission repair for prepared recovery", async () => {
    let repairAttempt = 0;
    vi.mocked(mutableConfigPerms.repairMutableConfigPerms).mockImplementation(() => {
      repairAttempt += 1;
      return repairAttempt === 1
        ? {
            applied: true,
            verified: false,
            errors: ["initial repair did not verify"],
          }
        : { applied: true, verified: true, errors: [] };
    });
    const args = { ...input(), preparedBackupRecovery: true };

    await expect(runRebuildPostRestorePhase(args)).resolves.toEqual({
      mutableConfigPermissionsVerified: true,
    });

    expect(mutableConfigPerms.repairMutableConfigPerms).toHaveBeenCalledTimes(2);
    expect(args.bail).not.toHaveBeenCalled();
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain(
      "Sandbox 'alpha' rebuild completed",
    );
  });

  it("reuses the MCP rebuild target for every post-restore sandbox command (#10514)", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "hostile-gateway");
    vi.stubEnv("OPENSHELL_WORKSPACE", "hostile-workspace");
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/hostile/tls");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://hostile.invalid");
    const runtimeSelection = {
      gatewayName: "recorded-gateway",
      workspace: "default",
      localTlsDir: "/authority/tls",
    };
    const args = { ...input(), mcpRuntimeSelection: runtimeSelection };

    await runRebuildPostRestorePhase(args);

    expect(processRecovery.beginUnregisteredOpenClawPostRestoreDoctor).toHaveBeenCalledWith(
      "alpha",
      runtimeSelection,
    );
    expect(rebuildMessaging.reapplyMessagingManifestBeforeOpenClawStart).toHaveBeenCalledWith(
      "alpha",
      null,
      args.log,
      runtimeSelection,
    );
    expect(sessionModels.reconcileStalePinnedSessionModelsAfterRebuild).toHaveBeenCalledWith(
      "alpha",
      args.log,
      runtimeSelection,
    );
    expect(
      rebuildConfigHash.refreshMutableOpenClawConfigHashAfterPostRestoreWrites,
    ).toHaveBeenCalledExactlyOnceWith("alpha", args.log, runtimeSelection);
    expect(vi.mocked(rebuildConfigHash.verifyFinalMutableOpenClawConfigHash).mock.calls).toEqual([
      ["alpha", args.log, runtimeSelection],
      ["alpha", args.log, runtimeSelection],
    ]);
    expect(process.env.OPENSHELL_GATEWAY).toBe("hostile-gateway");
  });

  it("refuses frozen Hermes supervisor authority when the recreated gateway binding changed", async () => {
    agentName = "hermes";
    vi.mocked(registry.getSandbox).mockReturnValue({
      agent: "hermes",
      gatewayName: "nemoclaw-19081",
      gatewayPort: 19081,
    } as never);
    const args = {
      ...input(),
      mcpRuntimeSelection: {
        gatewayName: "nemoclaw-19080",
        workspace: "default",
      },
    };

    await runRebuildPostRestorePhase(args);

    expect(args.bail).toHaveBeenCalledWith(
      "Recreated sandbox agent identity did not match the authoritative rebuild target.",
    );
    expect(rebuildHermesPostRestore.restartHermesGatewayAfterStateRestore).not.toHaveBeenCalled();
  });

  it("does not record a final hash without trusted doctor completion (#9946)", async () => {
    vi.mocked(processRecovery.beginUnregisteredOpenClawPostRestoreDoctor).mockResolvedValue({
      ok: false,
      stage: "doctor",
      detail: "completion unverified",
    });
    const args = input();

    await runRebuildPostRestorePhase(args);

    expect(
      rebuildConfigHash.refreshMutableOpenClawConfigHashAfterPostRestoreWrites,
    ).not.toHaveBeenCalled();
    expect(rebuildConfigHash.verifyFinalMutableOpenClawConfigHash).not.toHaveBeenCalled();
    expect(rebuildMcp.restoreMcpAfterRebuild).not.toHaveBeenCalled();
    expect(messagingHostForward.ensureMessagingHostForwardAfterRebuild).not.toHaveBeenCalled();
    expect(args.bail).toHaveBeenCalledWith(
      "OpenClaw post-upgrade structure repair failed during rebuild.",
    );
    expect(processRecovery.abortUnregisteredOpenClawPostRestoreDoctor).not.toHaveBeenCalled();
    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("Post-upgrade structure repair failed before offline restoration");
    expect(output).not.toContain("rebuilt successfully");
  });

  it("does not seal OpenClaw config after unverified MCP restoration (#9946)", async () => {
    vi.mocked(rebuildMcp.restoreMcpAfterRebuild).mockResolvedValue(false);
    const args = input();

    await runRebuildPostRestorePhase(args);

    expect(
      rebuildConfigHash.refreshMutableOpenClawConfigHashAfterPostRestoreWrites,
    ).not.toHaveBeenCalled();
    expect(rebuildConfigHash.verifyFinalMutableOpenClawConfigHash).not.toHaveBeenCalled();
    expect(args.bail).not.toHaveBeenCalled();
    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("Mutable OpenClaw config hash was not refreshed");
    expect(output).toContain("MCP bridge definitions were preserved but not fully refreshed");
    expect(output).not.toContain("rebuilt successfully");
  });

  it("finishes offline writes but stops online finalization when doctor restart fails (#9946)", async () => {
    vi.mocked(processRecovery.finishUnregisteredOpenClawPostRestoreDoctor).mockResolvedValue({
      ok: false,
      stage: "restart",
      detail: "sensitive doctor output",
    });
    const args = input();

    await runRebuildPostRestorePhase(args);

    expect(sessionModels.reconcileStalePinnedSessionModelsAfterRebuild).toHaveBeenCalledOnce();
    expect(rebuildMessaging.reapplyMessagingManifestBeforeOpenClawStart).toHaveBeenCalledOnce();
    expect(mutableConfigPerms.repairMutableConfigPerms).toHaveBeenCalledTimes(2);
    expect(rebuildHermesPostRestore.restartHermesGatewayAfterStateRestore).not.toHaveBeenCalled();
    expect(rebuildHermesPostRestore.verifyHermesGatewayAfterStateRestore).not.toHaveBeenCalled();
    expect(rebuildMcp.restoreMcpAfterRebuild).toHaveBeenCalledOnce();
    expect(
      rebuildConfigHash.refreshMutableOpenClawConfigHashAfterPostRestoreWrites,
    ).not.toHaveBeenCalled();
    expect(rebuildConfigHash.verifyFinalMutableOpenClawConfigHash).not.toHaveBeenCalled();
    expect(messagingHostForward.ensureMessagingHostForwardAfterRebuild).not.toHaveBeenCalled();
    expect(args.bail).toHaveBeenCalledWith(
      "OpenClaw post-upgrade structure repair failed during rebuild.",
    );
    expect(
      processRecovery.abortUnregisteredOpenClawPostRestoreDoctor,
    ).toHaveBeenCalledExactlyOnceWith({
      sandboxName: "alpha",
    });
    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("Post-upgrade structure repair failed during final sandbox start");
    expect(output).not.toContain("sensitive doctor output");
    expect(output).not.toContain("rebuilt successfully");
  });

  it("stops rebuild when OpenClaw messaging config reapply fails", async () => {
    vi.mocked(rebuildMessaging.reapplyMessagingManifestBeforeOpenClawStart).mockRejectedValue(
      new Error("config write failed"),
    );
    const args = input();

    await runRebuildPostRestorePhase(args);

    expect(mutableConfigPerms.repairMutableConfigPerms).not.toHaveBeenCalled();
    expect(rebuildMcp.restoreMcpAfterRebuild).not.toHaveBeenCalled();
    expect(messagingHostForward.ensureMessagingHostForwardAfterRebuild).not.toHaveBeenCalled();
    expect(args.bail).toHaveBeenCalledWith(
      "OpenClaw messaging manifest config reapply failed during rebuild.",
    );
    expect(args.log).toHaveBeenCalledWith("Messaging manifest reapply failed: config write failed");
    expect(
      processRecovery.abortUnregisteredOpenClawPostRestoreDoctor,
    ).toHaveBeenCalledExactlyOnceWith({
      sandboxName: "alpha",
    });
    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(output).toContain("Messaging manifest config reapply failed before gateway start");
  });

  it("aborts the maintenance gate when pending messaging removal cannot be committed", async () => {
    const finalizedPlan = { transport: "slack" } as never;
    vi.mocked(rebuildMessaging.finalizePendingMessagingRemovalsAfterRestore).mockReturnValue(
      finalizedPlan,
    );
    vi.mocked(registry.updateSandbox).mockReturnValue(false);
    const args = { ...input(), messagingPlan: { transport: "discord" } as never };

    await runRebuildPostRestorePhase(args);

    expect(args.bail).toHaveBeenCalledWith(
      "Could not retire pending messaging removals after rebuild.",
    );
    expect(
      processRecovery.abortUnregisteredOpenClawPostRestoreDoctor,
    ).toHaveBeenCalledExactlyOnceWith({
      sandboxName: "alpha",
    });
    expect(processRecovery.finishUnregisteredOpenClawPostRestoreDoctor).not.toHaveBeenCalled();
  });

  it.each([
    {
      fail: () =>
        vi
          .mocked(sessionModels.reconcileStalePinnedSessionModelsAfterRebuild)
          .mockRejectedValue(new Error("session reconciliation failed")),
      message: "session reconciliation failed",
    },
    {
      fail: () =>
        vi
          .mocked(rebuildMcp.restoreMcpAfterRebuild)
          .mockRejectedValue(new Error("MCP restoration failed")),
      message: "MCP restoration failed",
    },
  ])(
    "aborts the maintenance gate when an offline writer throws: $message",
    async ({ fail, message }) => {
      fail();

      await expect(runRebuildPostRestorePhase(input())).rejects.toThrow(message);

      expect(
        processRecovery.abortUnregisteredOpenClawPostRestoreDoctor,
      ).toHaveBeenCalledExactlyOnceWith({
        sandboxName: "alpha",
      });
      expect(processRecovery.finishUnregisteredOpenClawPostRestoreDoctor).not.toHaveBeenCalled();
    },
  );

  it("does not mask the restoration failure when the maintenance abort itself throws", async () => {
    vi.mocked(sessionModels.reconcileStalePinnedSessionModelsAfterRebuild).mockRejectedValue(
      new Error("original restoration failure"),
    );
    vi.mocked(processRecovery.abortUnregisteredOpenClawPostRestoreDoctor).mockRejectedValue(
      new Error("sensitive abort failure"),
    );
    const args = input();

    await expect(runRebuildPostRestorePhase(args)).rejects.toThrow("original restoration failure");

    expect(args.log).toHaveBeenCalledWith("Post-upgrade doctor maintenance abort: unverified");
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).not.toContain(
      "sensitive abort failure",
    );
  });

  it("captures a completed doctor mutation and rejects a later config change (#9946)", async () => {
    let configHashValid = true;
    vi.mocked(processRecovery.finishUnregisteredOpenClawPostRestoreDoctor).mockImplementation(
      async () => {
        configHashValid = false;
        return { ok: true };
      },
    );
    vi.mocked(
      rebuildConfigHash.refreshMutableOpenClawConfigHashAfterPostRestoreWrites,
    ).mockImplementation(async () => {
      configHashValid = true;
      return true;
    });
    vi.mocked(messagingHostForward.ensureMessagingHostForwardAfterRebuild).mockImplementation(
      async () => {
        configHashValid = false;
        return true;
      },
    );
    vi.mocked(rebuildConfigHash.verifyFinalMutableOpenClawConfigHash).mockImplementation(
      async () => configHashValid,
    );
    const args = input();

    await runRebuildPostRestorePhase(args);

    expect(
      rebuildConfigHash.refreshMutableOpenClawConfigHashAfterPostRestoreWrites,
    ).toHaveBeenCalledOnce();
    expect(rebuildConfigHash.verifyFinalMutableOpenClawConfigHash).toHaveBeenCalledTimes(2);
    expect(args.bail).toHaveBeenCalledWith(
      "OpenClaw config integrity verification failed after rebuild.",
    );
    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    const diagnosticLog = vi.mocked(args.log).mock.calls.flat().join("\n");
    expect(output).toContain(
      "Final OpenClaw configuration hash verification failed after post-restore finalization",
    );
    expect(output).not.toContain("Mutable OpenClaw config hash was not refreshed");
    expect(output).not.toContain("rebuilt successfully");
    expect(diagnosticLog).not.toContain("sensitive doctor output");
  });

  it("does not run OpenClaw session reconciliation for another agent (#7102)", async () => {
    agentName = "hermes";
    const args = input();

    const verification = await runRebuildPostRestorePhase(args);

    expect(args.bail).not.toHaveBeenCalled();
    expect(sessionModels.reconcileStalePinnedSessionModelsAfterRebuild).not.toHaveBeenCalled();
    expect(processRecovery.beginUnregisteredOpenClawPostRestoreDoctor).not.toHaveBeenCalled();
    expect(processRecovery.finishUnregisteredOpenClawPostRestoreDoctor).not.toHaveBeenCalled();
    expect(mutableConfigPerms.inspectMutableHermesConfigPerms).toHaveBeenCalledWith("alpha");
    expect(verification).toEqual({ mutableConfigPermissionsVerified: true });
  });

  it.each([false, true])("rejects a version mismatch during recovery=%s", async (recovery) => {
    agentName = "hermes";
    vi.mocked(agentDefs.loadAgent).mockReturnValue({
      name: "hermes",
      displayName: "Hermes Agent",
      expectedVersion: "0.20.6",
    } as never);
    vi.mocked(sandboxVersion.checkAgentVersion).mockResolvedValue({
      sandboxVersion: "0.19.0",
      expectedVersion: "0.20.6",
      isStale: true,
      verificationFailed: false,
      detectionMethod: "openshell-exec",
    });
    const args = {
      ...input(),
      preparedBackupRecovery: recovery,
      versionCheck: { expectedVersion: "0.20.6" } as never,
      hermesCronRestoreIdentity: !recovery
        ? {
            pid: 41,
            start_time: 902,
            drain_token: "restore-token",
          }
        : undefined,
    };

    await runRebuildPostRestorePhase(args);

    expect(sandboxVersion.checkAgentVersion).toHaveBeenCalledWith("alpha", { forceProbe: true });
    expect(registry.updateSandbox).toHaveBeenNthCalledWith(1, "alpha", {
      agentVersion: null,
    });
    expect(registry.updateSandbox).toHaveBeenNthCalledWith(2, "alpha", {
      agentVersion: null,
    });
    expect(registry.updateSandbox).not.toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ agentVersion: expect.stringMatching(/.+/) }),
    );
    expect(args.bail).toHaveBeenCalledWith(
      "Replacement agent version did not match the authoritative rebuild target.",
    );
    expect(
      rebuildHermesPostRestore.completeHermesCronRestoreAfterGatewayReplacement,
    ).not.toHaveBeenCalled();
    expect(messagingHostForward.ensureMessagingHostForwardAfterRebuild).not.toHaveBeenCalled();
    const errors = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(errors.includes("Hermes cron dispatch remains drained")).toBe(!recovery);
    expect(errors).toContain("nemoclaw alpha recover");
    expect(errors).toContain("expected 0.20.6, observed 0.19.0");
    expect(errors).not.toContain("gateway restart");
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).not.toContain("rebuild completed");
  });

  it.each([
    {
      cronGate: false,
      preparedBackupRecovery: false,
      restoreSucceeded: true,
      gatewayDetail: "nemoclaw alpha gateway restart",
      recoveryDetail: "If gateway health is still unverified",
    },
    {
      cronGate: true,
      preparedBackupRecovery: false,
      restoreSucceeded: true,
      gatewayDetail: "Hermes gateway health was not verified after state restore.",
      recoveryDetail: "Hermes cron dispatch remains drained",
    },
    {
      cronGate: false,
      preparedBackupRecovery: true,
      restoreSucceeded: false,
      gatewayDetail: "Correct the reported restore problem",
      recoveryDetail: "nemoclaw alpha recover",
    },
  ])(
    "reports unavailable verification with cron gate=$cronGate, prepared recovery=$preparedBackupRecovery, and restore=$restoreSucceeded (#12004)",
    async ({
      cronGate,
      preparedBackupRecovery,
      restoreSucceeded,
      gatewayDetail,
      recoveryDetail,
    }) => {
      agentName = "hermes";
      vi.mocked(sandboxVersion.checkAgentVersion).mockResolvedValue({
        sandboxVersion: null,
        expectedVersion: "0.20.6",
        isStale: false,
        verificationFailed: true,
        detectionMethod: "unknown",
        unavailableReason: "probe-failed",
      });
      vi.mocked(rebuildHermesPostRestore.restartHermesGatewayAfterStateRestore).mockResolvedValue(
        "restart-failed",
      );
      vi.mocked(
        rebuildHermesPostRestore.verifyHermesGatewayAfterStateRestoreForCronGate,
      ).mockResolvedValue({ state: "unverified" });
      vi.mocked(rebuildMcp.restoreMcpAfterRebuild).mockResolvedValue(false);
      const failure = new Error("rebuild stopped");
      const args = {
        ...input(),
        preparedBackupRecovery,
        restoreSucceeded,
        bail: vi.fn((): never => {
          throw failure;
        }),
        backupManifest: { backupPath: "/tmp/alpha-backup" } as never,
        versionCheck: { expectedVersion: "0.20.6" } as never,
        hermesCronRestoreIdentity: cronGate
          ? { pid: 41, start_time: 902, drain_token: "restore-token" }
          : undefined,
      };

      await expect(runRebuildPostRestorePhase(args)).rejects.toBe(failure);

      expect(args.bail).toHaveBeenCalledExactlyOnceWith(
        restoreSucceeded
          ? "Replacement agent version could not be verified after rebuild."
          : "State restore remained incomplete after rebuilding 'alpha'.",
      );
      const errors = vi.mocked(console.error).mock.calls.flat().join("\n");
      const logs = vi.mocked(console.log).mock.calls.flat().join("\n");
      expect(errors).toContain(
        "Replacement agent version could not be verified (expected 0.20.6).",
      );
      expect(errors).not.toContain("did not match");
      expect(errors).toContain("Backup is preserved at: /tmp/alpha-backup");
      expect(errors).toContain("nemoclaw alpha recover");
      expect(logs).toContain("nemoclaw alpha mcp restart");
      expect(errors).toContain(gatewayDetail);
      expect(errors).toContain(recoveryDetail);
      expect(errors.includes("gateway restart")).toBe(!cronGate && !preparedBackupRecovery);
      expect(errors.indexOf(gatewayDetail)).toBeLessThan(errors.indexOf("alpha recover"));
      expect(registry.updateSandbox).toHaveBeenLastCalledWith("alpha", { agentVersion: null });
      expect(
        rebuildHermesPostRestore.completeHermesCronRestoreAfterGatewayReplacement,
      ).not.toHaveBeenCalled();
    },
  );

  it.each([
    { target: "hermes", restoreSucceeded: true, reason: "invalid-gateway-binding" },
    { target: "hermes", restoreSucceeded: false, reason: "probe-failed" },
    { target: "openclaw", restoreSucceeded: true, reason: "probe-failed" },
  ] as const)(
    "omits Hermes restart guidance for $target with restore=$restoreSucceeded and $reason (#12004)",
    async ({ target, restoreSucceeded, reason }) => {
      agentName = target;
      vi.mocked(sandboxVersion.checkAgentVersion).mockResolvedValue({
        sandboxVersion: null,
        expectedVersion: "0.20.6",
        isStale: false,
        verificationFailed: true,
        detectionMethod: reason === "probe-failed" ? "unknown" : "unavailable",
        unavailableReason: reason,
      });
      const failure = new Error("rebuild stopped");
      const args = {
        ...input(),
        restoreSucceeded,
        bail: vi.fn((): never => {
          throw failure;
        }),
        versionCheck: { expectedVersion: "0.20.6" } as never,
      };
      await expect(runRebuildPostRestorePhase(args)).rejects.toBe(failure);
      expect(args.bail).toHaveBeenCalledExactlyOnceWith(
        restoreSucceeded
          ? "Replacement agent version could not be verified after rebuild."
          : "State restore remained incomplete after rebuilding 'alpha'.",
      );
      const errors = vi.mocked(console.error).mock.calls.flat().join("\n");
      expect(errors).not.toContain("gateway restart");
      expect(
        errors.includes(
          "State recovery remains incomplete. Correct the restore error, then run `nemoclaw alpha rebuild` again.",
        ),
      ).toBe(!restoreSucceeded);
    },
  );

  it("records the live replacement version only after an exact forced probe", async () => {
    agentName = "hermes";
    vi.mocked(agentDefs.loadAgent).mockReturnValue({
      name: "hermes",
      displayName: "Hermes Agent",
      expectedVersion: "0.20.6",
    } as never);
    vi.mocked(sandboxVersion.checkAgentVersion).mockResolvedValue({
      sandboxVersion: "0.20.6",
      expectedVersion: "0.20.6",
      isStale: false,
      verificationFailed: false,
      detectionMethod: "openshell-exec",
    });
    const args = {
      ...input(),
      versionCheck: { expectedVersion: "0.20.6" } as never,
    };

    await runRebuildPostRestorePhase(args);

    expect(sandboxVersion.checkAgentVersion).toHaveBeenCalledWith("alpha", { forceProbe: true });
    expect(registry.updateSandbox).toHaveBeenLastCalledWith(
      "alpha",
      expect.objectContaining({ agentVersion: "0.20.6" }),
    );
    expect(args.bail).not.toHaveBeenCalled();
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain(
      "Sandbox 'alpha' rebuild completed",
    );
  });

  it("does not claim mutable Hermes posture without the exact sandbox proof", async () => {
    agentName = "hermes";
    vi.mocked(mutableConfigPerms.inspectMutableHermesConfigPerms).mockReturnValue({
      verified: false,
      errors: ["config.yaml remains read-only"],
    });
    const args = input();

    const verification = await runRebuildPostRestorePhase(args);

    expect(args.bail).not.toHaveBeenCalled();
    expect(verification).toEqual({ mutableConfigPermissionsVerified: false });
    expect(args.log).toHaveBeenCalledWith(
      "Hermes mutable config posture was not verified: config.yaml remains read-only",
    );
  });

  it.each(["langchain-deepagents-code", "pi"] as const)(
    "proves the rebuilt %s terminal-agent posture from exact generic completion",
    async (terminalAgent) => {
      agentName = terminalAgent;

      const verification = await runRebuildPostRestorePhase(input());

      expect(verification).toEqual({ mutableConfigPermissionsVerified: true });
      expect(mutableConfigPerms.inspectMutableHermesConfigPerms).not.toHaveBeenCalled();
    },
  );

  it("keeps cron dispatch blocked through replacement health verification (#8472)", async () => {
    agentName = "hermes";
    const events: string[] = [];
    let dispatchHeld = true;
    const attemptDispatch = () => events.push(dispatchHeld ? "dispatch-blocked" : "dispatch-ran");
    vi.mocked(rebuildHermesPostRestore.restartHermesGatewayAfterStateRestore).mockImplementation(
      async () => {
        events.push("restart");
        attemptDispatch();
        return "restarted";
      },
    );
    vi.mocked(rebuildMcp.restoreMcpAfterRebuild).mockImplementation(async () => {
      events.push("mcp");
      attemptDispatch();
      return true;
    });
    vi.mocked(
      rebuildHermesPostRestore.verifyHermesGatewayAfterStateRestoreForCronGate,
    ).mockImplementation(async () => {
      events.push("health-verified");
      attemptDispatch();
      return {
        state: "healthy",
        replacementIdentity: { pid: 77, start_time: 903, drain_token: "restore-token" },
      };
    });
    vi.mocked(
      rebuildHermesPostRestore.completeHermesCronRestoreAfterGatewayReplacement,
    ).mockImplementation(() => {
      events.push("release");
      dispatchHeld = false;
      return { pid: 77, start_time: 903, drain_token: "restore-token" };
    });
    vi.mocked(messagingHostForward.ensureMessagingHostForwardAfterRebuild).mockImplementation(
      async () => {
        attemptDispatch();
        return true;
      },
    );
    const args = {
      ...input(),
      hermesCronRestoreIdentity: {
        pid: 41,
        start_time: 902,
        drain_token: "restore-token",
      },
    };

    await runRebuildPostRestorePhase(args);

    expect(events).toEqual([
      "restart",
      "dispatch-blocked",
      "mcp",
      "dispatch-blocked",
      "health-verified",
      "dispatch-blocked",
      "release",
      "dispatch-ran",
    ]);
    expect(rebuildHermesPostRestore.restartHermesGatewayAfterStateRestore).toHaveBeenCalledOnce();
    expect(args.log).toHaveBeenCalledWith(
      "Hermes cron restore gate released: pid=77, startTime=903",
    );
    expect(
      rebuildHermesPostRestore.completeHermesCronRestoreAfterGatewayReplacement,
    ).toHaveBeenCalledWith(
      "alpha",
      { pid: 41, start_time: 902, drain_token: "restore-token" },
      { pid: 77, start_time: 903, drain_token: "restore-token" },
    );
    expect(args.bail).not.toHaveBeenCalled();
  });

  it("leaves the cron gate active when replacement verification fails (#8472)", async () => {
    agentName = "hermes";
    vi.mocked(
      rebuildHermesPostRestore.verifyHermesGatewayAfterStateRestoreForCronGate,
    ).mockResolvedValue({ state: "unverified" });
    const args = {
      ...input(),
      hermesCronRestoreIdentity: {
        pid: 41,
        start_time: 902,
        drain_token: "restore-token",
      },
    };

    await runRebuildPostRestorePhase(args);

    expect(
      rebuildHermesPostRestore.completeHermesCronRestoreAfterGatewayReplacement,
    ).not.toHaveBeenCalled();
    expect(args.bail).toHaveBeenCalledWith(
      "Hermes cron restore validation failed; dispatch was not re-enabled.",
    );
    expect(messagingHostForward.ensureMessagingHostForwardAfterRebuild).not.toHaveBeenCalled();
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain(
      "Hermes cron dispatch remains drained",
    );
  });

  it("keeps restart failure ahead of MCP repair and final verification (#8472)", async () => {
    agentName = "hermes";
    const events: string[] = [];
    vi.mocked(rebuildHermesPostRestore.restartHermesGatewayAfterStateRestore).mockImplementation(
      async () => {
        events.push("restart-failed");
        return "restart-failed";
      },
    );
    vi.mocked(rebuildMcp.restoreMcpAfterRebuild).mockImplementation(async () => {
      events.push("mcp");
      return true;
    });
    vi.mocked(
      rebuildHermesPostRestore.verifyHermesGatewayAfterStateRestoreForCronGate,
    ).mockImplementation(async (_sandboxName, _agentName, restartState) => {
      events.push(`verify:${restartState}`);
      return { state: "unverified" };
    });
    const args = {
      ...input(),
      hermesCronRestoreIdentity: {
        pid: 41,
        start_time: 902,
        drain_token: "restore-token",
      },
    };

    await runRebuildPostRestorePhase(args);

    expect(events).toEqual(["restart-failed", "mcp", "verify:restart-failed"]);
    expect(
      rebuildHermesPostRestore.completeHermesCronRestoreAfterGatewayReplacement,
    ).not.toHaveBeenCalled();
    expect(args.bail).toHaveBeenCalledWith(
      "Hermes cron restore validation failed; dispatch was not re-enabled.",
    );
  });

  it("leaves the cron gate active when replacement completion fails (#8472)", async () => {
    agentName = "hermes";
    vi.mocked(
      rebuildHermesPostRestore.completeHermesCronRestoreAfterGatewayReplacement,
    ).mockImplementation(() => {
      throw new Error("replacement cron tree is invalid");
    });
    const args = {
      ...input(),
      backupManifest: { backupPath: "/tmp/alpha-backup" } as never,
      hermesCronRestoreIdentity: {
        pid: 41,
        start_time: 902,
        drain_token: "restore-token",
      },
    };

    await runRebuildPostRestorePhase(args);

    expect(args.bail).toHaveBeenCalledWith(
      "Hermes cron restore validation failed; dispatch was not re-enabled.",
    );
    expect(messagingHostForward.ensureMessagingHostForwardAfterRebuild).not.toHaveBeenCalled();
    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(output).toContain("replacement cron tree is invalid");
    expect(output).toContain("Backup is preserved at: /tmp/alpha-backup");
    expect(output).toContain("nemoclaw alpha recover");
  });

  it("reports preserved recovery authority when release marker rollback fails (#8472)", async () => {
    agentName = "hermes";
    const rollbackFailure = new Error(
      "Hermes cron complete failed: Hermes cron restore drain release failed and its marker could not be restored",
    );
    vi.mocked(
      rebuildHermesPostRestore.completeHermesCronRestoreAfterGatewayReplacement,
    ).mockImplementation(() => {
      throw rollbackFailure;
    });
    vi.mocked(
      rebuildHermesPostRestore.isHermesCronRestoreDrainMarkerRollbackFailure,
    ).mockImplementation((error) => error === rollbackFailure);
    const args = {
      ...input(),
      hermesCronRestoreIdentity: {
        pid: 41,
        start_time: 902,
        drain_token: "restore-token",
      },
    };

    await runRebuildPostRestorePhase(args);

    expect(args.bail).toHaveBeenCalledWith(
      "Hermes cron restore release state requires immediate recovery.",
    );
    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(output).toContain("drain release failed and its marker could not be restored");
    expect(output).toContain("root-owned recovery state was preserved");
    expect(output).toContain("reacquire the gate and validate restored cron state");
    expect(output).toContain("nemoclaw alpha recover");
    expect(output).not.toContain("dispatch was not re-enabled");
    expect(
      rebuildHermesPostRestore.isHermesCronRestoreDrainMarkerRollbackFailure,
    ).toHaveBeenCalledWith(rollbackFailure);
  });

  it("keeps the gate active and repairs MCP before cron recovery (#8472)", async () => {
    agentName = "hermes";
    vi.mocked(rebuildMcp.restoreMcpAfterRebuild).mockResolvedValue(false);
    const args = {
      ...input(),
      hermesCronRestoreIdentity: {
        pid: 41,
        start_time: 902,
        drain_token: "restore-token",
      },
    };

    await runRebuildPostRestorePhase(args);

    expect(
      rebuildHermesPostRestore.completeHermesCronRestoreAfterGatewayReplacement,
    ).not.toHaveBeenCalled();
    expect(args.bail).toHaveBeenCalledWith(
      "Hermes MCP restoration failed; cron dispatch was not re-enabled.",
    );
    const mcpCall = vi
      .mocked(console.log)
      .mock.calls.findIndex((call) => String(call[0]).includes("nemoclaw alpha mcp restart"));
    const recoverCall = vi
      .mocked(console.error)
      .mock.calls.findIndex((call) => String(call[0]).includes("nemoclaw alpha recover"));
    expect(mcpCall).toBeGreaterThanOrEqual(0);
    expect(recoverCall).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(console.log).mock.invocationCallOrder[mcpCall]).toBeLessThan(
      vi.mocked(console.error).mock.invocationCallOrder[recoverCall] ?? 0,
    );
  });

  it("repairs MCP before cron recovery when gateway verification also fails (#8472)", async () => {
    agentName = "hermes";
    vi.mocked(rebuildMcp.restoreMcpAfterRebuild).mockResolvedValue(false);
    vi.mocked(
      rebuildHermesPostRestore.verifyHermesGatewayAfterStateRestoreForCronGate,
    ).mockResolvedValue({ state: "unverified" });
    const args = {
      ...input(),
      hermesCronRestoreIdentity: {
        pid: 41,
        start_time: 902,
        drain_token: "restore-token",
      },
    };

    await runRebuildPostRestorePhase(args);

    expect(
      rebuildHermesPostRestore.completeHermesCronRestoreAfterGatewayReplacement,
    ).not.toHaveBeenCalled();
    const mcpCall = vi
      .mocked(console.log)
      .mock.calls.findIndex((call) => String(call[0]).includes("nemoclaw alpha mcp restart"));
    const recoverCall = vi
      .mocked(console.error)
      .mock.calls.findIndex((call) => String(call[0]).includes("nemoclaw alpha recover"));
    expect(mcpCall).toBeGreaterThanOrEqual(0);
    expect(recoverCall).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(console.log).mock.invocationCallOrder[mcpCall]).toBeLessThan(
      vi.mocked(console.error).mock.invocationCallOrder[recoverCall] ?? 0,
    );
  });

  it("points Hermes rebuilds to the replacement API token retrieval command (#7175)", async () => {
    agentName = "hermes";

    await runRebuildPostRestorePhase(input());

    const outputLines = vi.mocked(console.log).mock.calls.flat().map(String);
    const output = outputLines.join("\n");
    expect(output).toContain("Hermes API bearer token changed during rebuild");
    expect(output).toContain("nemoclaw alpha gateway-token --quiet");
    expect(
      outputLines.findIndex((line) => line.includes("API bearer token changed")),
    ).toBeGreaterThan(outputLines.findIndex((line) => line.includes("rebuilt successfully")));
  });

  it("does not print the Hermes API token notice for OpenClaw rebuilds (#7175)", async () => {
    await runRebuildPostRestorePhase(input());

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).not.toContain("Hermes API bearer token");
    expect(output).not.toContain("gateway-token --quiet");
  });

  it("blocks completion before the Hermes token notice when webhook forwarding is unverified", async () => {
    agentName = "hermes";
    vi.mocked(messagingHostForward.ensureMessagingHostForwardAfterRebuild).mockResolvedValue(false);
    const args = input();

    await runRebuildPostRestorePhase(args);

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(args.bail).toHaveBeenCalledWith(
      "Messaging webhook forwarding remained unverified for 'alpha'.",
    );
    expect(output).toContain("rebuilt but some post-restore steps were incomplete");
    expect(output).not.toContain("Hermes API bearer token changed during rebuild");
    expect(output).not.toContain("nemoclaw alpha gateway-token --quiet");
  });

  it("does not print the Hermes API token notice when prepared backup recovery is incomplete (#7175)", async () => {
    agentName = "hermes";
    vi.mocked(messagingHostForward.ensureMessagingHostForwardAfterRebuild).mockResolvedValue(false);
    const args = input();
    args.preparedBackupRecovery = true;

    await runRebuildPostRestorePhase(args);

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).not.toContain("Hermes API bearer token changed during rebuild");
    expect(output).not.toContain("gateway-token --quiet");
    expect(args.bail).toHaveBeenCalledWith(
      "Messaging webhook forwarding remained unverified for 'alpha'.",
    );
  });

  it("reconciles the registry before verifying host forwarding (#8283)", async () => {
    const observed: string[] = [];
    vi.mocked(registry.updateSandbox).mockImplementation(() => {
      observed.push("registry");
      return true;
    });
    vi.mocked(messagingHostForward.ensureMessagingHostForwardAfterRebuild).mockImplementation(
      async () => {
        observed.push("forward");
        return true;
      },
    );
    const args = input();

    await runRebuildPostRestorePhase(args);

    expect(observed).toEqual(["registry", "forward"]);
    expect(args.bail).not.toHaveBeenCalled();
  });

  it("names the rebuild recovery command when host forwarding is unverified", async () => {
    vi.mocked(messagingHostForward.ensureMessagingHostForwardAfterRebuild).mockResolvedValue(false);
    const args = input();

    await runRebuildPostRestorePhase(args);

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("Messaging webhook forward was not verified");
    expect(output).toContain("nemoclaw alpha rebuild --yes");
    expect(args.bail).toHaveBeenCalledWith(
      "Messaging webhook forwarding remained unverified for 'alpha'.",
    );
  });

  it("passes the Hermes config result through the successful completion report", async () => {
    agentName = "hermes";
    const args = {
      ...input(),
      hermesOperatorConfigRestore: {
        restoredKeys: ["memory.provider"],
        droppedKeys: ["model.default"],
      },
    };

    await runRebuildPostRestorePhase(args);

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("Restored Hermes operator config keys: memory.provider");
    expect(output).toContain("Dropped Hermes operator config keys: model.default");
    expect(args.bail).not.toHaveBeenCalled();
  });

  it("prints the Hermes config result before bailing on incomplete state restore", async () => {
    agentName = "hermes";
    const args = {
      ...input(),
      restoreSucceeded: false,
      backupManifest: { backupPath: "/tmp/hermes-backup" } as never,
      hermesOperatorConfigRestore: {
        restoredKeys: ["memory.provider"],
        droppedKeys: ["model.default"],
      },
    };

    await runRebuildPostRestorePhase(args);

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("Restored Hermes operator config keys: memory.provider");
    expect(output).toContain("Dropped Hermes operator config keys: model.default");
    expect(args.bail).toHaveBeenCalledWith(
      "State restore remained incomplete after rebuilding 'alpha'.",
    );
  });

  it("prints every incomplete OpenClaw recovery report in a fixed order (#8283)", async () => {
    vi.mocked(
      rebuildConfigHash.refreshMutableOpenClawConfigHashAfterPostRestoreWrites,
    ).mockResolvedValue(false);
    vi.mocked(mutableConfigPerms.repairMutableConfigPerms).mockReturnValue({
      applied: true,
      verified: false,
      errors: ["config is unreadable"],
    });
    vi.mocked(messagingHostForward.ensureMessagingHostForwardAfterRebuild).mockResolvedValue(false);
    vi.mocked(rebuildMcp.restoreMcpAfterRebuild).mockResolvedValue(false);
    const args = {
      ...input(),
      backupManifest: { backupPath: "/tmp/alpha-backup" } as never,
      restoreSucceeded: false,
      failedPresets: ["messaging-telegram"],
      failedPresetRemovals: ["messaging-discord"],
      policyPresetReconciliationVerified: false,
    };

    await runRebuildPostRestorePhase(args);

    const output = vi.mocked(console.log).mock.calls.flat().map(String).join("\n");
    // Every incomplete-recovery report this path can emit for an OpenClaw
    // rebuild. The Hermes gateway report is unreachable here because
    // verifyHermesGatewayAfterStateRestore returns "not-applicable" for
    // OpenClaw; baseline exclusions are covered by the #7194 test above.
    const ordered = [
      "State restore was incomplete",
      "Mutable config permissions were not verified",
      "Mutable OpenClaw config hash was not refreshed",
      "Messaging webhook forward was not verified",
      "MCP bridge definitions were preserved but not fully refreshed",
    ];
    const offsets = ordered.map((fragment) => output.indexOf(fragment));
    expect(offsets.every((offset) => offset >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((left, right) => left - right));
    expect(args.bail).toHaveBeenCalledWith(
      "State restore remained incomplete after rebuilding 'alpha'.",
    );
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain(
      "nemoclaw alpha rebuild",
    );
  });
});

describe("Hermes operator config completion report", () => {
  it("stays silent when no restore report exists", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      printHermesOperatorConfigRestoreReport("hermes", undefined);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("explicitly names restored keys and an empty dropped set", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      printHermesOperatorConfigRestoreReport("hermes", {
        restoredKeys: ["memory.provider", "model.max_tokens", "custom_providers"],
        droppedKeys: [],
      });
      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain(
        "Restored Hermes operator config keys: memory.provider, model.max_tokens, custom_providers",
      );
      expect(output).toContain("Dropped Hermes operator config keys: none");
    } finally {
      log.mockRestore();
    }
  });

  it("names every dropped key when the set is non-empty", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      printHermesOperatorConfigRestoreReport("hermes", {
        restoredKeys: ["memory.provider"],
        droppedKeys: ["model.default", "providers.route.api"],
      });
      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain(
        "Dropped Hermes operator config keys: model.default, providers.route.api",
      );
    } finally {
      log.mockRestore();
    }
  });
});
