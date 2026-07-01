// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshell } from "../../adapters/openshell/runtime";
import { G, R } from "../../cli/terminal-style";
import { getSandboxDeleteOutcome } from "../../domain/sandbox/destroy";
import * as nim from "../../inference/nim";
import * as registry from "../../state/registry";
import { removeSandboxRegistryEntry } from "./destroy";
import type { RebuildBackupManifest } from "./rebuild-backup-phase";
import type { RebuildBail, RebuildLog } from "./rebuild-credential-preflight";
import { type RebuildSandboxEntry, warnUnpreservedUserManagedFiles } from "./rebuild-flow-helpers";
import { prepareMcpBeforeBestEffortNimStop } from "./rebuild-mcp-order";
import {
  type McpRebuildPreparation,
  prepareMcpForRebuild,
  reattachMcpAfterDeleteFailure,
} from "./rebuild-mcp-phase";

export interface RebuildDestroyPhaseInput {
  sandboxName: string;
  sandboxEntry: RebuildSandboxEntry;
  staleRecovery: boolean;
  backupManifest: RebuildBackupManifest;
  log: RebuildLog;
  bail: RebuildBail;
  relockShieldsIfNeeded: (sandboxStillExists: boolean) => boolean;
  onDeleted: () => void;
}

/**
 * Detach owned MCP state, stop inference, and delete the old sandbox.
 * Boundary coverage: rebuild-flow.test.ts exercises success, stale recovery,
 * delete failure, provider reattach failure, and MCP-bearing registry retention.
 */
export async function runRebuildDestroyPhase(
  input: RebuildDestroyPhaseInput,
): Promise<McpRebuildPreparation | null> {
  const {
    sandboxName,
    staleRecovery,
    backupManifest,
    log,
    bail,
    relockShieldsIfNeeded,
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
  // MCP preparation removes only adapter entries whose exact ownership
  // fingerprints match the registry. Probe afterward so a Deep Agents
  // `.mcp.json` containing only NemoClaw-managed entries is not mislabeled as
  // unpreserved user state; any file that remains still needs the warning.
  if (!staleRecovery) warnUnpreservedUserManagedFiles(sandboxName, log);
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
  if (rebuildMcpEntries.length === 0) {
    removeSandboxRegistryEntry(sandboxName);
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

  return mcpPreparation;
}
