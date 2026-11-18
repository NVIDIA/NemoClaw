// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";

import * as agentDefs from "../../src/lib/agent/defs";
import * as agentRuntime from "../../src/lib/agent/runtime";
import * as mutableConfigPerms from "../../src/lib/sandbox/mutable-config-perms";
import * as registry from "../../src/lib/state/registry";
import * as sandboxVersion from "../../src/lib/sandbox/version";
import { rebuildOnboardDependencies } from "../../src/lib/actions/sandbox/rebuild-onboard-dependencies";
import * as pairingSettlement from "../../src/lib/onboard/machine/finalization-deps";
import * as launchReadiness from "../../src/lib/actions/sandbox/launch-readiness";
import * as portableReceipts from "../../src/lib/onboard/experimental/portable-runtime-receipt-readiness";
import * as messagingHostForward from "../../src/lib/actions/sandbox/messaging-host-forward-lifecycle";
import * as restoreWindow from "../../src/lib/actions/sandbox/runtime/openclaw-lifecycle";
import * as rebuildHermesPostRestore from "../../src/lib/actions/sandbox/rebuild-hermes-post-restore";
import * as rebuildMcp from "../../src/lib/actions/sandbox/rebuild-mcp-phase";
import * as rebuildMessaging from "../../src/lib/actions/sandbox/rebuild-messaging-phase";

import {
  createBuiltInChannelManifestRegistry,
  createBuiltInRenderTemplateResolver,
} from "../../src/lib/messaging/channels";
import { MessagingWorkflowPlanner } from "../../src/lib/messaging/compiler";

export function rebuildPostRestoreInput(agentName: string) {
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

export async function hermesTeamsPlan(disabled = false) {
  vi.stubEnv("MSTEAMS_APP_ID", "test-teams-app");
  vi.stubEnv("MSTEAMS_TENANT_ID", "test-teams-tenant");
  vi.stubEnv("TEAMS_ALLOWED_USERS", "00000000-0000-0000-0000-000000000001");
  vi.stubEnv("MSTEAMS_PORT", "3979");
  return new MessagingWorkflowPlanner(
    createBuiltInChannelManifestRegistry(),
    undefined,
    createBuiltInRenderTemplateResolver(),
  ).buildPlan({
    sandboxName: "alpha",
    agent: "hermes",
    workflow: "rebuild",
    isInteractive: false,
    configuredChannels: ["teams"],
    disabledChannels: disabled ? ["teams"] : [],
    credentialAvailability: { MSTEAMS_APP_PASSWORD: true },
  });
}

export const runtimeKindByAgent = {
  openclaw: "gateway",
  hermes: "gateway",
  "langchain-deepagents-code": "terminal",
  pi: "terminal",
} as const;

export const hermesRebuildVerificationCases = [
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
];

export function installRebuildPostRestoreSpies(
  getAgentName: () => keyof typeof runtimeKindByAgent,
  order: string[],
): void {
  vi.spyOn(
    rebuildOnboardDependencies,
    "verifyRebuiltOpenClawCompatibleEndpoint",
  ).mockImplementation(async () => {
    order.push("inference-smoke");
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(agentRuntime, "getSessionAgent").mockImplementation(() =>
    getAgentName() === "openclaw" ? null : ({ name: getAgentName() } as never),
  );
  vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue("test agent");
  vi.spyOn(agentDefs, "loadAgent").mockImplementation(
    () =>
      ({
        name: getAgentName(),
        expectedVersion: null,
        runtime: { kind: runtimeKindByAgent[getAgentName()] },
      }) as never,
  );
  vi.spyOn(restoreWindow, "beginUnregisteredOpenClawBackupQuiesce").mockImplementation(
    async (sandboxName, runtimeSelection) => {
      order.push("maintenance-begin");
      return {
        ok: true,
        window: {
          sandboxName,
          kind: "backup",
          ...(runtimeSelection ? { runtimeSelection } : {}),
        },
      };
    },
  );
  vi.spyOn(restoreWindow, "prepareUnregisteredOpenClawPostRestoreDoctor").mockImplementation(
    async ({ sandboxName, runtimeSelection }) => {
      order.push("doctor");
      return {
        ok: true,
        window: { sandboxName, ...(runtimeSelection ? { runtimeSelection } : {}) },
      };
    },
  );
  vi.spyOn(restoreWindow, "finishUnregisteredOpenClawPostRestoreDoctor").mockImplementation(
    async () => {
      order.push("native-start");
      return { ok: true };
    },
  );
  vi.spyOn(restoreWindow, "abortUnregisteredOpenClawPostRestoreDoctor").mockImplementation(
    async () => {
      order.push("doctor-abort");
      return { ok: true };
    },
  );
  vi.spyOn(rebuildMessaging, "reapplyMessagingManifestBeforeAgentStart").mockImplementation(
    async () => {
      order.push("messaging");
    },
  );
  vi.spyOn(rebuildMessaging, "finalizePendingMessagingRemovalsAfterRestore").mockImplementation(
    (plan) => plan,
  );
  vi.spyOn(mutableConfigPerms, "inspectMutableHermesConfigPerms").mockReturnValue({
    verified: true,
    errors: [],
  });
  vi.spyOn(rebuildMcp, "restoreMcpAfterRebuild").mockImplementation(async () => {
    order.push("mcp");
    return true;
  });
  vi.spyOn(rebuildHermesPostRestore, "refreshRestoredHermesInferenceRoute").mockResolvedValue(
    undefined,
  );
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
    () => ({ agent: getAgentName() === "openclaw" ? null : getAgentName() }) as never,
  );
  vi.spyOn(registry, "updateSandbox").mockReturnValue(true);
  vi.spyOn(portableReceipts, "classifyPortableLifecycleReceipt").mockReturnValue({
    kind: "absent",
  });
  vi.spyOn(pairingSettlement, "settleOrdinaryOpenClawPairing").mockResolvedValue({
    kind: "settled",
  });
  vi.spyOn(launchReadiness, "settlePortableOpenClawPairing").mockResolvedValue({
    kind: "not-portable",
  });
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
}
