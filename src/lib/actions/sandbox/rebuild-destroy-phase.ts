// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { captureOpenshell, runOpenshell } from "../../adapters/openshell/runtime";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import { G, R } from "../../cli/terminal-style";
import { waitUntil } from "../../core/wait";
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
import { blockRebuildOnPendingBaselineTransition } from "./rebuild-preflight-guards";

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
  };
  now?: () => number;
  sleep?: (milliseconds: number) => void;
}

const REBUILD_DELETE_ABSENCE_MAX_ATTEMPTS = 20;
const REBUILD_DELETE_ABSENCE_INITIAL_INTERVAL_MS = 250;
const REBUILD_DELETE_ABSENCE_MAX_INTERVAL_MS = 1_000;
const MISSING_SANDBOX_GET_OUTPUT =
  /\b(?:no such sandbox|sandbox(?:\s+['"`]?[A-Za-z0-9._-]+['"`]?)?\s+(?:(?:was|is)\s+)?(?:not found|not present|does not exist|has no spec))\b/i;

/** Wait for explicit absence from the same `sandbox get` boundary used by inner onboard. */
export function waitForRebuildDeleteAbsence(
  sandboxName: string,
  log: RebuildLog,
  deps: RebuildDeleteAbsenceDeps = {},
): boolean {
  const now = deps.now ?? Date.now;
  const deadlineMs = now() + OPENSHELL_PROBE_TIMEOUT_MS;
  const captureSandboxGet =
    deps.captureSandboxGet ??
    ((name: string, timeoutMs: number) => {
      const probe = captureOpenshell(["sandbox", "get", name], {
        ignoreError: true,
        includeStderr: true,
        includeStreams: true,
        timeout: timeoutMs,
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
        probe.status !== null &&
        probe.status !== 0 &&
        MISSING_SANDBOX_GET_OUTPUT.test(combinedOutput)
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

  if (blockRebuildOnPendingBaselineTransition(input.sandboxEntry, sandboxName, bail)) return null;

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
  const deletionConfirmed = alreadyGone || waitForRebuildDeleteAbsence(sandboxName, log);
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
  onDeleted();
  let removalReceipt: registry.SandboxRemovalReceipt | null = null;
  const hasBaselineExclusions = (input.sandboxEntry.baselineExclusions?.length ?? 0) > 0;
  if (rebuildMcpEntries.length === 0 && !hasBaselineExclusions) {
    removalReceipt = removeSandboxRegistryEntryWithReceipt(sandboxName);
  }
  if (rebuildMcpEntries.length > 0) {
    // The registry entry is the durable MCP rebuild transaction. The inner
    // onboard run observes that the sandbox is absent, carries the MCP state
    // into the replacement registration, and never enters generic live
    // recreation. Keeping it here closes every process-death window between
    // successful delete and fresh registry registration.
    log("Preserving MCP-bearing registry entry across sandbox recreation");
  }
  if (hasBaselineExclusions) {
    // Baseline exclusions are also registry-only rebuild intent. Keep the row
    // until inner onboard snapshots it and replacement registration atomically
    // publishes the fresh row.
    log("Preserving baseline-exclusion registry entry across sandbox recreation");
  }
  log(
    `Registry after remove: ${JSON.stringify(registry.listSandboxes().sandboxes.map((s: { name: string }) => s.name))}`,
  );
  console.log(`  ${G}\u2713${R} Old sandbox deleted`);

  return { ...mcpPreparation, removalReceipt };
}
