// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";
import { RD as _RD, R } from "../../cli/terminal-style";
import type { SandboxMessagingPlan } from "../../messaging";
import { markLastStartedStepFailed } from "../../onboard/exit-step-failure";
import * as shields from "../../shields";
import type { Session } from "../../state/onboard-session";
import * as onboardSession from "../../state/onboard-session";
import * as registry from "../../state/registry";
import type { RebuildBackupManifest } from "./rebuild-backup-phase";
import type { RebuildBail, RebuildLog } from "./rebuild-credential-preflight";
import type { RebuildDurableConfig } from "./rebuild-durable-config";
import { isolateAmbientRecreateEnv } from "./rebuild-env-isolation";
import {
  pinRebuildAgentBaseImageForRecreate,
  type RebuildAgentBaseImagePreflight,
  type RebuildSandboxEntry,
} from "./rebuild-flow-helpers";
import {
  getRebuildSandboxGpuOverrides,
  type RebuildRecreateOnboardOpts,
} from "./rebuild-gpu-opt-out";
import {
  type McpRebuildPreparation,
  printMcpRebuildRetryCommand,
  restoreMcpRegistryForRebuildRetry,
} from "./rebuild-mcp-phase";
import { rebuildOnboardDependencies } from "./rebuild-onboard-dependencies";
import type { RebuildRegistryRollback } from "./rebuild-registry-rollback";
import type { RebuildResumeConfig } from "./rebuild-resume-config";
import { printRebuildShieldsRecovery, type RebuildShieldsWindow } from "./rebuild-shields";

export interface RebuildRecreatePhaseInput {
  sandboxName: string;
  sandboxEntry: RebuildSandboxEntry;
  sessionSnapshot: Session | null;
  sessionMatchesSandbox: boolean;
  durableConfig: RebuildDurableConfig;
  resumeConfig: RebuildResumeConfig;
  recreateOptions: RebuildRecreateOnboardOpts;
  fromDockerfile: string | null;
  rebuildAgent: string | null;
  messagingPlan: SandboxMessagingPlan | null;
  rebuildsHermesSandbox: boolean;
  hermesToolGateways: string[];
  hasHermesToolGateways: boolean;
  sessionPolicyPresets: string[] | null;
  credentialEnv: string | null;
  baseImagePreflight: RebuildAgentBaseImagePreflight;
  recoveryRecreate: boolean;
  registryRollback: RebuildRegistryRollback;
  backupManifest: RebuildBackupManifest;
  mcpEntries: McpRebuildPreparation["entries"];
  rebuildShieldsWindow: RebuildShieldsWindow;
  relockShieldsIfNeeded: (sandboxStillExists: boolean) => boolean;
  onCreated: () => void;
  log: RebuildLog;
  bail: RebuildBail;
}

/**
 * Recreate the deleted sandbox from its validated registry-derived contract.
 * Boundary coverage: rebuild-flow.test.ts exercises success, process-exit and
 * thrown failures, stale/MCP retry restoration, session pinning, and env isolation.
 */
export async function runRebuildRecreatePhase(input: RebuildRecreatePhaseInput): Promise<boolean> {
  const {
    sandboxName,
    sandboxEntry: sb,
    sessionSnapshot: sessionBefore,
    sessionMatchesSandbox,
    durableConfig: rebuildDurableConfig,
    resumeConfig,
    recreateOptions,
    fromDockerfile: storedFromDockerfile,
    rebuildAgent,
    messagingPlan: rebuildMessagingPlan,
    rebuildsHermesSandbox,
    hermesToolGateways: rebuildHermesToolGateways,
    hasHermesToolGateways: hasRebuildHermesToolGateways,
    sessionPolicyPresets: rebuildSessionPolicyPresets,
    credentialEnv: rebuildCredentialEnv,
    baseImagePreflight: rebuildBaseImagePreflight,
    recoveryRecreate,
    registryRollback,
    backupManifest,
    mcpEntries: rebuildMcpEntries,
    rebuildShieldsWindow,
    relockShieldsIfNeeded,
    onCreated,
    log,
    bail,
  } = input;

  console.log("");
  console.log("  Creating new sandbox with current image...");

  const rebuildGpuOverrides = getRebuildSandboxGpuOverrides(sb);
  log(
    `Session before update: sandboxName=${sessionBefore?.sandboxName}, status=${sessionBefore?.status}, resumable=${sessionBefore?.resumable}, provider=${sessionBefore?.provider}, model=${sessionBefore?.model}, sessionMatch=${sessionMatchesSandbox}`,
  );

  onboardSession.updateSession((s: Session) => {
    Object.assign(
      s,
      onboardSession.createSession({
        mode: "non-interactive",
        hermesAuthMethod: rebuildDurableConfig.hermesAuthMethod,
        webSearchConfig: rebuildDurableConfig.webSearchConfig,
        toolDisclosure: rebuildDurableConfig.toolDisclosure,
        observabilityEnabled: recreateOptions.observabilityEnabled,
        observabilityRequestedExplicitly: recreateOptions.observabilityRequestedExplicitly,
        telegramConfig: sessionMatchesSandbox ? sessionBefore?.telegramConfig : null,
        wechatConfig: sessionMatchesSandbox ? sessionBefore?.wechatConfig : null,
        migratedLegacyValueHashes: sessionMatchesSandbox
          ? sessionBefore?.migratedLegacyValueHashes
          : null,
        routerPid: resumeConfig.provider === "nvidia-router" ? sessionBefore?.routerPid : undefined,
        routerCredentialHash:
          resumeConfig.provider === "nvidia-router" ? sessionBefore?.routerCredentialHash : null,
        metadata: {
          gatewayName: recreateOptions.targetGatewayName,
          fromDockerfile: storedFromDockerfile,
        },
      }),
    );
    s.steps.preflight.status = "complete";
    s.steps.preflight.startedAt = null;
    s.steps.preflight.completedAt = s.updatedAt;
    s.steps.preflight.error = null;
    s.steps.gateway.status = "complete";
    s.steps.gateway.startedAt = null;
    s.steps.gateway.completedAt = s.updatedAt;
    s.steps.gateway.error = null;
    s.sandboxName = sandboxName;
    s.resumable = true;
    s.status = "in_progress";
    s.agent = rebuildAgent;
    s.messagingPlan = rebuildMessagingPlan;
    s.hermesToolGateways = rebuildsHermesSandbox ? rebuildHermesToolGateways : [];
    s.policyPresets = rebuildSessionPolicyPresets;
    s.gpuPassthrough = rebuildGpuOverrides.sessionGpuPassthrough;
    s.metadata.fromDockerfile = storedFromDockerfile;
    s.provider = resumeConfig.provider;
    s.model = resumeConfig.model;
    s.nimContainer = resumeConfig.nimContainer;
    s.credentialEnv = rebuildCredentialEnv;
    s.preferredInferenceApi = resumeConfig.preferredInferenceApi;
    s.compatibleEndpointReasoning = resumeConfig.compatibleEndpointReasoning;
    s.endpointUrl = resumeConfig.endpointUrl;
    s.toolDisclosure = rebuildDurableConfig.toolDisclosure;
    s.observabilityEnabled = recreateOptions.observabilityEnabled;
    s.observabilityRequestedExplicitly = recreateOptions.observabilityRequestedExplicitly;
    return s;
  });
  const sessionAfter = onboardSession.loadSession();
  log(
    `Session after update: sandboxName=${sessionAfter?.sandboxName}, status=${sessionAfter?.status}, resumable=${sessionAfter?.resumable}, provider=${sessionAfter?.provider}, model=${sessionAfter?.model}`,
  );
  log(
    `Recreate env will target NEMOCLAW_SANDBOX_NAME=${sandboxName}; NEMOCLAW_RECREATE_SANDBOX=${process.env.NEMOCLAW_RECREATE_SANDBOX}`,
  );
  log(
    `Calling onboard({ resume: true, nonInteractive: true, recreateSandbox: true, fromDockerfile: ${storedFromDockerfile} })`,
  );

  // Intercept process.exit so a failed inner onboard can preserve the backup
  // and durable retry state instead of terminating the outer transaction.
  let onboardFailed = false;
  let onboardExitCode = 1;
  const savedExit = process.exit;
  process.exit = ((code) => {
    onboardFailed = true;
    onboardExitCode = typeof code === "number" ? code : 1;
    const error = new Error(`onboard exited with code ${onboardExitCode}`);
    error.name = "RebuildOnboardExit";
    throw error;
  }) as typeof process.exit;

  const restoreAmbientRecreateEnv = isolateAmbientRecreateEnv();
  const previousSandboxName = process.env.NEMOCLAW_SANDBOX_NAME;
  process.env.NEMOCLAW_SANDBOX_NAME = sandboxName;
  if (recreateOptions.policyTier) {
    process.env.NEMOCLAW_POLICY_TIER = recreateOptions.policyTier;
  }
  const restoreRebuildBaseImageOverride =
    pinRebuildAgentBaseImageForRecreate(rebuildBaseImagePreflight);
  try {
    await rebuildOnboardDependencies.onboard(recreateOptions);
    log("onboard() returned successfully");
  } catch (error) {
    onboardFailed = true;
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : "";
    if (name !== "RebuildOnboardExit") log(`onboard() threw: ${message}`);
  } finally {
    process.exit = savedExit;
    restoreRebuildBaseImageOverride();
    restoreAmbientRecreateEnv();
    if (previousSandboxName === undefined) delete process.env.NEMOCLAW_SANDBOX_NAME;
    else process.env.NEMOCLAW_SANDBOX_NAME = previousSandboxName;
  }

  if (!onboardFailed) onCreated();
  if (onboardFailed) {
    try {
      markLastStartedStepFailed(onboardSession, "Rebuild recreate failed");
    } catch {
      /* best effort */
    }

    registryRollback.restoreForRetry();
    restoreMcpRegistryForRebuildRetry(recoveryRecreate, rebuildMcpEntries, sb, log);

    console.error("");
    if (recoveryRecreate) {
      console.error(`  ${_RD}Recovery recreate failed.${R}`);
      console.error(
        "  Your local registry entry has been preserved — you can retry once the issue above is fixed.",
      );
    } else {
      console.error(`  ${_RD}Recreate failed after sandbox was destroyed.${R}`);
    }
    if (backupManifest) console.error(`  Backup is preserved at: ${backupManifest.backupPath}`);
    console.error("");
    console.error("  To recover manually:");
    console.error("    1. Fix the issue above (missing credential, Docker problem, etc.)");
    printMcpRebuildRetryCommand(
      sandboxName,
      rebuildMcpEntries,
      rebuildDurableConfig.toolDisclosure,
      {
        enabled: recreateOptions.observabilityEnabled,
        requestedExplicitly: recreateOptions.observabilityRequestedExplicitly,
      },
      {
        mode: recreateOptions.dcodeAutoApprovalMode,
        requestedExplicitly: recreateOptions.dcodeAutoApprovalRequestedExplicitly,
      },
    );
    if (backupManifest) {
      console.error("    3. Then restore your workspace state:");
      console.error(
        `       ${CLI_NAME} ${sandboxName} snapshot restore "${backupManifest.timestamp}"`,
      );
    }
    printRebuildShieldsRecovery(sandboxName, rebuildShieldsWindow, CLI_NAME);
    console.error("");
    relockShieldsIfNeeded(false);
    bail(
      backupManifest
        ? `Recreate failed (sandbox destroyed). Backup: ${backupManifest.backupPath}`
        : "Recreate failed (stale-sandbox recovery).",
      onboardExitCode,
    );
    return false;
  }

  if (recoveryRecreate) shields.clearShieldsState(sandboxName);
  const preservedRegistryFields = {
    ...(hasRebuildHermesToolGateways ? { hermesToolGateways: [...rebuildHermesToolGateways] } : {}),
  };
  if (Object.keys(preservedRegistryFields).length > 0) {
    registry.updateSandbox(sandboxName, preservedRegistryFields);
  }
  return true;
}
