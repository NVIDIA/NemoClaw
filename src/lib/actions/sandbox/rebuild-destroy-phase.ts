// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshell } from "../../adapters/openshell/runtime";
import { G, R } from "../../cli/terminal-style";
import { getSandboxDeleteOutcome } from "../../domain/sandbox/destroy";
import * as nim from "../../inference/nim";
import { redactFull } from "../../security/redact";
import * as registry from "../../state/registry";
import { removeSandboxRegistryEntryWithReceipt } from "./destroy";
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
  validateAfterMcpPreparation?: () => Promise<RebuildDeleteValidationResult>;
  onDeleted: () => void;
}

export type RebuildDestroyPhaseResult = McpRebuildPreparation & {
  removalReceipt: registry.SandboxRemovalReceipt | null;
};

/**
 * Detach owned MCP state, stop inference, and delete the old sandbox.
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

  // Step 3: Delete sandbox without tearing down gateway or session.
  // sandboxDestroy() cleans up the gateway when it's the last sandbox and
  // nulls session.sandboxName — both break the immediate onboard --resume.
  console.log("  Deleting old sandbox...");
  const sbMeta = registry.getSandbox(sandboxName);
  log(
    `Registry entry: agent=${sbMeta?.agent}, agentVersion=${sbMeta?.agentVersion}, nimContainer=${sbMeta?.nimContainer}`,
  );
  const mcpPreparation = await prepareMcpBeforeBestEffortNimStop({
    prepareMcp: () => prepareMcpForRebuild(sandboxName, staleRecovery, relockShieldsIfNeeded, bail),
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
    stopNim: () => {
      if (sbMeta && sbMeta.nimContainer) {
        log(`Stopping NIM container: ${sbMeta.nimContainer}`);
        nim.stopNimContainerByName(sbMeta.nimContainer);
      } else {
        // Best-effort cleanup — see comment in sandboxDestroy.
        nim.stopNimContainer(sandboxName, { silent: true });
      }
    },
    log,
  });
  if (!mcpPreparation) return null;
  const rebuildMcpEntries = mcpPreparation.entries;
  const rebuildDetachedMcpProviderEntries = mcpPreparation.detachedProviderEntries;
  const rebuildScrubbedMcpAdapterEntries = mcpPreparation.scrubbedAdapterEntries;

  log(`Running: openshell sandbox delete ${sandboxName}`);
  const deleteResult = runOpenshell(["sandbox", "delete", sandboxName], {
    ignoreError: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const { alreadyGone } = getSandboxDeleteOutcome(deleteResult);
  log(`Delete result: exit=${deleteResult.status}, alreadyGone=${alreadyGone}`);
  if (deleteResult.status !== 0 && !alreadyGone) {
    console.error("  Failed to delete sandbox. Aborting rebuild.");
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
  }
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
