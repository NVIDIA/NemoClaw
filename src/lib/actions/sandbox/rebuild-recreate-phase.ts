// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";
import { RD as _RD, R } from "../../cli/terminal-style";
import { normalizeProcessExitCode } from "../../core/process-exit";
import { MessagingSetupApplier, type SandboxMessagingPlan } from "../../messaging";
import { markLastStartedStepFailed } from "../../onboard/exit-step-failure";
import { gatewayOwnerFromCheckpoint } from "../../onboard/gateway-authority-checkpoint";
import { sameGatewayOwner } from "../../onboard/gateway-ownership";
import { applyReasoningEffortEnv } from "../../onboard/reasoning-mode";
import { isOnboardDeferredExitError } from "../../onboard/session-bootstrap";
import * as shields from "../../shields";
import { decisionSelected, isDecisionSelected } from "../../state/onboard-checkpoint-decision";
import { deriveCheckpointFromSession } from "../../state/onboard-checkpoint-migrate";
import type { Session } from "../../state/onboard-session";
import * as onboardSession from "../../state/onboard-session";
import * as registry from "../../state/registry";
import { cloneSandboxHostMounts } from "../../state/registry/host-mount";
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
import type { RebuildRecreateJournal } from "./rebuild-recreate-journal";
import type { RebuildRegistryRollback } from "./rebuild-registry-rollback";
import type { RebuildResumeConfig } from "./rebuild-resume-config";
import type { RebuildShieldsWindow } from "./rebuild-shields";

export interface RebuildRecreatePhaseInput {
  sandboxName: string;
  sandboxEntry: RebuildSandboxEntry;
  sessionSnapshot: Session | null;
  sessionMatchesSandbox: boolean;
  durableConfig: RebuildDurableConfig;
  resumeConfig: RebuildResumeConfig;
  recreateOptions: RebuildRecreateOnboardOpts;
  recreateJournal: RebuildRecreateJournal;
  fromDockerfile: string | null;
  rebuildAgent: string | null;
  messagingPlan: SandboxMessagingPlan | null;
  rebuildsHermesSandbox: boolean;
  hermesToolGateways: string[];
  hasHermesToolGateways: boolean;
  policySourcePath?: string;
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

/** Prefer the actionable nested failure over the recovery wrapper around it. */
export function describeRebuildOnboardFailure(error: unknown): string {
  if (error instanceof AggregateError) {
    const nested = error.errors.find((entry) => entry instanceof Error);
    if (nested) return describeRebuildOnboardFailure(nested);
  }
  if (error instanceof Error) return error.message;
  return String(error);
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
    recreateJournal,
    fromDockerfile: storedFromDockerfile,
    rebuildAgent,
    messagingPlan: rebuildMessagingPlan,
    rebuildsHermesSandbox,
    hermesToolGateways: rebuildHermesToolGateways,
    hasHermesToolGateways: hasRebuildHermesToolGateways,
    policySourcePath: rebuildPolicySourcePath,
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
  if (!rebuildPolicySourcePath) {
    return input.bail("Rebuild has no captured OpenShell policy source.");
  }
  console.log("");
  console.log("  Creating new sandbox with current image...");

  const rebuildGpuOverrides = getRebuildSandboxGpuOverrides(sb);
  log(
    `Session before update: sandboxName=${sessionBefore?.sandboxName}, status=${sessionBefore?.status}, resumable=${sessionBefore?.resumable}, provider=${sessionBefore?.provider}, model=${sessionBefore?.model}, sessionMatch=${sessionMatchesSandbox}`,
  );

  const rebuildGatewayAuthority = recreateJournal.gatewayAuthority;
  if (
    rebuildGatewayAuthority.gatewayName !== recreateOptions.targetGatewayName ||
    rebuildGatewayAuthority.gatewayPort !== recreateOptions.targetGatewayPort
  ) {
    return bail("Authoritative rebuild journal authority does not match the target gateway.");
  }
  const journaledCheckpoint = onboardSession.loadSession()?.checkpoint ?? null;
  if (!journaledCheckpoint) {
    return bail("Authoritative rebuild journal does not identify the target sandbox.");
  }
  const journaledSandboxIdentity = journaledCheckpoint.sandboxIdentity;
  if (!isDecisionSelected(journaledSandboxIdentity)) {
    return bail("Authoritative rebuild journal does not identify the target sandbox.");
  }
  const journaledRecreate = journaledCheckpoint.sandboxRecreate;
  if (
    journaledSandboxIdentity.value.name !== sandboxName ||
    !journaledRecreate ||
    journaledRecreate.id !== recreateJournal.id ||
    journaledRecreate.sandboxName !== sandboxName ||
    journaledRecreate.gatewayName !== recreateOptions.targetGatewayName ||
    journaledRecreate.gatewayPort !== recreateOptions.targetGatewayPort ||
    journaledRecreate.targetGeneration !== recreateJournal.targetGeneration ||
    journaledRecreate.targetIntentFingerprint !== recreateJournal.targetIntentFingerprint
  ) {
    return bail("Authoritative rebuild journal does not match the target replacement.");
  }
  const journaledGatewayAuthority = journaledCheckpoint.gatewayAuthority;
  if (
    !isDecisionSelected(journaledGatewayAuthority) ||
    !sameGatewayOwner(
      gatewayOwnerFromCheckpoint(journaledGatewayAuthority.value),
      gatewayOwnerFromCheckpoint(rebuildGatewayAuthority),
    )
  ) {
    return bail("Authoritative rebuild journal authority changed before sandbox recreation.");
  }

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
        // The inner resume compares its requested host mounts against this
        // recorded metadata, so the reset must carry the same mounts the
        // recreate options hand to onboard. Omitting them recorded an empty
        // mount set and aborted the resume after the old sandbox was already
        // deleted (#9451).
        metadata: {
          gatewayName: recreateOptions.targetGatewayName,
          fromDockerfile: storedFromDockerfile,
          ...(recreateOptions.hostMounts && recreateOptions.hostMounts.length > 0
            ? { hostMounts: cloneSandboxHostMounts(recreateOptions.hostMounts) }
            : {}),
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
    s.gpuPassthrough = rebuildGpuOverrides.sessionGpuPassthrough;
    s.metadata.fromDockerfile = storedFromDockerfile;
    s.provider = resumeConfig.provider;
    s.model = resumeConfig.model;
    s.nimContainer = resumeConfig.nimContainer;
    s.credentialEnv = rebuildCredentialEnv;
    s.preferredInferenceApi = resumeConfig.preferredInferenceApi;
    s.compatibleEndpointReasoning = resumeConfig.compatibleEndpointReasoning;
    s.compatibleEndpointReasoningEffort = resumeConfig.compatibleEndpointReasoningEffort;
    s.endpointUrl = resumeConfig.endpointUrl;
    s.toolDisclosure = rebuildDurableConfig.toolDisclosure;
    s.observabilityEnabled = recreateOptions.observabilityEnabled;
    s.observabilityRequestedExplicitly = recreateOptions.observabilityRequestedExplicitly;
    // The journal outlives this reset, but the retired session owns its effect
    // receipts and bindings. Rebind only the values the journal invariant needs.
    s.checkpoint = {
      ...deriveCheckpointFromSession(s),
      sandboxIdentity: journaledSandboxIdentity,
      gatewayAuthority: decisionSelected(rebuildGatewayAuthority),
      sandboxRecreate: journaledRecreate,
    };
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

  let onboardFailed = false;
  let onboardExitCode = 1;
  const restoreAmbientRecreateEnv = isolateAmbientRecreateEnv();
  const previousSandboxName = process.env.NEMOCLAW_SANDBOX_NAME;
  const previousRecreateWithoutBackup = process.env.NEMOCLAW_RECREATE_WITHOUT_BACKUP;
  process.env.NEMOCLAW_SANDBOX_NAME = sandboxName;
  // The outer rebuild already made its sole backup before the destroy phase deleted
  // the sandbox without tearing down the gateway/session needed by onboard --resume.
  // That retained state can send inner onboard through generic recreate protection,
  // where a second backup is impossible after deletion. Keep the bypass scoped to
  // this call; remove it when onboard accepts an explicit outer-backup handoff.
  process.env.NEMOCLAW_RECREATE_WITHOUT_BACKUP = "1";
  if (rebuildMessagingPlan) MessagingSetupApplier.writePlanToEnv(rebuildMessagingPlan);
  // Isolation removed the ambient reasoning inputs so an unrelated onboard
  // cannot steer this recreate (#5735). The recreate still has to reapply the
  // *recorded* compatible-endpoint reasoning configuration: both the recovered
  // provider selection and the sandbox image patch that bakes
  // ARG NEMOCLAW_REASONING_EFFORT read it from the process env, so without this
  // seed the replacement records no reasoning effort (#7940). The isolation
  // restore puts the caller's ambient values back on success and failure.
  if (resumeConfig.provider === "compatible-endpoint") {
    process.env.NEMOCLAW_REASONING = resumeConfig.compatibleEndpointReasoning ?? "false";
    applyReasoningEffortEnv(resumeConfig.compatibleEndpointReasoningEffort);
  }
  const restoreRebuildBaseImageOverride =
    pinRebuildAgentBaseImageForRecreate(rebuildBaseImagePreflight);
  const savedExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await rebuildOnboardDependencies.onboard({
      ...recreateOptions,
      rebuildGatewayAuthority,
      rebuildPolicySourcePath,
      ...(rebuildsHermesSandbox && backupManifest?.preservedEnv
        ? { rebuildPreservedEnv: backupManifest.preservedEnv }
        : {}),
      recreateJournalTargetIntentFingerprint: recreateJournal.targetIntentFingerprint,
    });
    const returnedExitCode = normalizeProcessExitCode(process.exitCode);
    if (returnedExitCode !== 0) {
      onboardFailed = true;
      onboardExitCode = returnedExitCode;
      log(`onboard() returned with exit code ${returnedExitCode}`);
      console.error(
        `  ${_RD}Sandbox recreate error:${R} Inner onboarding completed with exit code ${returnedExitCode}.`,
      );
    } else {
      log("onboard() returned successfully");
    }
  } catch (error) {
    onboardFailed = true;
    const message = describeRebuildOnboardFailure(error);
    if (isOnboardDeferredExitError(error)) {
      onboardExitCode = error.code;
      log(`onboard() exited with code ${onboardExitCode}`);
      console.error(
        `  ${_RD}Sandbox recreate error:${R} Inner onboarding exited with code ${onboardExitCode}.`,
      );
    } else {
      log(`onboard() threw: ${message}`);
      console.error(
        `  ${_RD}Sandbox recreate error:${R} ${onboardSession.redactSensitiveText(message) ?? "Inner onboarding failed."}`,
      );
    }
  } finally {
    process.exitCode = savedExitCode;
    restoreRebuildBaseImageOverride();
    restoreAmbientRecreateEnv();
    if (previousSandboxName === undefined) delete process.env.NEMOCLAW_SANDBOX_NAME;
    else process.env.NEMOCLAW_SANDBOX_NAME = previousSandboxName;
    if (previousRecreateWithoutBackup === undefined) {
      delete process.env.NEMOCLAW_RECREATE_WITHOUT_BACKUP;
    } else {
      process.env.NEMOCLAW_RECREATE_WITHOUT_BACKUP = previousRecreateWithoutBackup;
    }
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
    if (rebuildShieldsWindow.wasLocked) {
      console.error(`    ${backupManifest ? 4 : 3}. Restore shields lockdown:`);
      console.error(`       ${CLI_NAME} ${sandboxName} shields up`);
    }
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
