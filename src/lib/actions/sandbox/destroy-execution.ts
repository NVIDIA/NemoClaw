// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { R, YW } from "../../cli/terminal-style";
import { getSandboxDeleteOutcome } from "../../domain/sandbox/destroy";
import {
  type DetachSandboxProvidersResult,
  runSandboxProviderPreDeleteCleanup,
} from "../../onboard/sandbox-provider-cleanup";
import { redact } from "../../security/redact";
import { withTimerBoundShieldsMutationLockAsync } from "../../shields/timer-bound-lock";
import { readTimerMarker } from "../../shields/timer-control";
import type { SandboxEntry } from "../../state/registry";
import type { DestroyRunOpenshell } from "./destroy-gateway";
import {
  finalizeMcpBridgesAfterSandboxDelete,
  type McpDestroyPreparation,
  prepareMcpBridgesForAbsentSandboxDestroy,
  prepareMcpBridgesForDestroy,
  restoreMcpBridgesAfterDestroyAbort,
} from "./mcp-bridge";
import { wipeSandboxState } from "./wipe-state";

type SandboxDestroyExecutionInput = {
  cleanupShieldsArtifacts: (sandboxName: string) => void;
  force: boolean;
  runOpenshell: DestroyRunOpenshell;
  sandbox: SandboxEntry | null;
  sandboxConfirmedAbsent: boolean;
  sandboxName: string;
};

export type SandboxDestroyExecutionResult =
  | {
      ok: true;
      alreadyGone: boolean;
      deleteOutput: string;
      deleteResult: ReturnType<DestroyRunOpenshell>;
      detachOutcome: DetachSandboxProvidersResult;
      forcedLocalCleanup: boolean;
    }
  | {
      ok: false;
      deleteOutput: string;
      exitCode: number;
      gatewayUnreachable: boolean;
      mcpOwnershipRequiresGateway: boolean;
      mcpRecoveryFailure?: string;
    };

type HardenedDeleteState = {
  hardenedForDelete: boolean;
  timerProcessToken?: string;
};

function emptyMcpDestroyPreparation(): McpDestroyPreparation {
  return {
    entries: [],
    detachedProviderEntries: [],
    scrubbedAdapterEntries: [],
    destroyAlreadyPrepared: false,
    destroyAlreadyPending: false,
  };
}

async function prepareMcpDestroy(
  sandboxName: string,
  sandbox: SandboxEntry | null,
  sandboxConfirmedAbsent: boolean,
  force: boolean,
): Promise<McpDestroyPreparation> {
  if (Object.keys(sandbox?.mcp?.bridges ?? {}).length === 0) {
    return emptyMcpDestroyPreparation();
  }
  const preparation = sandboxConfirmedAbsent
    ? await prepareMcpBridgesForAbsentSandboxDestroy(sandboxName, { force })
    : await prepareMcpBridgesForDestroy(sandboxName);
  if (sandboxConfirmedAbsent && preparation.entries.length > 0) {
    console.warn(
      `  ${YW}⚠${R} Sandbox '${sandboxName}' is already absent, so its retained-volume MCP adapter entry cannot be scrubbed in place. Exact OpenShell providers will be deleted so any stale credential placeholder cannot authenticate; same-name onboarding may need to replace stale MCP adapter config.`,
    );
  }
  return preparation;
}

function wipeAndHardenLiveSandbox(
  sandboxName: string,
  sandboxConfirmedAbsent: boolean,
): HardenedDeleteState {
  if (sandboxConfirmedAbsent) return { hardenedForDelete: false };

  // Wipe before delete while the retained volume is still mounted. The caller
  // holds the timer-bound lock across this phase and all following teardown.
  wipeSandboxState(sandboxName);
  const timerMarker = readTimerMarker(sandboxName);
  if (!timerMarker) return { hardenedForDelete: false };

  const timerProcessToken = /^[0-9a-f]{32}$/.test(timerMarker.processToken ?? "")
    ? timerMarker.processToken
    : undefined;
  const { shieldsUp } = require("../../shields") as typeof import("../../shields");
  shieldsUp(sandboxName, {
    throwOnError: true,
    allowLegacyHermesProtocol: true,
  });
  return { hardenedForDelete: true, timerProcessToken };
}

async function restoreMcpAfterDeleteAbort(
  sandboxName: string,
  preparation: McpDestroyPreparation,
  hardened: HardenedDeleteState,
): Promise<string | undefined> {
  let recoveryFailure: string | undefined;
  let openedRollbackWindow = false;
  try {
    if (hardened.hardenedForDelete && preparation.entries.length > 0) {
      if (!hardened.timerProcessToken) {
        throw new Error(
          "Cannot open a bounded MCP rollback window because the active shields timer had no valid process token.",
        );
      }
      const { shieldsDown } = require("../../shields") as typeof import("../../shields");
      shieldsDown(sandboxName, {
        reason: "restore MCP after refused sandbox delete",
        timeout: "15m",
        throwOnError: true,
        allowLegacyHermesProtocol: true,
        deferAutoRestoreWhileOwnerAlive: true,
        processToken: hardened.timerProcessToken,
      });
      openedRollbackWindow = true;
    }
    await restoreMcpBridgesAfterDestroyAbort(sandboxName, preparation);
  } catch (error) {
    recoveryFailure = error instanceof Error ? error.message : String(error);
  } finally {
    if (openedRollbackWindow) {
      try {
        const { shieldsUp } = require("../../shields") as typeof import("../../shields");
        shieldsUp(sandboxName, {
          throwOnError: true,
          allowLegacyHermesProtocol: true,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        recoveryFailure = recoveryFailure
          ? `${recoveryFailure}; shields re-lock failed: ${detail}`
          : `shields re-lock failed: ${detail}`;
      }
    }
  }
  return recoveryFailure;
}

async function finalizeMcpDestroy(
  sandboxName: string,
  preparation: McpDestroyPreparation,
  force: boolean,
): Promise<void> {
  try {
    await finalizeMcpBridgesAfterSandboxDelete(sandboxName, preparation, { force });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      `  Sandbox '${sandboxName}' is gone, but authenticated MCP provider cleanup is incomplete: ${detail}`,
    );
    console.error(
      "  MCP cleanup state was preserved. Re-run destroy to finish without requiring the host MCP secret environment variable.",
    );
    throw error;
  }
}

export async function executeSandboxDestroy({
  cleanupShieldsArtifacts,
  force,
  runOpenshell,
  sandbox,
  sandboxConfirmedAbsent,
  sandboxName,
}: SandboxDestroyExecutionInput): Promise<SandboxDestroyExecutionResult> {
  return withTimerBoundShieldsMutationLockAsync(sandboxName, "destroy sandbox", async () => {
    const mcpPreparation = await prepareMcpDestroy(
      sandboxName,
      sandbox,
      sandboxConfirmedAbsent,
      force,
    );
    // Prepared-only/incomplete adds have no external resources and are safely
    // discarded during preparation. Remaining entries are the durable exact
    // provider ownership manifest and must survive an unconfirmed delete.
    const hasMcpOwnership = mcpPreparation.entries.length > 0;
    const hardened = wipeAndHardenLiveSandbox(sandboxName, sandboxConfirmedAbsent);
    const detachOutcome: DetachSandboxProvidersResult = sandboxConfirmedAbsent
      ? { detached: [], failures: [] }
      : runSandboxProviderPreDeleteCleanup(sandboxName, { runOpenshell, redact });
    const deleteResult = runOpenshell(["sandbox", "delete", sandboxName], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const {
      output: deleteOutput,
      alreadyGone,
      gatewayUnreachable,
    } = getSandboxDeleteOutcome(deleteResult);
    const forcedLocalCleanup =
      deleteResult.status !== 0 && !alreadyGone && gatewayUnreachable && force && !hasMcpOwnership;

    if (deleteResult.status !== 0 && !alreadyGone && !forcedLocalCleanup) {
      const mcpRecoveryFailure = sandboxConfirmedAbsent
        ? undefined
        : await restoreMcpAfterDeleteAbort(sandboxName, mcpPreparation, hardened);
      return {
        ok: false as const,
        deleteOutput,
        exitCode: deleteResult.status || 1,
        gatewayUnreachable,
        mcpOwnershipRequiresGateway: gatewayUnreachable && hasMcpOwnership,
        mcpRecoveryFailure,
      };
    }

    // The sandbox is confirmed gone, or --force is discarding only a local
    // record that has no MCP ownership. Keep this under the lifecycle lock so
    // stale timer state cannot target a same-name replacement.
    cleanupShieldsArtifacts(sandboxName);
    if (!forcedLocalCleanup) {
      await finalizeMcpDestroy(sandboxName, mcpPreparation, force);
    }
    return {
      ok: true as const,
      detachOutcome,
      deleteOutput,
      deleteResult,
      alreadyGone,
      forcedLocalCleanup,
    };
  });
}
