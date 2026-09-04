// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildSelectedOpenShellSubprocessEnv } from "../../adapters/openshell/command-argv";
import { captureOpenshell, runOpenshell } from "../../adapters/openshell/runtime";
import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime-selection";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import { G, R } from "../../cli/terminal-style";
import { waitUntil } from "../../core/wait";
import { getSandboxDeleteOutcome } from "../../domain/sandbox/destroy";
import * as nim from "../../inference/nim";
import { resolveGatewayName, resolveSandboxGatewayName } from "../../onboard/gateway-binding";
import { isExplicitMissingSandboxGatewayOutput } from "../../onboard/sandbox-recreate-probe";
import { redactFull } from "../../security/redact";
import { parseSandboxPhase } from "../../state/gateway";
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
  sandboxName: string;
  sandboxEntry: RebuildSandboxEntry;
  staleRecovery: boolean;
  recreateJournal: RebuildRecreateJournal;
  backupManifest: RebuildBackupManifest;
  log: RebuildLog;
  bail: RebuildBail;
  force?: boolean;
  runtimeSelection?: OpenShellRuntimeSelection;
  validateAfterMcpPreparation?: (
    preparation: McpRebuildPreparation,
  ) => Promise<RebuildDeleteValidationResult>;
  validateAtDeleteEdge?: (
    runtimeSelection?: OpenShellRuntimeSelection,
  ) => RebuildDeleteValidationResult;
  cleanupDockerOrphanAfterDelete?: () => void;
  onDeleted: () => void;
  onDeleteStateAmbiguous?: () => void;
}

export type RebuildDestroyPhaseResult = McpRebuildPreparation & {
  removalReceipt: registry.SandboxRemovalReceipt | null;
};

type PostDeleteReconciliation =
  | { state: "deleted"; phase: null; status: number | null }
  | { state: "intact"; phase: "Ready" | "Running"; status: 0 }
  | { state: "ambiguous"; phase: string | null; status: number | null };

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

const REBUILD_DELETE_ABSENCE_MAX_ATTEMPTS = 20;
const REBUILD_DELETE_ABSENCE_INITIAL_INTERVAL_MS = 250;
const REBUILD_DELETE_ABSENCE_MAX_INTERVAL_MS = 1_000;

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
export function waitForRebuildDeleteAbsence(
  sandboxName: string,
  gatewayName: string,
  log: RebuildLog,
  deps: RebuildDeleteAbsenceDeps = {},
): boolean {
  if (deps.runtimeSelection && deps.runtimeSelection.gatewayName !== gatewayName) {
    throw new Error("Rebuild delete gateway does not match the frozen OpenShell target.");
  }
  const now = deps.now ?? Date.now;
  const deadlineMs = now() + OPENSHELL_PROBE_TIMEOUT_MS;
  const captureSandboxGet =
    deps.captureSandboxGet ??
    ((name: string, timeoutMs: number) => {
      const probe = captureOpenshell(["sandbox", "get", "-g", gatewayName, name], {
        ignoreError: true,
        includeStderr: true,
        includeStreams: true,
        timeout: timeoutMs,
        ...(deps.runtimeSelection
          ? {
              env: buildSelectedOpenShellSubprocessEnv(deps.runtimeSelection),
              replaceEnv: true,
            }
          : {}),
      });
      return probe;
    });
  let attempt = 0;

  return waitUntil(
    () => {
      attempt += 1;
      const remainingMs = Math.max(1, Math.ceil(deadlineMs - now()));
      const probe = captureSandboxGet(sandboxName, remainingMs);
      const stdout = String(probe.stdout ?? (probe.status === 0 ? probe.output : "")).trim();
      const combinedOutput = `${stdout}\n${String(probe.stderr ?? probe.output ?? "")}`.trim();
      const state =
        !probe.error &&
        !probe.signal &&
        probe.status !== null &&
        probe.status !== 0 &&
        isExplicitMissingSandboxGatewayOutput(combinedOutput, sandboxName)
          ? "absent"
          : probe.status === 0 && stdout.length > 0
            ? "present"
            : "unknown";
      log(`Delete convergence probe ${attempt}: status=${probe.status}, state=${state}`);
      return state === "absent";
    },
    {
      deadlineMs,
      initialIntervalMs: REBUILD_DELETE_ABSENCE_INITIAL_INTERVAL_MS,
      maxIntervalMs: REBUILD_DELETE_ABSENCE_MAX_INTERVAL_MS,
      maxAttempts: REBUILD_DELETE_ABSENCE_MAX_ATTEMPTS,
      now,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    },
  );
}

/**
 * A nonzero delete may be reported after OpenShell has already changed the
 * sandbox. Query the exact recorded gateway and classify only an explicit
 * NotFound as deleted or a live Ready/Running phase as intact. Everything else
 * stays ambiguous so recovery never invents an ownership boundary.
 */
function reconcileFailedSandboxDelete(
  sandboxName: string,
  sandboxEntry: RebuildSandboxEntry,
  log: RebuildLog,
  runtimeSelection?: OpenShellRuntimeSelection,
): PostDeleteReconciliation {
  let gatewayName: string;
  try {
    gatewayName = resolveSandboxGatewayName(sandboxEntry);
  } catch {
    log("Post-delete reconciliation could not resolve the recorded sandbox gateway.");
    return { state: "ambiguous", phase: null, status: null };
  }
  if (runtimeSelection && runtimeSelection.gatewayName !== gatewayName) {
    log("Post-delete reconciliation target does not match the frozen OpenShell target.");
    return { state: "ambiguous", phase: null, status: null };
  }

  let probe: ReturnType<typeof runOpenshell>;
  try {
    probe = runOpenshell(["sandbox", "get", "-g", gatewayName, sandboxName], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: OPENSHELL_PROBE_TIMEOUT_MS,
      ...(runtimeSelection
        ? {
            env: buildSelectedOpenShellSubprocessEnv(runtimeSelection),
            replaceEnv: true,
          }
        : {}),
    });
  } catch {
    log(`Post-delete reconciliation could not query recorded gateway '${gatewayName}'.`);
    return { state: "ambiguous", phase: null, status: null };
  }
  if (probe.error || probe.signal || probe.status === null) {
    log(`Post-delete reconciliation could not complete on recorded gateway '${gatewayName}'.`);
    return { state: "ambiguous", phase: null, status: probe.status };
  }
  const probeOutput = `${probe.stdout || ""}\n${probe.stderr || ""}`;
  if (probe.status !== 0 && isExplicitMissingSandboxGatewayOutput(probeOutput, sandboxName)) {
    log(`Post-delete reconciliation on '${gatewayName}': sandbox is absent.`);
    return { state: "deleted", phase: null, status: probe.status };
  }
  const phase = probe.status === 0 ? parseSandboxPhase(probeOutput) : null;
  if (probe.status === 0 && (phase === "Ready" || phase === "Running")) {
    log(`Post-delete reconciliation on '${gatewayName}': sandbox remains ${phase}.`);
    return { state: "intact", phase, status: 0 };
  }
  log(
    `Post-delete reconciliation on '${gatewayName}' is ambiguous: exit=${probe.status}, phase=${phase ?? "unknown"}.`,
  );
  return { state: "ambiguous", phase, status: probe.status };
}

/**
 * Detach owned MCP state, delete the old sandbox, and then stop inference.
 * Boundary coverage: rebuild-flow.test.ts exercises success, stale recovery,
 * delete failure, provider reattach failure, and MCP-bearing registry retention.
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
        input.force === true,
        bail,
        input.runtimeSelection,
      );
      return preparation;
    },
    afterPrepare: async (preparation) => {
      // MCP preparation removes only adapter entries whose exact ownership
      // fingerprints match the registry. Probe afterward so a Deep Agents
      // user `.mcp.json` is not confused with the separate managed projection.
      // This can block on SSH, so it must finish before the final DCode check.
      if (!staleRecovery) {
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
  if (mcpPreparation.revalidateBeforeDelete || mcpPreparation.assertDeleteEdgeUnchanged) {
    try {
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
          ? `Failed to revalidate MCP recovery before sandbox deletion: ${redactFull(detail)} MCP provider recovery also failed: ${mcpRecoveryFailure}`
          : `Failed to revalidate MCP recovery before sandbox deletion: ${redactFull(detail)}`,
      );
      return null;
    }
  }

  // MCP preparation can await external systems; re-read the registry at the
  // synchronous delete edge so those checks and deletion use one target.
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
      validation = validateAtDeleteEdge(rebuildMcpRuntimeSelection);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log(`Unexpected delete-edge validation failure: ${redactFull(detail)}`);
      validation = {
        ok: false,
        message: "Replacement validation failed before sandbox deletion.",
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
  if (sourcePresence === "missing") {
    log(`Skipping delete: gateway ${gatewayName} reports '${sandboxName}' already absent`);
  } else {
    log(`Running: openshell sandbox delete -g ${gatewayName} ${sandboxName}`);
  }
  const deleteResult =
    sourcePresence === "missing"
      ? null
      : runOpenshell(["sandbox", "delete", "-g", gatewayName, sandboxName], {
          ignoreError: true,
          stdio: ["ignore", "pipe", "pipe"],
          ...(rebuildMcpRuntimeSelection
            ? {
                env: buildSelectedOpenShellSubprocessEnv(rebuildMcpRuntimeSelection),
                replaceEnv: true,
              }
            : {}),
        });
  const alreadyGone = deleteResult === null || getSandboxDeleteOutcome(deleteResult).alreadyGone;
  if (deleteResult) log(`Delete result: exit=${deleteResult.status}, alreadyGone=${alreadyGone}`);
  let deletionConfirmed = alreadyGone;
  if (deleteResult && deleteResult.status !== 0) {
    const reconciledDelete = reconcileFailedSandboxDelete(
      sandboxName,
      input.sandboxEntry,
      log,
      rebuildMcpRuntimeSelection,
    );
    if (reconciledDelete.state === "deleted") {
      log("Delete returned nonzero, but exact post-delete state confirms sandbox removal.");
      deletionConfirmed = true;
    } else if (reconciledDelete.state === "intact") {
      console.error("  Failed to delete sandbox. Aborting rebuild.");
      console.error(
        `  Exact post-delete verification confirms the original sandbox remains ${reconciledDelete.phase}.`,
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
          ? `Failed to delete sandbox; recovery also failed: ${[
              mcpRecoveryFailure,
            ]
              .filter(Boolean)
              .join("; ")}`
          : "Failed to delete sandbox.",
        deleteResult.status || 1,
      );
      return null;
    } else {
      console.error(
        "  Sandbox deletion returned an error, and exact post-delete state is ambiguous.",
      );
      console.error(
        "  MCP ownership and recovery metadata were preserved; local NIM was not stopped.",
      );
      if (backupManifest) {
        console.error("  State backup is preserved at: " + backupManifest.backupPath);
      }
      input.onDeleteStateAmbiguous?.();
      bail(
        "Sandbox delete failed and exact post-delete state is ambiguous; recovery state was preserved.",
        deleteResult.status || 1,
      );
      return null;
    }
  }
  deletionConfirmed ||= waitForRebuildDeleteAbsence(sandboxName, gatewayName, log, {
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
  if (!teardownSandboxDashboardForward(sandboxName)) {
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
