// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as agentDefs from "../../agent/defs";
import * as agentRuntime from "../../agent/runtime";
import * as shields from "../../shields";
import * as registry from "../../state/registry";
import * as messagingHostForward from "./messaging-host-forward-lifecycle";
import * as processRecovery from "./process-recovery";
import * as rebuildConfigHash from "./rebuild-config-hash";
import * as rebuildHermesPostRestore from "./rebuild-hermes-post-restore";
import * as rebuildMcp from "./rebuild-mcp-phase";
import * as rebuildMessaging from "./rebuild-messaging-phase";
import { runRebuildPostRestorePhase } from "./rebuild-post-restore-phase";
import * as sessionModels from "./reconcile-session-models";

describe("rebuild post-restore session model reconciliation (#7102)", () => {
  let agentName: "openclaw" | "hermes";
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
      () => ({ name: agentName, expectedVersion: null }) as never,
    );
    vi.spyOn(processRecovery, "executeSandboxCommand").mockImplementation(() => {
      order.push("doctor");
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.spyOn(sessionModels, "reconcileStalePinnedSessionModelsAfterRebuild").mockImplementation(
      () => {
        order.push("reconcile");
      },
    );
    vi.spyOn(rebuildMessaging, "reapplyMessagingManifestAfterOpenClawDoctor").mockImplementation(
      async () => {
        order.push("messaging");
      },
    );
    vi.spyOn(
      rebuildConfigHash,
      "refreshMutableOpenClawConfigHashAfterPostRestoreWrites",
    ).mockImplementation(() => {
      order.push("config-hash");
      return true;
    });
    vi.spyOn(shields, "repairMutableConfigPerms").mockReturnValue({
      applied: false,
      reason: "not needed",
      skipReason: "not-needed",
    } as never);
    vi.spyOn(rebuildMcp, "restoreMcpAfterRebuild").mockResolvedValue(true);
    vi.spyOn(rebuildHermesPostRestore, "ensureHermesGatewayAfterStateRestore").mockImplementation(
      (_sandboxName, targetAgentName) =>
        targetAgentName === "hermes" ? "healthy" : "not-applicable",
    );
    vi.spyOn(registry, "getSandbox").mockImplementation(
      () => ({ agent: agentName === "openclaw" ? null : agentName }) as never,
    );
    vi.spyOn(registry, "updateSandbox").mockReturnValue(true);
    vi.spyOn(messagingHostForward, "ensureMessagingHostForwardAfterRebuild").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function input() {
    return {
      sandboxName: "alpha",
      targetAgentName: agentName,
      sandboxEntry: {} as never,
      messagingPlan: null,
      backupManifest: null,
      mcpEntries: [],
      restoreSucceeded: true,
      backupWasForceSkipped: false,
      failedPresets: [],
      finalBuiltinPresets: [],
      failedPresetRemovals: [],
      policyPresetReconciliationVerified: true,
      staleRecovery: false,
      recoveryRecreate: false,
      preparedBackupRecovery: false,
      staleSandboxWasLocked: false,
      versionCheck: { expectedVersion: null } as never,
      relockShieldsIfNeeded: vi.fn(() => true),
      log: vi.fn(),
      bail: vi.fn() as never,
    };
  }

  it("reconciles OpenClaw sessions after doctor and before later config writes", async () => {
    await runRebuildPostRestorePhase(input());

    expect(order).toEqual(["doctor", "reconcile", "messaging", "config-hash"]);
  });

  it("does not run OpenClaw session reconciliation for another agent", async () => {
    agentName = "hermes";
    const args = input();

    await runRebuildPostRestorePhase(args);

    expect(args.bail).not.toHaveBeenCalled();
    expect(sessionModels.reconcileStalePinnedSessionModelsAfterRebuild).not.toHaveBeenCalled();
    expect(processRecovery.executeSandboxCommand).not.toHaveBeenCalled();
  });
});
