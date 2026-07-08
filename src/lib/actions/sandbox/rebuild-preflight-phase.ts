// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RebuildSandboxOptions } from "../../domain/lifecycle/options";
import type { SandboxMessagingPlan } from "../../messaging";
import { hydrateCredentialEnv } from "../../onboard/credential-env";
import { DCODE_AUTO_APPROVAL_FEATURE } from "../../onboard/dcode-auto-approval";
import { managedSandboxFeatureIssue } from "../../onboard/managed-sandbox-feature";
import type { RebuildManifest } from "../../state/sandbox";
import { assertMcpDestroyNotPending } from "./mcp-bridge-state";
import {
  preflightRebuildCredentials,
  type RebuildBail,
  type RebuildLog,
} from "./rebuild-credential-preflight";
import type { PreparedRebuildImage } from "./rebuild-custom-image-preflight";
import {
  createDcodeRebuildOrchestrator,
  type DcodeRebuildOrchestrator,
  isDcodeRebuildAgent,
} from "./rebuild-dcode-orchestrator";
import {
  type RebuildAgentBaseImagePreflight,
  type RebuildLiveState,
  type RebuildSandboxEntry,
  resolveRebuildLiveState,
} from "./rebuild-flow-helpers";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";
import {
  confirmRebuildIntent,
  countActiveSandboxSessionsForRebuild,
  createRebuildCommandContext,
  getRebuildAgentDisplayName,
  type RebuildVersionCheck,
} from "./rebuild-preflight-confirmation";
import { printRebuildPreflightFailure } from "./rebuild-preflight-error";
import {
  acquireRebuildOnboardLock,
  assertRebuildEntryUnchanged,
  checkRebuildGatewaySchemaPreflight,
  expectedRebuildEntryAfterVersionCheck,
  getRebuildSandboxEntryOrBail,
  isSingleAgentRebuildSupported,
  runRebuildGatewayIntentPreflight,
} from "./rebuild-preflight-guards";
import { prepareRebuildTargetPreflights } from "./rebuild-preflight-target-phase";
import { disposePreparedBuildContext } from "./rebuild-prepared-image-context";
import {
  type RebuildSandboxExecutionOptions,
  validatePreparedRecoveryManifest,
} from "./rebuild-prepared-recovery";
import { checkRebuildGatewayCredentialReuseOrBail } from "./rebuild-provider-preflight";
import type { RebuildTargetConfig } from "./rebuild-target-preflight";

export interface RebuildPreflightPhaseResult {
  sandboxEntry: RebuildSandboxEntry;
  rebuildAgent: string | null;
  versionCheck: RebuildVersionCheck;
  targetConfig: RebuildTargetConfig;
  recreateOptions: RebuildRecreateOnboardOpts;
  messagingPlan: SandboxMessagingPlan | null;
  baseImagePreflight: RebuildAgentBaseImagePreflight;
  liveState: RebuildLiveState;
  recoveryManifest: RebuildManifest | null;
  dcodePreflight: DcodeRebuildOrchestrator;
  preparedImage: PreparedRebuildImage | null;
  releaseOnboardLock: () => void;
  log: RebuildLog;
  bail: RebuildBail;
}

/**
 * Validate and pin the complete recreate contract while the old sandbox remains
 * intact. The returned onboard lock stays held across every destructive phase.
 * Boundary coverage: rebuild-flow-*.test.ts exercises the fail-closed
 * preflights, confirmation, stale recovery, credential/image/GPU checks, and
 * registry drift.
 */
export async function runRebuildPreflightPhase(
  sandboxName: string,
  options: string[] | RebuildSandboxOptions = {},
  opts: RebuildSandboxExecutionOptions = {},
): Promise<RebuildPreflightPhaseResult | null> {
  const {
    log,
    bail,
    requestedToolDisclosure,
    requestedDcodeAutoApprovalMode,
    requestedObservabilityEnabled,
    skipConfirm,
  } = createRebuildCommandContext(options, opts);
  const activeSessionCount = countActiveSandboxSessionsForRebuild(sandboxName);
  const sandboxEntry = getRebuildSandboxEntryOrBail(sandboxName, bail);
  if (!sandboxEntry) return null;
  // #6376: refuse a stuck MCP destroy transaction up front — before backup,
  // image prep, or the old-sandbox delete. The only MCP marker check used to
  // live inside the destroy phase, which runs AFTER the backup phase, so a
  // stuck sandbox paid destructive/backup cost before the guard fired. Moving
  // it here fails closed before any destructive work; the guard's message is
  // phase-aware (prepared -> non-destructive `mcp remove --force`; pending ->
  // finish the destroy).
  try {
    assertMcpDestroyNotPending(sandboxEntry);
  } catch (error) {
    bail(error instanceof Error ? error.message : String(error));
    return null;
  }
  const confirmedEntrySnapshot = JSON.stringify(sandboxEntry);
  const allowLegacyManagedImageRecovery =
    opts.recoveryManifest !== undefined && opts.allowLegacyManagedImageRecovery === true;
  const recoveryManifest = validatePreparedRecoveryManifest(
    sandboxName,
    sandboxEntry,
    opts.recoveryManifest,
    allowLegacyManagedImageRecovery,
    bail,
  );
  if (!isSingleAgentRebuildSupported(sandboxEntry, bail)) return null;

  const rebuildAgent = sandboxEntry.agent || null;
  const dcodeAutoApprovalIssue = managedSandboxFeatureIssue(DCODE_AUTO_APPROVAL_FEATURE, {
    agent: rebuildAgent,
    requested: requestedDcodeAutoApprovalMode,
    registryValue: sandboxEntry.dcodeAutoApprovalMode,
  });
  if (dcodeAutoApprovalIssue === "unsupported-request") {
    printRebuildPreflightFailure(
      "the DCode auto-approval override is supported only for managed LangChain Deep Agents Code sandboxes.",
      "Remove --dcode-auto-approval or select a managed Deep Agents Code sandbox.",
      "Unsupported rebuild DCode auto-approval override",
      bail,
    );
    return null;
  }
  if (dcodeAutoApprovalIssue === "recorded-state-on-unsupported-agent") {
    printRebuildPreflightFailure(
      "recorded DCode auto-approval is enabled for a sandbox whose agent does not support it.",
      "Pass --dcode-auto-approval disabled to clear the incompatible state during rebuild.",
      "Recorded DCode auto-approval state is incompatible with the sandbox agent",
      bail,
    );
    return null;
  }
  if (requestedObservabilityEnabled !== undefined && !isDcodeRebuildAgent(rebuildAgent)) {
    printRebuildPreflightFailure(
      "the observability override is supported only for managed LangChain Deep Agents Code sandboxes.",
      "Remove --observability/--no-observability or select a managed Deep Agents Code sandbox.",
      "Unsupported rebuild observability override",
      bail,
    );
    return null;
  }
  const agentName = getRebuildAgentDisplayName(sandboxName);
  const versionCheck = await runRebuildGatewayIntentPreflight({
    checkGatewaySchema: () =>
      isDcodeRebuildAgent(rebuildAgent) ||
      checkRebuildGatewaySchemaPreflight(sandboxName, sandboxEntry, bail),
    confirmIntent: () =>
      confirmRebuildIntent(
        sandboxName,
        agentName,
        skipConfirm,
        activeSessionCount,
        bail,
        requestedDcodeAutoApprovalMode,
      ),
  });
  if (!versionCheck) return null;
  const expectedSandboxEntry = expectedRebuildEntryAfterVersionCheck(
    sandboxEntry,
    confirmedEntrySnapshot,
    versionCheck,
  );
  const dcodePreflight = createDcodeRebuildOrchestrator({
    sandboxName,
    entry: expectedSandboxEntry,
    rebuildAgent,
    log,
    bail,
    deps: {
      checkGatewaySchema: (name, scopedBail) =>
        checkRebuildGatewaySchemaPreflight(name, expectedSandboxEntry, scopedBail),
      preflightCredentials: (_name, entry, scopedLog, scopedBail) =>
        preflightRebuildCredentials(entry, scopedLog, scopedBail),
      // Non-DCode rebuilds stay on the existing typed base-image preflight.
      // The orchestrator only calls this dependency when its DCode scope is disabled.
      ensureAgentBaseImage: () => true,
    },
  });
  let retainDcodePreflight = false;
  let preparedImage: PreparedRebuildImage | null = null;
  let retainPreparedImage = false;
  try {
    const releaseOnboardLock = acquireRebuildOnboardLock(sandboxName, bail);
    let retainOnboardLock = false;
    try {
      assertRebuildEntryUnchanged(sandboxName, JSON.stringify(expectedSandboxEntry), bail);
      const preparedTarget = await prepareRebuildTargetPreflights({
        sandboxName,
        sandboxEntry: expectedSandboxEntry,
        rebuildAgent,
        // Reaching this point means either --yes was supplied or confirmation
        // succeeded, matching the previous `skipConfirm || confirmed` contract.
        autoYes: true,
        requestedToolDisclosure,
        requestedDcodeAutoApprovalMode,
        requestedObservabilityEnabled,
        allowLegacyManagedImageRecovery,
        // A validated prepared backup is the only path allowed to reconstruct
        // a missing gateway provider and route during recreate. The exact
        // endpoint, credential, image, and registry checks still run before
        // deletion; ordinary rebuilds continue to require the live bindings.
        preparedBackupRecovery: recoveryManifest !== null,
        log,
        bail,
      });
      if (!preparedTarget) return null;
      preparedImage = preparedTarget.preparedImage;

      const liveState = await resolveRebuildLiveState(sandboxName, expectedSandboxEntry, log, bail);
      if (!liveState) return null;
      if (isDcodeRebuildAgent(rebuildAgent)) {
        const recoveryRecreate = liveState.staleRecovery || recoveryManifest !== null;
        const imageReady = await dcodePreflight.prepareImage(
          preparedTarget.targetConfig.resumeConfig,
          preparedTarget.targetConfig.durableConfig.webSearchConfig,
          preparedTarget.targetConfig.durableConfig.toolDisclosure,
          preparedTarget.targetConfig.durableConfig.dcodeAutoApprovalMode,
          recoveryRecreate,
          preparedTarget.recreateOptions.targetGatewayPort,
        );
        if (!imageReady || !dcodePreflight.preparedReplacement) return null;
        preparedTarget.recreateOptions.preparedDcodeRebuild = dcodePreflight.preparedReplacement;
      }
      // Keep credential-reuse validation after DCode's live-route/image proofs,
      // but before shields, backup, or any destructive rebuild work begins.
      const { resumeConfig } = preparedTarget.targetConfig;
      const hostCredentialAvailable = Boolean(
        resumeConfig.credentialEnv && hydrateCredentialEnv(resumeConfig.credentialEnv),
      );
      if (
        !checkRebuildGatewayCredentialReuseOrBail(
          sandboxName,
          resumeConfig,
          hostCredentialAvailable,
          log,
          bail,
        )
      ) {
        return null;
      }
      retainOnboardLock = true;
      retainDcodePreflight = true;
      retainPreparedImage = true;
      return {
        sandboxEntry: expectedSandboxEntry,
        rebuildAgent,
        versionCheck,
        ...preparedTarget,
        liveState,
        recoveryManifest,
        dcodePreflight,
        releaseOnboardLock,
        log,
        bail,
      };
    } finally {
      if (!retainOnboardLock) {
        process.removeListener("exit", releaseOnboardLock);
        releaseOnboardLock();
      }
    }
  } finally {
    if (!retainDcodePreflight) dcodePreflight.cleanup();
    if (!retainPreparedImage && preparedImage) disposePreparedBuildContext(preparedImage);
  }
}
