// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RebuildSandboxOptions } from "../../domain/lifecycle/options";
import { BRAVE_API_KEY_ENV } from "../../inference/web-search";
import { MESSAGING_SETUP_APPLIER_ENV_KEY } from "../../messaging/applier/types";
import { MESSAGING_CHANNEL_CONFIG_ENV_KEYS } from "../../messaging-channel-config";
import { DOCKER_GPU_PATCH_NETWORK_ENV } from "../../onboard/docker-gpu-patch";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock";
import { runRebuildBackupPhase } from "./rebuild-backup-phase";
import { buildRefreshMutableOpenClawConfigHashCommand } from "./rebuild-config-hash";
import { runRebuildDestroyPhase } from "./rebuild-destroy-phase";
import { REBUILD_HERMES_DASHBOARD_ENV_KEYS } from "./rebuild-durable-config";
import { stageMessagingManifestPlanForRebuild } from "./rebuild-messaging-phase";
import { runRebuildPostRestorePhase } from "./rebuild-post-restore-phase";
import { runRebuildPreflightPhase } from "./rebuild-preflight-phase";
import { runRebuildRecreatePhase } from "./rebuild-recreate-phase";
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
  opts: { throwOnError?: boolean } = {},
): Promise<void> {
  return withMcpLifecycleLock(sandboxName, async () => {
    const scopedEnvKeys = [
      BRAVE_API_KEY_ENV,
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
  opts: { throwOnError?: boolean },
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
  const { staleRecovery, staleRegistrySnapshot } = liveState;
  const shieldsPhase = runRebuildShieldsPhase(sandboxName, staleRecovery, releaseOnboardLock, bail);
  if (!shieldsPhase) return;
  const {
    window: rebuildShieldsWindow,
    staleSandboxWasLocked,
    relock: relockShieldsIfNeeded,
  } = shieldsPhase;
  let sandboxStillExists = true;

  try {
    const backup = runRebuildBackupPhase({
      sandboxName,
      sandboxEntry,
      staleRecovery,
      messagingPlan,
      log,
      bail,
      relockShieldsIfNeeded,
    });
    if (!backup) return;

    const mcpPreparation = await runRebuildDestroyPhase({
      sandboxName,
      sandboxEntry,
      staleRecovery,
      backupManifest: backup.backupManifest,
      log,
      bail,
      relockShieldsIfNeeded,
      onDeleted: () => {
        sandboxStillExists = false;
      },
    });
    if (!mcpPreparation) return;

    const recreated = await runRebuildRecreatePhase({
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
      staleRecovery,
      staleRegistrySnapshot,
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
    if (!recreated) return;

    const restored = runRebuildRestorePhase({
      sandboxName,
      backupManifest: backup.backupManifest,
      policyPresets: backup.policyPresets,
      log,
    });
    await runRebuildPostRestorePhase({
      sandboxName,
      sandboxEntry,
      messagingPlan,
      backupManifest: backup.backupManifest,
      mcpEntries: mcpPreparation.entries,
      restoreSucceeded: restored.restoreSucceeded,
      restoredPresets: restored.restoredPresets,
      failedPresets: restored.failedPresets,
      staleRecovery,
      staleSandboxWasLocked,
      versionCheck,
      relockShieldsIfNeeded,
      log,
      bail,
    });
  } finally {
    if (!rebuildShieldsWindow.relocked) relockShieldsIfNeeded(sandboxStillExists);
    process.removeListener("exit", releaseOnboardLock);
    releaseOnboardLock();
  }
}
