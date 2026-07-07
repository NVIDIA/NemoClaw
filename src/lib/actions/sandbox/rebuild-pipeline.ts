// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RebuildSandboxOptions } from "../../domain/lifecycle/options";
import { BRAVE_API_KEY_ENV, TAVILY_API_KEY_ENV } from "../../inference/web-search";
import { MESSAGING_SETUP_APPLIER_ENV_KEY } from "../../messaging/applier/types";
import { MESSAGING_CHANNEL_CONFIG_ENV_KEYS } from "../../messaging-channel-config";
import { hydrateCredentialEnv } from "../../onboard/credential-env";
import { DOCKER_GPU_PATCH_NETWORK_ENV } from "../../onboard/docker-gpu-patch";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock";
import * as registry from "../../state/registry";
import { runRebuildBackupPhase } from "./rebuild-backup-phase";
import { buildRefreshMutableOpenClawConfigHashCommand } from "./rebuild-config-hash";
import { runRebuildDestroyPhase } from "./rebuild-destroy-phase";
import { REBUILD_HERMES_DASHBOARD_ENV_KEYS } from "./rebuild-durable-config";
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
import { createRebuildRegistryRollback } from "./rebuild-registry-rollback";
import { runRebuildRestorePhase } from "./rebuild-restore-phase";
import { runRebuildShieldsPhase } from "./rebuild-shields-phase";

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
  const preflight = await runRebuildPreflightPhase(sandboxName, options, opts);
  if (!preflight) return;
  const {
    sandboxEntry,
    rebuildAgent,
    versionCheck,
    targetConfig,
    recreateOptions,
    messagingPlan,
    baseImagePreflight,
    liveState,
    recoveryManifest: validatedRecoveryManifest,
    dcodePreflight,
    preparedImage,
    releaseOnboardLock,
    log,
    bail,
  } = preflight;
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
  let recoveryRegistrySnapshot = preparedBackupRecovery
    ? JSON.parse(JSON.stringify(registry.load()))
    : liveState.staleRegistrySnapshot;
  const registryRollback = createRebuildRegistryRollback({
    sandboxName,
    preparedBackupRecovery,
    staleRecovery,
    getRecoveryRegistrySnapshot: () => recoveryRegistrySnapshot,
    log,
  });
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
    let sandboxStillExists = true;

    try {
      const preDeleteRecovery = revalidatePreparedRecoveryBeforeDelete(
        sandboxName,
        sandboxEntry,
        recoveryManifest,
        recoveryRegistrySnapshot,
        opts.allowLegacyManagedImageRecovery === true,
        bail,
      );
      recoveryManifest = preDeleteRecovery.manifest;
      recoveryRegistrySnapshot = preDeleteRecovery.registrySnapshot;

      const backup = runRebuildBackupPhase({
        sandboxName,
        sandboxEntry,
        staleRecovery,
        preparedRecoveryManifest: recoveryManifest,
        messagingPlan,
        webSearchConfig: durableConfig.webSearchConfig,
        log,
        bail,
        relockShieldsIfNeeded,
      });
      if (!backup) return;

      // The post-delete create must consume the exact context that passed the
      // image preflight. Revalidate at the last safe point so mutation of the
      // retained copy cannot cross the destructive boundary.
      if (preparedImage && !verifyPreparedBuildContext(preparedImage)) {
        printRebuildPreflightFailure(
          "the retained replacement image context changed after preflight.",
          "Retry the rebuild so the replacement inputs can be staged again.",
          "Replacement sandbox image context changed before delete",
          bail,
        );
        return;
      }

      // DCode's retained replacement and live inference route must still match at
      // the last safe point. This check intentionally precedes MCP adapter scrub,
      // provider detach, NIM stop, and sandbox deletion in the destroy phase.
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
        onDeleted: () => {
          sandboxStillExists = false;
        },
      });
      if (!mcpPreparation) return;
      registryRollback.recordRemoval(mcpPreparation.removalReceipt);

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
          registryRollback,
          backupManifest: backup.backupManifest,
          mcpEntries: mcpPreparation.entries,
          rebuildShieldsWindow,
          relockShieldsIfNeeded,
          onCreated: () => {
            sandboxStillExists = true;
          },
          log,
          bail,
        });
      } finally {
        restoreDcodeGpuPatchNetwork();
      }
      if (!recreated) return;

      const restored = runRebuildRestorePhase({
        sandboxName,
        backupManifest: backup.backupManifest,
        policyPresets: backup.policyPresets,
        customPolicies:
          backup.backupManifest?.customPolicies?.map((entry) => ({ ...entry })) ??
          preservedCustomPolicies,
        log,
      });
      await runRebuildPostRestorePhase({
        sandboxName,
        sandboxEntry,
        preservedCustomPolicies,
        messagingPlan,
        backupManifest: backup.backupManifest,
        mcpEntries: mcpPreparation.entries,
        restoreSucceeded: restored.restoreSucceeded,
        restoredPresets: restored.restoredPresets,
        failedPresets: restored.failedPresets,
        staleRecovery,
        recoveryRecreate,
        preparedBackupRecovery,
        staleSandboxWasLocked,
        versionCheck,
        relockShieldsIfNeeded,
        log,
        bail,
      });
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
