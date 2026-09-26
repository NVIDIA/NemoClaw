// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildSelectedOpenShellSubprocessEnv } from "../../adapters/openshell/command-argv";
import { captureOpenshell, runOpenshell } from "../../adapters/openshell/runtime";
import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime-selection";
import {
  createCliOpenShellSandboxLifecycleFromRunner,
  type SandboxDeleteConvergenceResult,
  waitForSandboxDeleteAbsence,
} from "../../adapters/openshell/sandbox-lifecycle-cli";
import { createCliOpenShellSandboxLookup } from "../../adapters/openshell/sandbox-observer-cli";
import { G, R } from "../../cli/terminal-style";
import * as nim from "../../inference/nim";
import { resolveGatewayName } from "../../onboard/gateway-binding";
import { redactFull } from "../../security/redact";
import { registryEntryGatewayPort } from "../../state/gateway-registry";
import * as registry from "../../state/registry";
import type { RebuildBackupManifest } from "./rebuild-backup-phase";
import type { RebuildBail, RebuildLog } from "./rebuild-credential-preflight";
import { type RebuildSandboxEntry, warnUnpreservedUserManagedFiles } from "./rebuild-flow-helpers";
import { prepareMcpBeforeBestEffortNimStop } from "./rebuild-mcp-order";
import {
  type McpRebuildPreparation,
  prepareMcpForRebuild,
  reattachMcpAfterDeleteFailure,
} from "./rebuild-mcp-phase";
import type {
  RebuildRecreateJournal,
  RebuildRecreateSourcePresence,
} from "./rebuild-recreate-journal";
import { teardownSandboxDashboardForward } from "./forward-recovery";

export type RebuildDeleteValidationResult =
  | { ok: true }
  | { ok: false; message: string; code?: number };

export interface RebuildDestroyPhaseInput {
  capturedOpenClawState?: import("../../state/state-directory-restore").CapturedOpenClawState;
  sandboxName: string;
  sandboxEntry: RebuildSandboxEntry;
  staleRecovery: boolean;
  recreateJournal: RebuildRecreateJournal;
  backupManifest: RebuildBackupManifest;
  recheckMessagingConflicts?: (
    runtimeSelection: OpenShellRuntimeSelection | undefined,
    onConflict: RebuildBail,
  ) => Promise<void>;
  mcpEntries?: readonly McpRebuildPreparation["entries"][number][];
  log: RebuildLog;
  bail: RebuildBail;
  force?: boolean;
  runtimeSelection?: OpenShellRuntimeSelection;
  validateAfterMcpPreparation?: (
    preparation: McpRebuildPreparation,
  ) => Promise<RebuildDeleteValidationResult>;
  validateAtDeleteEdge?: (
    runtimeSelection?: OpenShellRuntimeSelection,
  ) => RebuildDeleteValidationResult | Promise<RebuildDeleteValidationResult>;
  prepareSourceForDelete?: () => Promise<RebuildDeleteValidationResult>;
  cleanupDockerOrphanAfterDelete?: () => void;
  onDeleted: () => void;
  onDeleteStateAmbiguous?: () => void;
}

export type RebuildDestroyPhaseResult = McpRebuildPreparation & {
  removalReceipt: registry.SandboxRemovalReceipt | null;
};

interface RebuildDeleteTarget {
  gatewayName: string;
  gatewayPort: number;
  sandboxName: string;
}

interface RebuildDeleteAbsenceDeps {
  captureSandboxGet?: (
    sandboxName: string,
    timeoutMs: number,
  ) => {
    status: number | null;
    output?: string;
    stdout?: string;
    stderr?: string;
    error?: Error;
    signal?: NodeJS.Signals | null;
  };
  now?: () => number;
  sleep?: (milliseconds: number) => void;
  runtimeSelection?: OpenShellRuntimeSelection;
}

function resolveRebuildDeleteTarget(
  sandboxName: string,
  sandboxEntry: RebuildSandboxEntry,
): RebuildDeleteTarget {
  if (sandboxEntry.name !== sandboxName) {
    throw new Error("Rebuild sandbox entry does not match the requested delete target.");
  }
  const gatewayPort = registryEntryGatewayPort({
    name: sandboxEntry.name,
    gatewayName: sandboxEntry.gatewayName,
    gatewayPort: sandboxEntry.gatewayPort,
  });
  return {
    gatewayName: resolveGatewayName(gatewayPort),
    gatewayPort,
    sandboxName,
  };
}

function rebuildDeleteTargetMatchesRegistry(expected: RebuildDeleteTarget): boolean {
  const currentEntry = registry.getSandbox(expected.sandboxName);
  if (!currentEntry) return false;
  try {
    const current = resolveRebuildDeleteTarget(expected.sandboxName, currentEntry);
    return (
      current.gatewayName === expected.gatewayName && current.gatewayPort === expected.gatewayPort
    );
  } catch {
    return false;
  }
}

/** Wait for explicit absence from the same `sandbox get` boundary used by inner onboard. */
function waitForRebuildDeleteConvergence(
  sandboxName: string,
  gatewayName: string,
  log: RebuildLog,
  deps: RebuildDeleteAbsenceDeps = {},
): Promise<SandboxDeleteConvergenceResult> {
  if (deps.runtimeSelection && deps.runtimeSelection.gatewayName !== gatewayName) {
    throw new Error("Rebuild delete gateway does not match the frozen OpenShell target.");
  }
  const lookupSandbox = createCliOpenShellSandboxLookup({
    capture: async (args, options) => {
      const probe = deps.captureSandboxGet
        ? deps.captureSandboxGet(sandboxName, options.timeout)
        : captureOpenshell(args, {
            ...options,
            ...(deps.runtimeSelection
              ? {
                  env: buildSelectedOpenShellSubprocessEnv(deps.runtimeSelection),
                  replaceEnv: true,
                }
              : {}),
          });
      const result = await probe;
      const captured = {
        ...result,
        output:
          result.output ?? `${String(result.stdout ?? "")}\n${String(result.stderr ?? "")}`.trim(),
      };
      return result.signal
        ? {
            ...captured,
            status: null,
            error: result.error ?? new Error("OpenShell sandbox lookup was interrupted."),
          }
        : captured;
    },
  });
  return waitForSandboxDeleteAbsence(sandboxName, gatewayName, lookupSandbox, log, {
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
}

export function waitForRebuildDeleteAbsence(
  sandboxName: string,
  gatewayName: string,
  log: RebuildLog,
  deps: RebuildDeleteAbsenceDeps = {},
): Promise<boolean> {
  return waitForRebuildDeleteConvergence(sandboxName, gatewayName, log, deps).then(
    (result) => result.confirmed,
  );
}

/**
 * Detach owned MCP state, delete the old sandbox, and then stop inference.
 * Boundary coverage: rebuild-flow.test.ts exercises success, stale recovery,
 * delete failure, provider reattach failure, and bounded MCP handoff retention.
 */
export async function runRebuildDestroyPhase(
  input: RebuildDestroyPhaseInput,
): Promise<RebuildDestroyPhaseResult | null> {
  const {
    sandboxName,
    staleRecovery,
    recreateJournal,
    backupManifest,
    log,
    bail,
    validateAfterMcpPreparation,
    validateAtDeleteEdge,
    prepareSourceForDelete,
    cleanupDockerOrphanAfterDelete,
    onDeleted,
  } = input;
  const deleteTarget = resolveRebuildDeleteTarget(sandboxName, input.sandboxEntry);
  const { gatewayName } = deleteTarget;

  // Step 3: Delete sandbox without tearing down gateway or session.
  // sandboxDestroy() cleans up the gateway when it's the last sandbox and
  // nulls session.sandboxName — both break the immediate onboard --resume.
  console.log("  Deleting old sandbox...");
  const sbMeta = registry.getSandbox(sandboxName);
  log(
    `Registry entry: agent=${sbMeta?.agent}, agentVersion=${sbMeta?.agentVersion}, nimContainer=${sbMeta?.nimContainer}`,
  );
  const stopNimBestEffort = (): void => {
    try {
      if (sbMeta && sbMeta.nimContainer) {
        log(`Stopping NIM container: ${sbMeta.nimContainer}`);
        nim.stopNimContainerByName(sbMeta.nimContainer);
      } else {
        // Best-effort cleanup — see comment in sandboxDestroy.
        nim.stopNimContainer(sandboxName, { silent: true });
      }
    } catch (error) {
      // Keep the established best-effort contract if the local runtime throws;
      // recreate force-removes the old name after a successful sandbox delete.
      log(
        `Best-effort NIM stop failed; continuing rebuild: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const mcpPreparation = await prepareMcpBeforeBestEffortNimStop({
    prepareMcp: async () => {
      const preparation = await prepareMcpForRebuild(
        sandboxName,
        staleRecovery,
        bail,
        input.runtimeSelection,
        input.mcpEntries ?? [],
        ...(input.capturedOpenClawState ? ([input.capturedOpenClawState] as const) : ([] as const)),
      );
      return preparation;
    },
    afterPrepare: async (preparation) => {
      // MCP preparation removes only adapter entries whose exact ownership
      // fingerprints match the registry. Probe afterward so a Deep Agents
      // user `.mcp.json` is not confused with the separate managed projection.
      // This can block on SSH, so it must finish before the final DCode check.
      if (input.capturedOpenClawState) {
        console.warn(
          "  User-managed files outside the declared OpenClaw state cannot be checked on the stopped sandbox and will not be restored. Re-add them after rebuild or manage them from the host.",
        );
      } else if (!staleRecovery) {
        warnUnpreservedUserManagedFiles(sandboxName, log, preparation.runtimeSelection);
      }
      if (validateAfterMcpPreparation) {
        let validation: RebuildDeleteValidationResult;
        try {
          validation = await validateAfterMcpPreparation(preparation);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          log(`Unexpected DCode replacement validation failure: ${redactFull(detail)}`);
          validation = {
            ok: false,
            message: "DCode replacement validation failed before sandbox deletion.",
          };
        }
        if (validation.ok) return;
        const mcpRecoveryFailure = await reattachMcpAfterDeleteFailure(
          sandboxName,
          preparation.detachedProviderEntries,
          preparation.scrubbedAdapterEntries,
          preparation.runtimeSelection,
        );
        bail(
          mcpRecoveryFailure
            ? `${validation.message} MCP provider recovery also failed: ${mcpRecoveryFailure}`
            : validation.message,
          validation.code,
        );
      }
    },
    // A nonzero OpenShell delete may arrive after partial mutation. Keep local
    // inference alive until deletion is positively confirmed for every rebuild
    // path, not only read-only MCP recovery.
    stopNim: () => undefined,
    log,
  });
  if (!mcpPreparation) return null;
  const rebuildDetachedMcpProviderEntries = mcpPreparation.detachedProviderEntries;
  const rebuildScrubbedMcpAdapterEntries = mcpPreparation.scrubbedAdapterEntries;
  const rebuildMcpRuntimeSelection = input.runtimeSelection ?? mcpPreparation.runtimeSelection;
  if (
    rebuildMcpRuntimeSelection &&
    rebuildMcpRuntimeSelection.gatewayName !== deleteTarget.gatewayName
  ) {
    const mcpRecoveryFailure = await reattachMcpAfterDeleteFailure(
      sandboxName,
      rebuildDetachedMcpProviderEntries,
      rebuildScrubbedMcpAdapterEntries,
      rebuildMcpRuntimeSelection,
    );
    bail(
      mcpRecoveryFailure
        ? `Rebuild delete target gateway '${deleteTarget.gatewayName}' does not match recorded OpenShell gateway '${rebuildMcpRuntimeSelection.gatewayName}'. NemoClaw did not delete the original sandbox. MCP provider recovery also failed: ${mcpRecoveryFailure}. Restore recorded gateway '${rebuildMcpRuntimeSelection.gatewayName}', confirm it is healthy, then retry.`
        : `Rebuild delete target gateway '${deleteTarget.gatewayName}' does not match recorded OpenShell gateway '${rebuildMcpRuntimeSelection.gatewayName}'. NemoClaw did not delete the original sandbox. Restore recorded gateway '${rebuildMcpRuntimeSelection.gatewayName}', confirm it is healthy, then retry.`,
    );
    return null;
  }

  // Exec-unavailable recovery deliberately made no MCP mutation during
  // preparation. Re-prove target, policy, provider, and registry state while
  // the original sandbox and local NIM are still intact. Then run one final
  // synchronous registry check at the no-await edge immediately before delete.
  // External control-plane state can still change after the awaited proof; the
  // final synchronous check covers registry state only and minimizes that
  // window. Durable MCP intent remains preserved, and restoration rechecks the
  // external state and fails closed if later control-plane drift is observed.
  if (
    input.recheckMessagingConflicts ||
    mcpPreparation.revalidateBeforeDelete ||
    mcpPreparation.assertDeleteEdgeUnchanged
  ) {
    try {
      await input.recheckMessagingConflicts?.(rebuildMcpRuntimeSelection, (message) => {
        throw new Error(message);
      });
      await mcpPreparation.revalidateBeforeDelete?.();
      mcpPreparation.assertDeleteEdgeUnchanged?.();
    } catch (error) {
      const mcpRecoveryFailure = await reattachMcpAfterDeleteFailure(
        sandboxName,
        rebuildDetachedMcpProviderEntries,
        rebuildScrubbedMcpAdapterEntries,
        rebuildMcpRuntimeSelection,
      );
      const detail = error instanceof Error ? error.message : String(error);
      bail(
        mcpRecoveryFailure
          ? `Failed to revalidate rebuild before sandbox deletion: ${redactFull(detail)} MCP provider recovery also failed: ${mcpRecoveryFailure}`
          : `Failed to revalidate rebuild before sandbox deletion: ${redactFull(detail)}`,
      );
      return null;
    }
  }

  // MCP preparation can await external systems; re-read non-MCP routing state
  // at the synchronous delete edge so those checks and deletion use one target.
  if (!rebuildDeleteTargetMatchesRegistry(deleteTarget)) {
    const mcpRecoveryFailure = await reattachMcpAfterDeleteFailure(
      sandboxName,
      rebuildDetachedMcpProviderEntries,
      rebuildScrubbedMcpAdapterEntries,
      rebuildMcpRuntimeSelection,
    );
    bail(
      mcpRecoveryFailure
        ? `Sandbox delete target changed during rebuild preparation; MCP provider recovery also failed: ${mcpRecoveryFailure}`
        : "Sandbox delete target changed during rebuild preparation.",
    );
    return null;
  }

  if (validateAtDeleteEdge) {
    let validation: RebuildDeleteValidationResult;
    try {
      validation = await validateAtDeleteEdge(rebuildMcpRuntimeSelection);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log(`Unexpected delete-edge validation failure: ${redactFull(detail)}`);
      validation = {
        ok: false,
        message: "Replacement validation failed before sandbox deletion.",
      };
    }
    if (validation.ok && !rebuildDeleteTargetMatchesRegistry(deleteTarget)) {
      validation = {
        ok: false,
        message: "Sandbox delete target changed during rebuild preparation.",
      };
    }
    if (!validation.ok) {
      const mcpRecoveryFailure = await reattachMcpAfterDeleteFailure(
        sandboxName,
        rebuildDetachedMcpProviderEntries,
        rebuildScrubbedMcpAdapterEntries,
        rebuildMcpRuntimeSelection,
      );
      bail(
        mcpRecoveryFailure
          ? `${validation.message} MCP provider recovery also failed: ${mcpRecoveryFailure}`
          : validation.message,
        validation.code,
      );
      return null;
    }
  }

  // MCP adapter entries are already detached and scrubbed here. A journal write
  // that fails must reattach them before the rebuild gives up, or the still
  // running sandbox is left without its MCP wiring.
  let sourcePresence: RebuildRecreateSourcePresence;
  try {
    sourcePresence = recreateJournal.beginDelete();
  } catch (error) {
    const mcpRecoveryFailure = await reattachMcpAfterDeleteFailure(
      sandboxName,
      rebuildDetachedMcpProviderEntries,
      rebuildScrubbedMcpAdapterEntries,
      rebuildMcpRuntimeSelection,
    );
    const detail = error instanceof Error ? error.message : String(error);
    bail(
      mcpRecoveryFailure
        ? `Sandbox deletion could not be journaled: ${redactFull(detail)} MCP provider recovery also failed: ${mcpRecoveryFailure}`
        : `Sandbox deletion could not be journaled: ${redactFull(detail)}`,
    );
    return null;
  }
  if (sourcePresence !== "missing" && prepareSourceForDelete) {
    let preparation: RebuildDeleteValidationResult;
    try {
      preparation = await prepareSourceForDelete();
    } catch (error) {
      log(`Unexpected source delete preparation failure: ${redactFull(String(error))}`);
      preparation = { ok: false, message: "Source sandbox could not be prepared for deletion." };
    }
    if (!preparation.ok) {
      const mcpRecoveryFailure = await reattachMcpAfterDeleteFailure(
        sandboxName,
        rebuildDetachedMcpProviderEntries,
        rebuildScrubbedMcpAdapterEntries,
        rebuildMcpRuntimeSelection,
      );
      bail(
        mcpRecoveryFailure
          ? `${preparation.message} MCP provider recovery also failed: ${mcpRecoveryFailure}`
          : preparation.message,
        preparation.code,
      );
      return null;
    }
  }
  if (sourcePresence === "missing") {
    log(`Skipping delete: gateway ${gatewayName} reports '${sandboxName}' already absent`);
  } else {
    log(`Running: openshell sandbox delete -g ${gatewayName} ${sandboxName}`);
  }
  const deleteResult =
    sourcePresence === "missing"
      ? null
      : await createCliOpenShellSandboxLifecycleFromRunner(runOpenshell).deleteSandbox({
          sandboxName,
          target: { kind: "named", gatewayName },
          ...(rebuildMcpRuntimeSelection ? { runtimeSelection: rebuildMcpRuntimeSelection } : {}),
        });
  const alreadyGone = deleteResult === null || deleteResult.kind === "absent";
  if (deleteResult) {
    log(
      `Delete result: state=${deleteResult.kind}, exit=${deleteResult.kind === "failed" ? deleteResult.exitCode : 0}, alreadyGone=${alreadyGone}`,
    );
  }
  let deletionConfirmed = alreadyGone;
  if (deleteResult?.kind === "failed") {
    if (deleteResult.error.kind === "command" && deleteResult.error.reason === "invalid_request") {
      const mcpRecoveryFailure = await reattachMcpAfterDeleteFailure(
        sandboxName,
        rebuildDetachedMcpProviderEntries,
        rebuildScrubbedMcpAdapterEntries,
        rebuildMcpRuntimeSelection,
      );
      bail(
        mcpRecoveryFailure
          ? `${deleteResult.error.message} MCP provider recovery also failed: ${mcpRecoveryFailure}`
          : deleteResult.error.message,
      );
      return null;
    }
    const convergence = await waitForRebuildDeleteConvergence(sandboxName, gatewayName, log, {
      runtimeSelection: rebuildMcpRuntimeSelection,
    });
    if (convergence.confirmed) {
      log("Delete returned nonzero, but exact post-delete state confirms sandbox removal.");
      deletionConfirmed = true;
    } else {
      const lastObservation = convergence.lastObservation;
      const remainingSandbox =
        lastObservation?.ok && lastObservation.value.state === "present"
          ? lastObservation.value.sandbox
          : null;
      if (remainingSandbox?.readiness !== "ready") {
        console.error(
          "  Sandbox deletion returned an error, and bounded exact post-delete state is ambiguous.",
        );
        console.error(
          "  The bounded MCP handoff and recovery metadata were preserved; local NIM was not stopped.",
        );
        if (backupManifest) {
          console.error("  State backup is preserved at: " + backupManifest.backupPath);
        }
        input.onDeleteStateAmbiguous?.();
        bail(
          "Sandbox delete failed and exact post-delete state is ambiguous; recovery state was preserved.",
          deleteResult.exitCode || 1,
        );
        return null;
      }
      console.error("  Failed to delete sandbox. Aborting rebuild.");
      console.error(
        `  Bounded exact post-delete verification confirms the original sandbox remains ${remainingSandbox.phase ?? "ready"}.`,
      );
      const mcpRecoveryFailure = await reattachMcpAfterDeleteFailure(
        sandboxName,
        rebuildDetachedMcpProviderEntries,
        rebuildScrubbedMcpAdapterEntries,
        rebuildMcpRuntimeSelection,
      );
      if (mcpRecoveryFailure) {
        console.error(
          `  Failed to reattach MCP providers to the existing sandbox: ${mcpRecoveryFailure}`,
        );
      }
      if (backupManifest) {
        console.error("  State backup is preserved at: " + backupManifest.backupPath);
      }
      bail(
        mcpRecoveryFailure
          ? `Failed to delete sandbox; recovery also failed: ${[mcpRecoveryFailure]
              .filter(Boolean)
              .join("; ")}`
          : "Failed to delete sandbox.",
        deleteResult.exitCode || 1,
      );
      return null;
    }
  }
  deletionConfirmed ||= await waitForRebuildDeleteAbsence(sandboxName, gatewayName, log, {
    runtimeSelection: rebuildMcpRuntimeSelection,
  });
  if (!deletionConfirmed) {
    console.error(
      "  Sandbox delete was accepted, but OpenShell did not confirm that the sandbox is absent.",
    );
    console.error("  Aborting rebuild before registry removal and sandbox recreation.");
    if (backupManifest) {
      console.error("  State backup is preserved at: " + backupManifest.backupPath);
    }
    input.onDeleteStateAmbiguous?.();
    bail("Sandbox deletion could not be confirmed.");
    return null;
  }
  try {
    recreateJournal.confirmDeleted();
  } catch (error) {
    console.error(
      "  Sandbox delete was accepted, but the replacement journal could not confirm absence.",
    );
    if (backupManifest) {
      console.error("  State backup is preserved at: " + backupManifest.backupPath);
    }
    input.onDeleteStateAmbiguous?.();
    const detail = error instanceof Error ? error.message : String(error);
    bail(`Sandbox deletion could not be journaled: ${redactFull(detail)}`);
    return null;
  }
  if (!(await teardownSandboxDashboardForward(sandboxName))) {
    console.error(
      "  Sandbox deletion succeeded, but one or more ForwardTcp host ports did not release.",
    );
    input.onDeleteStateAmbiguous?.();
    bail("Sandbox host ports did not release after deletion.");
    return null;
  }
  try {
    cleanupDockerOrphanAfterDelete?.();
  } catch (error) {
    stopNimBestEffort();
    onDeleted();
    if (backupManifest) {
      console.error("  State backup is preserved at: " + backupManifest.backupPath);
    }
    const detail = error instanceof Error ? error.message : String(error);
    bail(`Post-delete Docker orphan cleanup failed: ${redactFull(detail)}`);
    return null;
  }
  stopNimBestEffort();
  onDeleted();
  const removalReceipt: registry.SandboxRemovalReceipt | null = null;
  // The journaled source row is the durable replacement transaction. The inner
  // onboard run observes that the sandbox is absent, carries the recorded state
  // into the replacement registration, and never enters generic live
  // recreation. Keeping it here closes every process-death window between
  // successful delete and fresh registry registration.
  log("Preserving journaled source registry entry across sandbox recreation");
  log(
    `Registry after delete: ${JSON.stringify(registry.listSandboxes().sandboxes.map((s: { name: string }) => s.name))}`,
  );
  console.log(`  ${G}\u2713${R} Old sandbox deleted`);

  return { ...mcpPreparation, removalReceipt };
}
