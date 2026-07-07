// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RebuildSandboxOptions } from "../../domain/lifecycle/options";
import type { SandboxMessagingPlan } from "../../messaging";
import { hydrateCredentialEnv } from "../../onboard/credential-env";
import type { RebuildManifest } from "../../state/sandbox";
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
import {
  acquireRebuildOnboardLock,
  assertRebuildEntryUnchanged,
  checkRebuildGatewaySchemaPreflight,
  getRebuildSandboxEntryOrBail,
  isSingleAgentRebuildSupported,
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
  const { log, bail, requestedToolDisclosure, skipConfirm } = createRebuildCommandContext(
    options,
    opts,
  );
  const activeSessionCount = countActiveSandboxSessionsForRebuild(sandboxName);
  const sandboxEntry = getRebuildSandboxEntryOrBail(sandboxName, bail);
  if (!sandboxEntry) return null;
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
  const agentName = getRebuildAgentDisplayName(sandboxName);
  const dcodePreflight = createDcodeRebuildOrchestrator({
    sandboxName,
    entry: sandboxEntry,
    rebuildAgent,
    log,
    bail,
    deps: {
      checkGatewaySchema: (name, scopedBail) =>
        checkRebuildGatewaySchemaPreflight(name, sandboxEntry, scopedBail),
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
    if (
      !isDcodeRebuildAgent(rebuildAgent) &&
      !checkRebuildGatewaySchemaPreflight(sandboxName, sandboxEntry, bail)
    ) {
      return null;
    }
    const versionCheck = await confirmRebuildIntent(
      sandboxName,
      agentName,
      skipConfirm,
      activeSessionCount,
      bail,
    );
    if (!versionCheck) return null;

    const releaseOnboardLock = acquireRebuildOnboardLock(sandboxName, bail);
    let retainOnboardLock = false;
    try {
      assertRebuildEntryUnchanged(sandboxName, confirmedEntrySnapshot, bail);
      const preparedTarget = await prepareRebuildTargetPreflights({
        sandboxName,
        sandboxEntry,
        rebuildAgent,
        // Reaching this point means either --yes was supplied or confirmation
        // succeeded, matching the previous `skipConfirm || confirmed` contract.
        autoYes: true,
        requestedToolDisclosure,
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

      const liveState = await resolveRebuildLiveState(sandboxName, sandboxEntry, log, bail);
      if (!liveState) return null;
      if (isDcodeRebuildAgent(rebuildAgent)) {
        const recoveryRecreate = liveState.staleRecovery || recoveryManifest !== null;
        const imageReady = await dcodePreflight.prepareImage(
          preparedTarget.targetConfig.resumeConfig,
          preparedTarget.targetConfig.durableConfig.webSearchConfig,
          preparedTarget.targetConfig.durableConfig.toolDisclosure,
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
        sandboxEntry,
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
