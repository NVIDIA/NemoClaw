// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RebuildSandboxOptions } from "../../domain/lifecycle/options";
import { normalizeRebuildSandboxOptions } from "../../domain/lifecycle/options";
import { BRAVE_API_KEY_ENV, TAVILY_API_KEY_ENV } from "../../inference/web-search";
import { MESSAGING_SETUP_APPLIER_ENV_KEY } from "../../messaging/applier/types";
import { MESSAGING_CHANNEL_CONFIG_ENV_KEYS } from "../../messaging-channel-config";
import { hydrateCredentialEnv } from "../../onboard/credential-env";
import { DOCKER_GPU_PATCH_NETWORK_ENV } from "../../onboard/docker-gpu-patch";
import { withPortableOnboardRetirementBoundary } from "../../onboard/portable-retirement-authority";
import { cleanupTempDir } from "../../onboard/temp-files";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock";
import * as onboardSession from "../../state/onboard-session";
import { load as loadRegistry, REGISTRY_FILE } from "../../state/registry/persistence";
import {
  captureRebuildPolicySource,
  clearRebuildPolicyHandoff,
  type RebuildBackupManifest,
  runRebuildBackupPhase,
  writeRebuildPolicyHandoff,
} from "./rebuild-backup-phase";
import { buildRefreshMutableOpenClawConfigHashCommand } from "./rebuild-config-hash";
import { runRebuildDestroyPhase } from "./rebuild-destroy-phase";
import { REBUILD_HERMES_DASHBOARD_ENV_KEYS } from "./rebuild-durable-config";
import {
  disposeRebuildAgentBaseImagePreflight,
  removeStaleRebuildDockerOrphan,
} from "./rebuild-flow-helpers";
import { stageMessagingManifestPlanForRebuild } from "./rebuild-messaging-phase";
import {
  type HermesCronRestoreIdentity,
  HermesCronRestoreIncompleteError,
  printHermesCronRestoreRecoveryCommand,
  recoverHermesCronRestore,
  runHermesCronRestoreTransaction,
  runRebuildPostRestorePhase,
} from "./rebuild-post-restore-phase";
import { printRebuildPreflightFailure } from "./rebuild-preflight-error";
import {
  assertSandboxRebuildCommandAvailable,
  revalidateManagedWorkloadRebuildBeforeDelete,
  revalidateRebuildRouteBeforeDelete,
} from "./rebuild-preflight-guards";
import {
  finalizePreparedRebuildImageMessagingPlan,
  runHermesCronRestoreBackupPreflight,
  runRebuildPreflightPhase,
} from "./rebuild-preflight-phase";
import {
  disposePreparedBuildContext,
  verifyPreparedBuildContext,
} from "./rebuild-prepared-image-context";
import {
  type RebuildSandboxExecutionOptions,
  revalidatePreparedRecoveryBeforeDelete,
} from "./rebuild-prepared-recovery";
import { inspectRebuildGatewayProviderRegistration } from "./rebuild-provider-preflight";
import {
  clearRebuildRecoveryBackup,
  findRebuildRecoveryBackup,
  fingerprintRebuildRecreateTargetIntent,
  openRebuildRecreateJournal,
  recordRebuildRecoveryBackup,
} from "./rebuild-recreate-journal";
import { runRebuildRecreatePhase } from "./rebuild-recreate-phase";
import { createRebuildRegistryRollback } from "./rebuild-registry-rollback";
import { runRebuildRestorePhase } from "./rebuild-restore-phase";
import { runRebuildShieldsPhase } from "./rebuild-shields-phase";

export { buildRefreshMutableOpenClawConfigHashCommand, stageMessagingManifestPlanForRebuild };

function runBestEffortRebuildCleanup(cleanup: () => boolean | void, warning: string): void {
  try {
    if (cleanup() === false) console.warn(warning);
  } catch {
    console.warn(warning);
  }
}

function rebuildFailureDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  const homeDir = process.env.HOME || os.homedir();
  assertSandboxRebuildCommandAvailable(sandboxName);
  return withPortableOnboardRetirementBoundary(
    {
      homeDir,
      registryFile: REGISTRY_FILE,
      sessionFile: onboardSession.SESSION_FILE,
      stateDir: path.dirname(onboardSession.SESSION_FILE),
    },
    () =>
      withMcpLifecycleLock(sandboxName, async () => {
        assertSandboxRebuildCommandAvailable(sandboxName);
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
      }),
    { loadRegistry, withLifecycleLock: withMcpLifecycleLock },
  );
}

async function rebuildSandboxUnlocked(
  sandboxName: string,
  options: string[] | RebuildSandboxOptions,
  opts: RebuildSandboxExecutionOptions,
): Promise<void> {
  let executionOptions = opts;
  if (!executionOptions.recoveryManifest) {
    const transaction = onboardSession.loadSession()?.checkpoint?.sandboxRecreate;
    const registryEntry = loadRegistry().sandboxes[sandboxName];
    if (transaction?.sandboxName === sandboxName && registryEntry) {
      const retainedRecovery = findRebuildRecoveryBackup({
        sandboxName,
        agentName: registryEntry.agent,
        transactionId: transaction.id,
      });
      if (retainedRecovery) {
        executionOptions = {
          ...executionOptions,
          recoveryManifest: retainedRecovery,
        };
      }
    }
  }
  const normalized = normalizeRebuildSandboxOptions(options);
  const preflight = await runRebuildPreflightPhase(sandboxName, options, executionOptions);
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
    preparedImage: initiallyPreparedImage,
    routePreflightReceipt,
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
  let preparedImage = initiallyPreparedImage;
  let recoveryManifest = validatedRecoveryManifest;
  let rebuildPolicySourcePath: string | null = null;
  let rebuildPolicySourceIsEphemeral = false;
  let rebuildPolicyHandoffManifest: NonNullable<RebuildBackupManifest> | null = null;
  const preparedBackupRecovery = recoveryManifest !== null;
  const recoveryRecreate = staleRecovery || preparedBackupRecovery;
  try {
    let recoveryRegistrySnapshot = preparedBackupRecovery
      ? JSON.parse(JSON.stringify(loadRegistry()))
      : liveState.staleRegistrySnapshot;
    const registryRollback = createRebuildRegistryRollback({
      sandboxName,
      preparedBackupRecovery,
      staleRecovery,
      getRecoveryRegistrySnapshot: () => recoveryRegistrySnapshot,
      log,
    });
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
    let sandboxExistenceAmbiguous = false;
    let retainPolicyHandoffForRecovery = false;

    try {
      const preDeleteRecovery = revalidatePreparedRecoveryBeforeDelete(
        sandboxName,
        sandboxEntry,
        recoveryManifest,
        recoveryRegistrySnapshot,
        executionOptions.allowLegacyManagedImageRecovery === true,
        bail,
      );
      recoveryManifest = preDeleteRecovery.manifest;
      recoveryRegistrySnapshot = preDeleteRecovery.registrySnapshot;

      const backup = runRebuildBackupPhase({
        sandboxName,
        // The requested observability bit is replacement intent, not a
        // preflight mutation of the old registry row. Use a copy only for
        // target policy normalization; replacement registration commits it.
        sandboxEntry: {
          ...sandboxEntry,
          observabilityEnabled: recreateOptions.observabilityEnabled,
        },
        staleRecovery,
        preparedRecoveryManifest: recoveryManifest,
        messagingPlan,
        webSearchConfig: durableConfig.webSearchConfig,
        force: normalized.force,
        log,
        bail,
        relockShieldsIfNeeded,
      });
      if (!backup) return;
      rebuildPolicySourcePath = backup.policySourcePath;
      rebuildPolicySourceIsEphemeral = backup.backupManifest === null;
      rebuildPolicyHandoffManifest = backup.backupManifest;
      const publishPolicyHandoff = (policyDocument: string): boolean => {
        if (!backup.backupManifest) {
          try {
            fs.writeFileSync(backup.policySourcePath, policyDocument, {
              mode: 0o600,
            });
            return true;
          } catch {
            return false;
          }
        }
        try {
          backup.backupManifest = writeRebuildPolicyHandoff(backup.backupManifest, policyDocument);
          rebuildPolicyHandoffManifest = backup.backupManifest;
          const handoff = backup.backupManifest.rebuildPolicyHandoff;
          if (!handoff) return false;
          backup.policySourcePath = path.join(backup.backupManifest.backupPath, handoff.file);
          rebuildPolicySourcePath = backup.policySourcePath;
          return true;
        } catch {
          return false;
        }
      };
      const capturePolicyHandoff = (): boolean => {
        const capturedPath = captureRebuildPolicySource(sandboxName);
        if (!capturedPath) return false;
        try {
          return publishPolicyHandoff(fs.readFileSync(capturedPath, "utf8"));
        } finally {
          cleanupTempDir(capturedPath, "nemoclaw-rebuild-policy");
        }
      };

      // Validate the completed backup artifact produced above, not the mutable live
      // tree. This gate therefore follows backup creation and precedes every
      // destructive rebuild phase.
      const hermesCronRestorePreflight = runHermesCronRestoreBackupPreflight({
        rebuildAgent,
        backupPath: backup.backupManifest?.backupPath ?? null,
        backedUpDirs: backup.backupManifest?.backedUpDirs ?? [],
        log,
        bail,
      });
      if (!hermesCronRestorePreflight) return;
      const hermesCronRestorePlan = hermesCronRestorePreflight.plan;

      const preservedEnv = backup.backupManifest?.preservedEnv ?? [];
      if (preparedImage && messagingPlan?.agent === "hermes" && preservedEnv.length > 0) {
        const finalizedImage = finalizePreparedRebuildImageMessagingPlan(
          preparedImage,
          messagingPlan,
          preservedEnv,
        );
        if (!finalizedImage.ok) {
          printRebuildPreflightFailure(
            `the retained replacement image could not include preserved Hermes messaging state: ${finalizedImage.detail}`,
            "The existing sandbox is untouched. Retry the rebuild after checking the replacement image inputs.",
            "Replacement sandbox image finalization failed",
            bail,
          );
          return;
        }
        preparedImage = finalizedImage.prepared;
        recreateOptions.preparedImageRebuild = {
          buildContext: preparedImage,
          gatewayName: recreateOptions.targetGatewayName,
        };
      }

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
          durableConfig.dcodeAutoApprovalMode,
          recoveryRecreate,
          recreateOptions.targetGatewayPort,
        ))
      ) {
        return;
      }

      const managedWorkloadMutationGuard = revalidateManagedWorkloadRebuildBeforeDelete(
        sandboxName,
        recreateOptions.managedWorkloadRebuild,
      );
      if (managedWorkloadMutationGuard) {
        bail(managedWorkloadMutationGuard.message);
        return;
      }

      const expectedGatewayAuthority = recreateOptions.rebuildGatewayAuthority;
      if (!expectedGatewayAuthority) {
        bail("Authoritative rebuild gateway readiness did not produce an authority handoff.");
        return;
      }
      const recreateJournal = openRebuildRecreateJournal({
        target: {
          sandboxName,
          gatewayName: recreateOptions.targetGatewayName,
          gatewayPort: recreateOptions.targetGatewayPort,
        },
        expectedGatewayAuthority,
        agentName: rebuildAgent || "openclaw",
        targetIntentFingerprint: fingerprintRebuildRecreateTargetIntent(recreateOptions),
        log,
        onAuthorityRefusal: (lines) => bail(lines.join("\n")),
      });
      recreateOptions.rebuildGatewayAuthority = recreateJournal.gatewayAuthority;
      const rebuildRecoveryIdentity = {
        sandboxName,
        agentName: rebuildAgent,
        transactionId: recreateJournal.id,
      };
      if (!recreateJournal.acceptedTarget && backup.backupManifest) {
        recordRebuildRecoveryBackup({
          ...rebuildRecoveryIdentity,
          backupManifest: backup.backupManifest,
        });
      }

      // An earlier run of this rebuild already registered and proved the
      // replacement. Retire its journal and stop before the destroy phase so a
      // restart converges to that sandbox instead of deleting it.
      if (recreateJournal.acceptedTarget) {
        const recoveryBackup = findRebuildRecoveryBackup(rebuildRecoveryIdentity);
        if (!recoveryBackup) {
          console.error("");
          console.error(
            "  The accepted replacement still requires state restoration, but its transaction-bound backup is unavailable.",
          );
          return bail(
            "Replacement state restoration is incomplete; the replacement journal was retained.",
          );
        }
        if (
          backup.backupManifest?.rebuildPolicyHandoff &&
          backup.backupManifest.backupPath !== recoveryBackup.backupPath &&
          !clearRebuildPolicyHandoff(backup.backupManifest)
        ) {
          return bail(
            "The unused current-run rebuild policy handoff could not be retired during recovery.",
          );
        }
        rebuildPolicyHandoffManifest = recoveryBackup;
        retainPolicyHandoffForRecovery = true;
        // The accepted replacement belongs to an earlier run. Its persisted
        // gate is independent of the current backup's cron plan, so probe every
        // Hermes target before retiring the replacement journal.
        if (rebuildAgent === "hermes") {
          try {
            const outcome = recoverHermesCronRestore(sandboxName);
            if (outcome === "unsupported") {
              console.error("");
              console.error(
                "  The accepted Hermes replacement does not provide cron restore recovery.",
              );
              console.error(`  Backup is preserved at: ${backup.backupManifest?.backupPath}`);
              return bail(
                "Hermes cron restore recovery is unavailable; the replacement journal was retained.",
              );
            }
            if (outcome === "operator-drain-preserved") {
              console.log(
                "  Hermes cron restore gate cleared; the independent operator drain remains active.",
              );
            }
            log(`Hermes cron restore recovery for accepted replacement: ${outcome}`);
          } catch (error) {
            console.error("");
            console.error(
              `  Hermes cron restore could not validate and release the accepted replacement: ${rebuildFailureDetail(error)}`,
            );
            console.error(`  Backup is preserved at: ${backup.backupManifest?.backupPath}`);
            printHermesCronRestoreRecoveryCommand(sandboxName);
            return bail(
              "Hermes cron restore recovery failed; the replacement journal was retained.",
            );
          }
        }
        const restored = runRebuildRestorePhase({
          sandboxName,
          targetAgentType: rebuildAgent || "openclaw",
          targetImageIsCustom: Boolean(fromDockerfile),
          backupManifest: recoveryBackup,
          log,
        });
        await runRebuildPostRestorePhase({
          sandboxName,
          sandboxEntry,
          targetAgentName: rebuildAgent || "openclaw",
          messagingPlan,
          backupManifest: recoveryBackup,
          mcpEntries: Object.values(sandboxEntry.mcp?.bridges ?? {}),
          restoreSucceeded: restored.restoreSucceeded,
          backupWasForceSkipped: false,
          staleRecovery: false,
          recoveryRecreate: true,
          preparedBackupRecovery: true,
          staleSandboxWasLocked,
          versionCheck,
          relockShieldsIfNeeded,
          log,
          bail,
        });
        if (recoveryBackup.rebuildPolicyHandoff && !clearRebuildPolicyHandoff(recoveryBackup)) {
          return bail("The bounded rebuild policy handoff could not be retired after recovery.");
        }
        clearRebuildRecoveryBackup({
          ...rebuildRecoveryIdentity,
          backupManifest: recoveryBackup,
        });
        recreateJournal.completeAcceptedTarget();
        retainPolicyHandoffForRecovery = false;
        console.log(`  Recovered the accepted replacement for '${sandboxName}'.`);
        console.log(`  Backup is preserved at: ${recoveryBackup.backupPath}`);
        log(
          `Recovered and restored journaled replacement ${recreateJournal.id} for '${sandboxName}'`,
        );
        return;
      }

      let preservedMcpPolicyHandoff = false;
      const mcpPreparation = await runRebuildDestroyPhase({
        sandboxName,
        sandboxEntry,
        staleRecovery,
        recreateJournal,
        backupManifest: backup.backupManifest,
        force: normalized.force,
        log,
        bail,
        relockShieldsIfNeeded,
        validateAfterMcpPreparation: async (preparation) => {
          if (preparation.policyHandoff !== undefined) {
            try {
              if (!publishPolicyHandoff(preparation.policyHandoff)) {
                throw new Error("publish failed");
              }
              preservedMcpPolicyHandoff = true;
            } catch {
              return {
                ok: false,
                message:
                  "The complete live OpenShell policy could not be retained after MCP teardown.",
              };
            }
          }
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
            durableConfig.dcodeAutoApprovalMode,
            recoveryRecreate,
            recreateOptions.targetGatewayPort,
          );
        },
        validateAtDeleteEdge: () => {
          const validation =
            revalidateManagedWorkloadRebuildBeforeDelete(
              sandboxName,
              recreateOptions.managedWorkloadRebuild,
            ) ?? revalidateRebuildRouteBeforeDelete(routePreflightReceipt);
          if (!validation.ok) return validation;
          // Live MCP teardown temporarily removes credential-bound rules from
          // the source sandbox. Its preparation returned the complete
          // pre-teardown OpenShell document above and independently revalidates
          // the stripped source policy. Do not overwrite that handoff with the
          // temporary teardown state at the delete edge.
          if (preservedMcpPolicyHandoff) return validation;
          // A stale-recovery sandbox is already absent. Preflight admitted this
          // path only after digest-verifying the policy handoff bound to the
          // prepared recovery manifest, so there is no live policy to recapture.
          if (staleRecovery) return validation;
          return capturePolicyHandoff()
            ? validation
            : {
                ok: false,
                message: "The current OpenShell policy became unavailable before sandbox deletion.",
              };
        },
        cleanupDockerOrphanAfterDelete: () =>
          removeStaleRebuildDockerOrphan(
            sandboxName,
            sandboxEntry.openshellDriver,
            log,
          ),
        onDeleted: () => {
          sandboxStillExists = false;
          retainPolicyHandoffForRecovery = true;
        },
        onDeleteStateAmbiguous: () => {
          sandboxExistenceAmbiguous = true;
          retainPolicyHandoffForRecovery = true;
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
          recreateJournal,
          fromDockerfile,
          rebuildAgent,
          messagingPlan,
          rebuildsHermesSandbox: rebuildAgent === "hermes",
          hermesToolGateways,
          hasHermesToolGateways,
          policySourcePath: backup.policySourcePath,
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

      const restore = () =>
        runRebuildRestorePhase({
          sandboxName,
          targetAgentType: rebuildAgent || "openclaw",
          targetImageIsCustom: Boolean(fromDockerfile),
          backupManifest: backup.backupManifest,
          log,
        });
      let hermesCronRestoreIdentity: HermesCronRestoreIdentity | undefined;
      const restored = hermesCronRestorePlan?.requiresDispatchGate
        ? (() => {
            try {
              const transaction = runHermesCronRestoreTransaction(
                sandboxName,
                restore,
                (state, identity) => {
                  log(
                    `Hermes cron restore gate ${state}: pid=${String(identity.pid)}, startTime=${String(identity.start_time)}`,
                  );
                },
              );
              hermesCronRestoreIdentity = transaction.identity;
              return transaction.result;
            } catch (error) {
              console.error("");
              console.error(
                error instanceof HermesCronRestoreIncompleteError
                  ? "  Hermes cron dispatch remains drained because state restore was incomplete."
                  : `  Hermes cron restore could not validate and reactivate dispatch: ${rebuildFailureDetail(error)}`,
              );
              console.error(`  Backup is preserved at: ${backup.backupManifest?.backupPath}`);
              printHermesCronRestoreRecoveryCommand(sandboxName);
              return bail("Hermes cron restore validation failed; dispatch was not re-enabled.");
            }
          })()
        : restore();
      await runRebuildPostRestorePhase({
        sandboxName,
        sandboxEntry,
        targetAgentName: rebuildAgent || "openclaw",
        messagingPlan,
        backupManifest: backup.backupManifest,
        mcpEntries: mcpPreparation.entries,
        restoreSucceeded: restored.restoreSucceeded,
        hermesCronRestoreIdentity,
        backupWasForceSkipped: backup.backupWasForceSkipped,
        staleRecovery,
        recoveryRecreate,
        preparedBackupRecovery,
        staleSandboxWasLocked,
        versionCheck,
        relockShieldsIfNeeded,
        log,
        bail,
      });
      if (backup.backupManifest) {
        if (
          backup.backupManifest.rebuildPolicyHandoff &&
          !clearRebuildPolicyHandoff(backup.backupManifest)
        ) {
          return bail("The bounded rebuild policy handoff could not be retired after rebuild.");
        }
        clearRebuildRecoveryBackup({
          ...rebuildRecoveryIdentity,
          backupManifest: backup.backupManifest,
        });
      }
      retainPolicyHandoffForRecovery = false;
    } finally {
      const handoffManifest = rebuildPolicyHandoffManifest;
      if (handoffManifest?.rebuildPolicyHandoff && !retainPolicyHandoffForRecovery) {
        runBestEffortRebuildCleanup(
          () => clearRebuildPolicyHandoff(handoffManifest),
          "  Warning: bounded rebuild policy handoff could not be removed.",
        );
      } else if (rebuildPolicySourcePath && rebuildPolicySourceIsEphemeral) {
        const retainedPolicySourcePath = rebuildPolicySourcePath;
        runBestEffortRebuildCleanup(
          () => cleanupTempDir(retainedPolicySourcePath, "nemoclaw-rebuild-policy"),
          `  Warning: temporary rebuild policy handoff could not be removed. Remove ${retainedPolicySourcePath} before retrying.`,
        );
      }
      if (!rebuildShieldsWindow.relocked && !sandboxExistenceAmbiguous) {
        relockShieldsIfNeeded(sandboxStillExists);
      }
    }
  } finally {
    runBestEffortRebuildCleanup(
      dcodePreflight.cleanup,
      "  Warning: temporary DCode rebuild inputs could not be fully removed.",
    );
    runBestEffortRebuildCleanup(
      () => disposeRebuildAgentBaseImagePreflight(baseImagePreflight),
      "  Warning: temporary rebuild base-image handoff could not be removed.",
    );
    if (preparedImage) {
      const retainedPreparedImage = preparedImage;
      runBestEffortRebuildCleanup(
        () => disposePreparedBuildContext(retainedPreparedImage),
        "  Warning: temporary rebuild image inputs could not be fully removed.",
      );
    }
    process.removeListener("exit", releaseOnboardLock);
    releaseOnboardLock();
  }
}
