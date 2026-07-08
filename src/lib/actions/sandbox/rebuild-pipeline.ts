// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RebuildSandboxOptions } from "../../domain/lifecycle/options";
import { BRAVE_API_KEY_ENV, TAVILY_API_KEY_ENV } from "../../inference/web-search";
import { MESSAGING_SETUP_APPLIER_ENV_KEY } from "../../messaging/applier/types";
import { MESSAGING_CHANNEL_CONFIG_ENV_KEYS } from "../../messaging-channel-config";
import { hydrateCredentialEnv } from "../../onboard/credential-env";
import { DOCKER_GPU_PATCH_NETWORK_ENV } from "../../onboard/docker-gpu-patch";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock";
import * as onboardSession from "../../state/onboard-session";
import { RebuildTransactionStore } from "../../state/rebuild-transaction";
import * as registry from "../../state/registry";
import { normalizeRebuildTargetPolicyPresets, runRebuildBackupPhase } from "./rebuild-backup-phase";
import { buildRefreshMutableOpenClawConfigHashCommand } from "./rebuild-config-hash";
import { DCODE_AGENT_NAME } from "./rebuild-dcode-target";
import { runRebuildDestroyPhase } from "./rebuild-destroy-phase";
import { REBUILD_HERMES_DASHBOARD_ENV_KEYS } from "./rebuild-durable-config";
import { maybePauseForRebuildInterruption } from "./rebuild-e2e-interruption";
import { stageMessagingManifestPlanForRebuild } from "./rebuild-messaging-phase";
import { runRebuildPostRestorePhase } from "./rebuild-post-restore-phase";
import { printRebuildPreflightFailure } from "./rebuild-preflight-error";
import { runRebuildPreflightPhase } from "./rebuild-preflight-phase";
import {
  disposePreparedBuildContext,
  verifyPreparedBuildContext,
} from "./rebuild-prepared-image-context";
import {
  type RebuildSandboxExecutionOptions,
  revalidatePreparedRecoveryBeforeDelete,
} from "./rebuild-prepared-recovery";
import { inspectRebuildGatewayProviderRegistration } from "./rebuild-provider-preflight";
import { runRebuildRecreatePhase } from "./rebuild-recreate-phase";
import { runRebuildRestorePhase } from "./rebuild-restore-phase";
import { runRebuildShieldsPhase } from "./rebuild-shields-phase";
import { RebuildTransactionCoordinator } from "./rebuild-transaction-coordinator";

export { buildRefreshMutableOpenClawConfigHashCommand, stageMessagingManifestPlanForRebuild };

/**
 * Rebuild a live sandbox while preserving registered agent state and policies.
 *
 * The facade scopes mutable process environment and serializes the typed phase
 * pipeline with the MCP lifecycle lock.
 */
export async function rebuildSandbox(
  sandboxName: string,
  options: string[] | RebuildSandboxOptions = {},
  opts: RebuildSandboxExecutionOptions = {},
): Promise<void> {
  return withMcpLifecycleLock(sandboxName, async () => {
    const scopedEnvKeys = [
      BRAVE_API_KEY_ENV,
      TAVILY_API_KEY_ENV,
      MESSAGING_SETUP_APPLIER_ENV_KEY,
      "OPENSHELL_GATEWAY",
      DOCKER_GPU_PATCH_NETWORK_ENV,
      ...REBUILD_HERMES_DASHBOARD_ENV_KEYS,
      ...MESSAGING_CHANNEL_CONFIG_ENV_KEYS,
    ];
    const savedEnv = scopedEnvKeys.map((key) => [key, process.env[key]] as const);
    try {
      await rebuildSandboxUnlocked(sandboxName, options, opts);
    } finally {
      for (const key of scopedEnvKeys) delete process.env[key];
      Object.assign(
        process.env,
        Object.fromEntries(
          savedEnv.filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
      );
    }
  });
}

async function rebuildSandboxUnlocked(
  sandboxName: string,
  options: string[] | RebuildSandboxOptions,
  opts: RebuildSandboxExecutionOptions,
): Promise<void> {
  const transactionStore = opts.transactionStore ?? new RebuildTransactionStore();
  const preflight = await runRebuildPreflightPhase(sandboxName, options, {
    ...opts,
    transactionStore,
  });
  if (!preflight) return;
  const {
    transaction: recoveredTransaction,
    sandboxEntry,
    rebuildAgent,
    versionCheck,
    targetConfig,
    recreateOptions,
    messagingPlan,
    baseImagePreflight,
    liveState,
    recoveryManifest: validatedRecoveryManifest,
    allowLegacyManagedImageRecovery,
    dcodePreflight,
    preparedImage,
    releaseOnboardLock,
    log,
    bail,
  } = preflight;
  const transaction = new RebuildTransactionCoordinator(
    transactionStore,
    sandboxName,
    recoveredTransaction,
  );
  const {
    resumeConfig,
    sessionSnapshot,
    sessionMatchesSandbox,
    durableConfig,
    hermesToolGateways,
    hasHermesToolGateways,
    credentialEnv,
    fromDockerfile,
  } = targetConfig;
  const { staleRecovery } = liveState;
  const preservedCustomPolicies = (sandboxEntry.customPolicies ?? []).map((entry) => ({
    ...entry,
  }));
  let recoveryManifest = validatedRecoveryManifest;
  const preparedBackupRecovery = recoveryManifest !== null;
  const recoveryRecreate = staleRecovery || preparedBackupRecovery;
  try {
    const shieldsPhase = runRebuildShieldsPhase(
      sandboxName,
      recoveryRecreate,
      releaseOnboardLock,
      bail,
    );
    if (!shieldsPhase) return;
    const {
      window: rebuildShieldsWindow,
      staleSandboxWasLocked,
      relock: relockShieldsIfNeeded,
    } = shieldsPhase;
    const originalShieldsLocked =
      recoveredTransaction?.status === "active"
        ? recoveredTransaction.intent.source.shieldsLocked
        : staleSandboxWasLocked || rebuildShieldsWindow.wasLocked;
    let sandboxStillExists = true;

    try {
      recoveryManifest = revalidatePreparedRecoveryBeforeDelete(
        sandboxName,
        sandboxEntry,
        recoveryManifest,
        allowLegacyManagedImageRecovery,
        bail,
      );

      const backup = runRebuildBackupPhase({
        sandboxName,
        // Apply replacement observability only to target policy normalization;
        // replacement registration commits it to the registry later.
        sandboxEntry: {
          ...sandboxEntry,
          observabilityEnabled: recreateOptions.observabilityEnabled,
        },
        staleRecovery,
        preparedRecoveryManifest: recoveryManifest,
        messagingPlan,
        webSearchConfig: durableConfig.webSearchConfig,
        log,
        bail,
        relockShieldsIfNeeded,
      });
      if (!backup) return;

      // Revalidate the retained image context at the last safe point before
      // the destructive boundary.
      if (preparedImage && !verifyPreparedBuildContext(preparedImage)) {
        printRebuildPreflightFailure(
          "the retained replacement image context changed after preflight.",
          "Retry the rebuild so the replacement inputs can be staged again.",
          "Replacement sandbox image context changed before delete",
          bail,
        );
        return;
      }

      // Revalidate DCode's replacement and inference route before MCP scrub,
      // provider detach, NIM stop, or sandbox deletion.
      if (
        !(await dcodePreflight.revalidateBeforeDelete(
          resumeConfig,
          durableConfig.toolDisclosure,
          recoveryRecreate,
          recreateOptions.targetGatewayPort,
        ))
      ) {
        return;
      }

      // Journal creation follows the immutable backup: failure can orphan a
      // backup, but cannot create a transaction without recovery data.
      await transaction.prepare({
        sandboxEntry,
        targetConfig,
        recreateOptions,
        backupManifest: backup.backupManifest,
        imageIdentity: {
          baseImage: baseImagePreflight.imageRef,
          fromDockerfile,
          recordedImage: sandboxEntry.imageTag ?? null,
          nemoclawVersion: sandboxEntry.nemoclawVersion ?? null,
        },
        legacyManagedImageRecoveryAuthorized: allowLegacyManagedImageRecovery,
        shieldsLocked: originalShieldsLocked,
        oldSandboxPresent: !staleRecovery,
      });
      await transaction.reconcileObservedDeletion(staleRecovery);
      if (transaction.phase === "prepared") maybePauseForRebuildInterruption("prepared");

      const mcpPreparation = await runRebuildDestroyPhase({
        sandboxName,
        sandboxEntry,
        staleRecovery,
        backupManifest: backup.backupManifest,
        log,
        bail,
        relockShieldsIfNeeded,
        validateAfterMcpPreparation: async () => {
          const providerReconfigure = recreateOptions.rebuildProviderReconfigure;
          if (providerReconfigure && !hydrateCredentialEnv(providerReconfigure.credentialEnv)) {
            return {
              ok: false,
              message: `Provider credential ${providerReconfigure.credentialEnv} became unavailable before sandbox deletion.`,
            };
          }
          const providerRegistration = providerReconfigure
            ? inspectRebuildGatewayProviderRegistration(
                providerReconfigure.provider,
                log,
                "Delete-edge",
              )
            : "missing";
          if (providerReconfigure && providerRegistration !== "missing") {
            return {
              ok: false,
              message:
                providerRegistration === "registered"
                  ? `Gateway provider '${providerReconfigure.provider}' changed during rebuild preflight. Retry the rebuild.`
                  : `Gateway provider '${providerReconfigure.provider}' could not be verified before sandbox deletion.`,
            };
          }
          return dcodePreflight.checkAtDeleteEdge(
            resumeConfig,
            durableConfig.toolDisclosure,
            recoveryRecreate,
            recreateOptions.targetGatewayPort,
          );
        },
        oldSandboxAlreadyDeleted: transaction.phase === "old_deleted",
        onDeleted: async () => {
          sandboxStillExists = false;
          await transaction.markDeleted();
        },
      });
      if (!mcpPreparation) return;

      const restoreDcodeGpuPatchNetwork = dcodePreflight.applyDockerGpuPatchNetwork();
      let recreated: boolean;
      try {
        recreated = await runRebuildRecreatePhase({
          sandboxName,
          sandboxEntry,
          sessionSnapshot,
          sessionMatchesSandbox,
          durableConfig,
          resumeConfig,
          recreateOptions,
          fromDockerfile,
          rebuildAgent,
          messagingPlan,
          rebuildsHermesSandbox: rebuildAgent === "hermes",
          hermesToolGateways,
          hasHermesToolGateways,
          sessionPolicyPresets: backup.sessionPolicyPresets,
          credentialEnv,
          baseImagePreflight,
          recoveryRecreate,
          backupManifest: backup.backupManifest,
          mcpEntries: mcpPreparation.entries,
          rebuildShieldsWindow,
          relockShieldsIfNeeded,
          onCreated: async () => {
            sandboxStillExists = true;
            await transaction.markReplacementCreated(registry.getSandbox(sandboxName));
          },
          onFailed: async () => {
            await transaction.recordReplacementFailure();
          },
          log,
          bail,
        });
      } finally {
        restoreDcodeGpuPatchNetwork();
      }
      if (!recreated) return;

      const completedInnerSession = onboardSession.loadSession();
      const freshInnerOnboardPolicyPresets =
        completedInnerSession?.sandboxName === sandboxName &&
        Array.isArray(completedInnerSession.policyPresets)
          ? completedInnerSession.policyPresets
          : [];
      const targetPolicyPresets = normalizeRebuildTargetPolicyPresets(
        [...backup.policyPresets, ...freshInnerOnboardPolicyPresets],
        {
          ...sandboxEntry,
          observabilityEnabled: recreateOptions.observabilityEnabled,
        },
        durableConfig.webSearchConfig,
      );

      const restored = runRebuildRestorePhase({
        sandboxName,
        backupManifest: backup.backupManifest,
        policyPresets: targetPolicyPresets,
        customPolicies:
          backup.backupManifest?.customPolicies?.map((entry) => ({ ...entry })) ??
          preservedCustomPolicies,
        reconcileManagedDcodeObservability: rebuildAgent === DCODE_AGENT_NAME,
        log,
      });
      await runRebuildPostRestorePhase({
        sandboxName,
        sandboxEntry,
        messagingPlan,
        backupManifest: backup.backupManifest,
        mcpEntries: mcpPreparation.entries,
        restoreSucceeded: restored.restoreSucceeded,
        failedPresets: restored.failedPresets,
        finalBuiltinPresets: restored.finalBuiltinPresets,
        failedPresetRemovals: restored.failedPresetRemovals,
        policyPresetReconciliationVerified: restored.policyPresetReconciliationVerified,
        staleRecovery,
        recoveryRecreate,
        preparedBackupRecovery,
        staleSandboxWasLocked: originalShieldsLocked,
        versionCheck,
        relockShieldsIfNeeded,
        log,
        bail,
      });
      await transaction.complete();
    } finally {
      if (!rebuildShieldsWindow.relocked) relockShieldsIfNeeded(sandboxStillExists);
    }
  } finally {
    dcodePreflight.cleanup();
    if (preparedImage && !disposePreparedBuildContext(preparedImage)) {
      console.warn("  Warning: temporary rebuild image inputs could not be fully removed.");
    }
    process.removeListener("exit", releaseOnboardLock);
    releaseOnboardLock();
  }
}
