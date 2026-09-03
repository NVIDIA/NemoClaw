// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as agentDefs from "../../agent/defs";
import * as agentRuntime from "../../agent/runtime";
import * as mutableConfigPerms from "../../sandbox/mutable-config-perms";
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
    vi.spyOn(processRecovery, "executeSandboxExecCommand").mockImplementation(() => {
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
    vi.spyOn(rebuildConfigHash, "verifyFinalMutableOpenClawConfigHash").mockImplementation(() => {
      order.push("config-hash-final");
      return true;
    });
    vi.spyOn(mutableConfigPerms, "repairMutableConfigPerms").mockReturnValue({
      applied: true,
      verified: true,
      errors: [],
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
      (_sandboxName, targetAgentName) =>
        targetAgentName === "hermes" ? "restarted" : "not-applicable",
    );
    vi.spyOn(rebuildHermesPostRestore, "verifyHermesGatewayAfterStateRestore").mockImplementation(
      (_sandboxName, targetAgentName) =>
        targetAgentName === "hermes" ? "healthy" : "not-applicable",
    );
    vi.spyOn(
      rebuildHermesPostRestore,
      "verifyHermesGatewayAfterStateRestoreForCronGate",
    ).mockReturnValue({
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
    vi.spyOn(messagingHostForward, "ensureMessagingHostForwardAfterRebuild").mockImplementation(
      () => {
        order.push("host-forward");
        return true;
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("reconciles sessions after doctor, then seals config after MCP restoration (#7102, #9946)", async () => {
    await runRebuildPostRestorePhase(input());

    expect(order).toEqual([
      "doctor",
      "reconcile",
      "messaging",
      "mcp",
      "config-hash",
      "config-hash-final",
      "host-forward",
      "config-hash-final",
    ]);
    expect(processRecovery.executeSandboxExecCommand).toHaveBeenCalledExactlyOnceWith(
      "alpha",
      "openclaw doctor --fix",
      300_000,
      { allowLocalDockerFallback: false },
    );
  });

  it("does not record a final hash without trusted doctor completion (#9946)", async () => {
    vi.mocked(processRecovery.executeSandboxExecCommand).mockReturnValue(null);
    const args = input();

    await runRebuildPostRestorePhase(args);

    expect(
      rebuildConfigHash.refreshMutableOpenClawConfigHashAfterPostRestoreWrites,
    ).not.toHaveBeenCalled();
    expect(rebuildConfigHash.verifyFinalMutableOpenClawConfigHash).not.toHaveBeenCalled();
    expect(rebuildMcp.restoreMcpAfterRebuild).not.toHaveBeenCalled();
    expect(messagingHostForward.ensureMessagingHostForwardAfterRebuild).not.toHaveBeenCalled();
    expect(args.bail).toHaveBeenCalledWith(
      "OpenClaw post-upgrade structure repair completion was not verified after rebuild.",
    );
    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("Post-upgrade structure repair completion was not verified");
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

  it("stops before later writes when doctor exits nonzero (#9946)", async () => {
    vi.mocked(processRecovery.executeSandboxExecCommand).mockReturnValue({
      status: 255,
      stdout: "",
      stderr: "",
    });
    const args = input();

    await runRebuildPostRestorePhase(args);

    expect(sessionModels.reconcileStalePinnedSessionModelsAfterRebuild).not.toHaveBeenCalled();
    expect(rebuildMessaging.reapplyMessagingManifestAfterOpenClawDoctor).not.toHaveBeenCalled();
    expect(mutableConfigPerms.repairMutableConfigPerms).not.toHaveBeenCalled();
    expect(rebuildHermesPostRestore.restartHermesGatewayAfterStateRestore).not.toHaveBeenCalled();
    expect(rebuildHermesPostRestore.verifyHermesGatewayAfterStateRestore).not.toHaveBeenCalled();
    expect(rebuildMcp.restoreMcpAfterRebuild).not.toHaveBeenCalled();
    expect(
      rebuildConfigHash.refreshMutableOpenClawConfigHashAfterPostRestoreWrites,
    ).not.toHaveBeenCalled();
    expect(rebuildConfigHash.verifyFinalMutableOpenClawConfigHash).not.toHaveBeenCalled();
    expect(messagingHostForward.ensureMessagingHostForwardAfterRebuild).not.toHaveBeenCalled();
    expect(args.bail).toHaveBeenCalledWith(
      "OpenClaw post-upgrade structure repair failed during rebuild.",
    );
    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("Post-upgrade structure repair failed (doctor returned 255)");
    expect(output).not.toContain("rebuilt successfully");
  });

  it("stops rebuild when OpenClaw messaging config reapply fails", async () => {
    vi.mocked(rebuildMessaging.reapplyMessagingManifestAfterOpenClawDoctor).mockRejectedValue(
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
    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(output).toContain("Messaging manifest config reapply failed after doctor");
  });

  it("captures a completed doctor mutation and rejects a later config change (#9946)", async () => {
    let configHashValid = true;
    vi.mocked(processRecovery.executeSandboxExecCommand).mockImplementation(() => {
      configHashValid = false;
      return { status: 0, stdout: "sensitive doctor output", stderr: "" };
    });
    vi.mocked(
      rebuildConfigHash.refreshMutableOpenClawConfigHashAfterPostRestoreWrites,
    ).mockImplementation(() => {
      configHashValid = true;
      return true;
    });
    vi.mocked(messagingHostForward.ensureMessagingHostForwardAfterRebuild).mockImplementation(
      () => {
        configHashValid = false;
        return true;
      },
    );
    vi.mocked(rebuildConfigHash.verifyFinalMutableOpenClawConfigHash).mockImplementation(
      () => configHashValid,
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
    expect(processRecovery.executeSandboxExecCommand).not.toHaveBeenCalled();
    expect(mutableConfigPerms.inspectMutableHermesConfigPerms).toHaveBeenCalledWith("alpha");
    expect(verification).toEqual({ mutableConfigPermissionsVerified: true });
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
      () => {
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
    ).mockImplementation(() => {
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
      () => {
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
    ).mockReturnValue({ state: "unverified" });
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
      () => {
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
    ).mockImplementation((_sandboxName, _agentName, restartState) => {
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
    ).mockReturnValue({ state: "unverified" });
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

  it("does not print the Hermes API token notice when post-restore verification is incomplete (#7175)", async () => {
    agentName = "hermes";
    vi.mocked(rebuildHermesPostRestore.verifyHermesGatewayAfterStateRestore).mockReturnValue(
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
    vi.mocked(rebuildHermesPostRestore.verifyHermesGatewayAfterStateRestore).mockReturnValue(
      "recovered",
    );
    const args = input();

    await runRebuildPostRestorePhase(args);

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(args.bail).not.toHaveBeenCalled();
    expect(output).toContain("Hermes gateway recovered after state restore");
    expect(output).toContain("Hermes API bearer token changed during rebuild");
  });

  it("reconciles the registry before verifying host forwarding (#8283)", async () => {
    const observed: string[] = [];
    vi.mocked(registry.updateSandbox).mockImplementation(() => {
      observed.push("registry");
      return true;
    });
    vi.mocked(messagingHostForward.ensureMessagingHostForwardAfterRebuild).mockImplementation(
      () => {
        observed.push("forward");
        return true;
      },
    );
    const args = input();

    await runRebuildPostRestorePhase(args);

    expect(observed).toEqual(["registry", "forward"]);
    expect(args.bail).not.toHaveBeenCalled();
  });

  it("names the connect recovery command when host forwarding is unverified (#8283)", async () => {
    vi.mocked(messagingHostForward.ensureMessagingHostForwardAfterRebuild).mockReturnValue(false);
    const args = input();

    await runRebuildPostRestorePhase(args);

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("Messaging webhook forward was not verified");
    expect(output).toContain("nemoclaw alpha connect");
    expect(args.bail).not.toHaveBeenCalled();
  });

  it("prints every incomplete OpenClaw recovery report in a fixed order (#8283)", async () => {
    vi.mocked(
      rebuildConfigHash.refreshMutableOpenClawConfigHashAfterPostRestoreWrites,
    ).mockReturnValue(false);
    vi.mocked(mutableConfigPerms.repairMutableConfigPerms).mockReturnValue({
      applied: true,
      verified: false,
      errors: ["config is unreadable"],
    });
    vi.mocked(messagingHostForward.ensureMessagingHostForwardAfterRebuild).mockReturnValue(false);
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
