// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshell } from "../../adapters/openshell/runtime";
import {
  OPENSHELL_HEAVY_TIMEOUT_MS,
  OPENSHELL_PROBE_TIMEOUT_MS,
} from "../../adapters/openshell/timeouts";
import { G, R } from "../../cli/terminal-style";
import { waitUntil } from "../../core/wait";
import { getSandboxDeleteOutcome } from "../../domain/sandbox/destroy";
import * as nim from "../../inference/nim";
import { resolveSandboxGatewayName } from "../../onboard/gateway-binding";
import { redactFull } from "../../security/redact";
import { parseSandboxPhase } from "../../state/gateway";
import * as registry from "../../state/registry";
import { removeSandboxRegistryEntryWithReceipt } from "./destroy";
import { isExplicitMissingSandboxGatewayOutput } from "./gateway-state";
import type { RebuildBackupManifest } from "./rebuild-backup-phase";
import type { RebuildBail, RebuildLog } from "./rebuild-credential-preflight";
import { type RebuildSandboxEntry, warnUnpreservedUserManagedFiles } from "./rebuild-flow-helpers";
import { prepareMcpBeforeBestEffortNimStop } from "./rebuild-mcp-order";
import {
  type McpRebuildPreparation,
  prepareMcpForRebuild,
  reattachMcpAfterDeleteFailure,
} from "./rebuild-mcp-phase";

export type RebuildDeleteValidationResult =
  | { ok: true }
  | { ok: false; message: string; code?: number };

export interface RebuildDestroyPhaseInput {
  sandboxName: string;
  sandboxEntry: RebuildSandboxEntry;
  staleRecovery: boolean;
  backupManifest: RebuildBackupManifest;
  log: RebuildLog;
  bail: RebuildBail;
  relockShieldsIfNeeded: (sandboxStillExists: boolean) => boolean;
  force?: boolean;
  validateAfterMcpPreparation?: () => Promise<RebuildDeleteValidationResult>;
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

function waitForSandboxDeletion(
  sandboxName: string,
  gatewayName: string,
  log: RebuildLog,
): boolean {
  return waitUntil(
    () => {
      const getResult = runOpenshell(["sandbox", "get", "-g", gatewayName, sandboxName], {
        ignoreError: true,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: OPENSHELL_PROBE_TIMEOUT_MS,
      });
      const { alreadyGone, gatewayUnreachable } = getSandboxDeleteOutcome(getResult);
      log(
        `Delete convergence probe: exit=${getResult.status}, alreadyGone=${alreadyGone}, gatewayUnreachable=${gatewayUnreachable}`,
      );
      return alreadyGone;
    },
    { deadlineMs: Date.now() + OPENSHELL_HEAVY_TIMEOUT_MS },
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
): PostDeleteReconciliation {
  let gatewayName: string;
  try {
    gatewayName = resolveSandboxGatewayName(sandboxEntry);
  } catch {
    log("Post-delete reconciliation could not resolve the recorded sandbox gateway.");
    return { state: "ambiguous", phase: null, status: null };
  }

  let probe: ReturnType<typeof runOpenshell>;
  try {
    probe = runOpenshell(["sandbox", "get", "-g", gatewayName, sandboxName], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: OPENSHELL_PROBE_TIMEOUT_MS,
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
    backupManifest,
    log,
    bail,
    relockShieldsIfNeeded,
    validateAfterMcpPreparation,
    onDeleted,
  } = input;
  const gatewayName = resolveSandboxGatewayName(input.sandboxEntry);

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
        relockShieldsIfNeeded,
        bail,
      );
      return preparation;
    },
    afterPrepare: async (preparation) => {
      // MCP preparation removes only adapter entries whose exact ownership
      // fingerprints match the registry. Probe afterward so a Deep Agents
      // user `.mcp.json` is not confused with the separate managed projection.
      // This can block on SSH, so it must finish before the final DCode check.
      if (!staleRecovery) warnUnpreservedUserManagedFiles(sandboxName, log);
      if (validateAfterMcpPreparation) {
        let validation: RebuildDeleteValidationResult;
        try {
          validation = await validateAfterMcpPreparation();
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
        );
        relockShieldsIfNeeded(true);
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
  const rebuildMcpEntries = mcpPreparation.entries;
  const rebuildDetachedMcpProviderEntries = mcpPreparation.detachedProviderEntries;
  const rebuildScrubbedMcpAdapterEntries = mcpPreparation.scrubbedAdapterEntries;

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
      relockShieldsIfNeeded(true);
      const detail = error instanceof Error ? error.message : String(error);
      bail(
        `Failed to revalidate read-only MCP recovery before sandbox deletion: ${redactFull(detail)}`,
      );
      return null;
    }
  }

  log(`Running: openshell sandbox delete -g ${gatewayName} ${sandboxName}`);
  const deleteResult = runOpenshell(["sandbox", "delete", "-g", gatewayName, sandboxName], {
    ignoreError: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const { alreadyGone } = getSandboxDeleteOutcome(deleteResult);
  log(`Delete result: exit=${deleteResult.status}, alreadyGone=${alreadyGone}`);
  let deletionConfirmed = alreadyGone;
  if (deleteResult.status !== 0) {
    const reconciledDelete = reconcileFailedSandboxDelete(sandboxName, input.sandboxEntry, log);
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
      );
      if (mcpRecoveryFailure) {
        console.error(
          `  Failed to reattach MCP providers to the existing sandbox: ${mcpRecoveryFailure}`,
        );
      }
      if (backupManifest) {
        console.error("  State backup is preserved at: " + backupManifest.backupPath);
      }
      relockShieldsIfNeeded(true);
      bail(
        mcpRecoveryFailure
          ? `Failed to delete sandbox; MCP provider recovery also failed: ${mcpRecoveryFailure}`
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
  deletionConfirmed ||= waitForSandboxDeletion(sandboxName, gatewayName, log);
  if (!deletionConfirmed) {
    console.error(
      "  Sandbox delete was accepted, but OpenShell did not confirm that the sandbox is absent.",
    );
    console.error("  Aborting rebuild before registry removal and sandbox recreation.");
    if (backupManifest) {
      console.error("  State backup is preserved at: " + backupManifest.backupPath);
    }
    bail("Sandbox deletion could not be confirmed.");
    return null;
  }
  stopNimBestEffort();
  onDeleted();
  let removalReceipt: registry.SandboxRemovalReceipt | null = null;
  if (rebuildMcpEntries.length === 0) {
    removalReceipt = removeSandboxRegistryEntryWithReceipt(sandboxName);
  } else {
    // The registry entry is the durable MCP rebuild transaction. The inner
    // onboard run observes that the sandbox is absent, carries the MCP state
    // into the replacement registration, and never enters generic live
    // recreation. Keeping it here closes every process-death window between
    // successful delete and fresh registry registration.
    log("Preserving MCP-bearing registry entry across sandbox recreation");
  }
  log(
    `Registry after remove: ${JSON.stringify(registry.listSandboxes().sandboxes.map((s: { name: string }) => s.name))}`,
  );
  console.log(`  ${G}\u2713${R} Old sandbox deleted`);

  return { ...mcpPreparation, removalReceipt };
}
