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

describe("rebuild post-restore phase", () => {
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

  it("reconciles OpenClaw sessions after doctor and before later config writes (#7102)", async () => {
    await runRebuildPostRestorePhase(input());

    expect(order).toEqual(["doctor", "reconcile", "messaging", "config-hash"]);
  });

  it("does not run OpenClaw session reconciliation for another agent (#7102)", async () => {
    agentName = "hermes";
    const args = input();

    await runRebuildPostRestorePhase(args);

    expect(args.bail).not.toHaveBeenCalled();
    expect(sessionModels.reconcileStalePinnedSessionModelsAfterRebuild).not.toHaveBeenCalled();
    expect(processRecovery.executeSandboxCommand).not.toHaveBeenCalled();
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

  it("does not print the Hermes API token notice when post-restore verification is incomplete (#7175)", async () => {
    agentName = "hermes";
    vi.mocked(rebuildHermesPostRestore.ensureHermesGatewayAfterStateRestore).mockReturnValue(
      "unverified",
    );
    const args = input();

    await runRebuildPostRestorePhase(args);

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).not.toContain("Hermes API bearer token changed during rebuild");
    expect(output).not.toContain("gateway-token --quiet");
    expect(args.bail).toHaveBeenCalledWith("Hermes post-restore verification failed for 'alpha'.");
  });

  it("still prints the Hermes API token notice when a non-fatal post-restore step is unverified (#7175)", async () => {
    agentName = "hermes";
    vi.mocked(messagingHostForward.ensureMessagingHostForwardAfterRebuild).mockReturnValue(false);
    const args = input();

    await runRebuildPostRestorePhase(args);

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(args.bail).not.toHaveBeenCalled();
    expect(output).toContain("rebuilt but some post-restore steps were incomplete");
    expect(output).toContain("Hermes API bearer token changed during rebuild");
    expect(output).toContain("nemoclaw alpha gateway-token --quiet");
  });

  it("does not print the Hermes API token notice when prepared backup recovery is incomplete (#7175)", async () => {
    agentName = "hermes";
    vi.mocked(messagingHostForward.ensureMessagingHostForwardAfterRebuild).mockReturnValue(false);
    const args = input();
    args.preparedBackupRecovery = true;

    await runRebuildPostRestorePhase(args);

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).not.toContain("Hermes API bearer token changed during rebuild");
    expect(output).not.toContain("gateway-token --quiet");
    expect(args.bail).toHaveBeenCalledWith(
      "Prepared backup recovery for 'alpha' completed with unverified post-restore state.",
    );
  });

  it("prints the Hermes API token notice after gateway recovery (#7175)", async () => {
    agentName = "hermes";
    vi.mocked(rebuildHermesPostRestore.ensureHermesGatewayAfterStateRestore).mockReturnValue(
      "recovered",
    );
    const args = input();

    await runRebuildPostRestorePhase(args);

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(args.bail).not.toHaveBeenCalled();
    expect(output).toContain("Hermes gateway recovered after state restore");
    expect(output).toContain("Hermes API bearer token changed during rebuild");
  });

  it("does not print the Hermes API token notice after a shields relock failure (#7175)", async () => {
    agentName = "hermes";
    const args = input();
    args.relockShieldsIfNeeded = vi.fn(() => false);

    await runRebuildPostRestorePhase(args);

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).not.toContain("Hermes API bearer token changed during rebuild");
    expect(output).not.toContain("gateway-token --quiet");
    expect(args.bail).toHaveBeenCalledWith("Failed to re-apply shields lockdown.");
  });
});
