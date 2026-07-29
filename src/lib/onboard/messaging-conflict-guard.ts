// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-commit messaging channel conflict guard for the onboard entrypoint.
 *
 * Extracted from `onboard.ts` to keep that oversized entrypoint from growing.
 * It keeps the credential-scoped conflict guard shared, then runs
 * channel-owned `pre-enable` hooks for checks that belong to a concrete
 * messaging channel.
 *
 * Dependencies are injected so the orchestration is unit-testable without a
 * live gateway or the onboard module's global state.
 */

import type { ConflictRegistry, ConflictRegistryEntry } from "../messaging/applier";
import {
  createMessagingPreEnableHookInputs,
  findChannelConflictsFromPlan,
  getActiveChannelIdsFromPlan,
  MessagingSetupApplier,
} from "../messaging/applier";
import { createBuiltInChannelManifestRegistry } from "../messaging/channels/built-ins";
import {
  createBuiltInMessagingHookRegistry,
  isMessagingHookConflictError,
  runMessagingHook,
} from "../messaging/hooks";
import type { MessagingChannelId, SandboxMessagingPlan } from "../messaging/manifest";

export interface MessagingConflictGuardDeps {
  readonly sandboxName: string;
  /** Resolved OpenShell gateway registration name for this onboard (#4422). */
  readonly gatewayName: string;
  /** Compiled messaging plan for the current run, or null when none applies. */
  readonly currentPlan: SandboxMessagingPlan | null;
  /**
   * Channels this sandbox has stopped (`channels stop`). The compiled env plan
   * still lists them as configured, but they will not be re-registered with the
   * gateway, so a stopped channel must not count as an active consumer for
   * conflict detection.
   */
  readonly currentSandboxDisabledChannels?: readonly string[];
  /** Registry facade: list/update sandboxes (state/registry satisfies this). */
  readonly registry: ConflictRegistry & {
    listSandboxes: () => { sandboxes: ConflictRegistryEntry[]; defaultSandbox?: string | null };
  };
  readonly isNonInteractive: () => boolean;
  /** Interactive "Continue anyway?" prompt; resolves true to proceed. */
  readonly promptContinue: () => Promise<boolean>;
  readonly cliName: () => string;
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
  /** Abort the onboard. Defaults to `process.exit`; injectable for tests. */
  readonly exit?: (code: number) => never;
}

function abort(deps: MessagingConflictGuardDeps): never {
  return (deps.exit ?? ((code: number) => process.exit(code)))(1);
}

function abortIncompleteConflictCheck(
  deps: MessagingConflictGuardDeps,
  check: string,
  error: unknown,
): never {
  const message = error instanceof Error ? error.message : String(error);
  deps.error(`  Could not verify ${check}: ${message}`);
  deps.error(
    "  Aborting: restore messaging registry access and rerun. Onboarding and rebuild do not support a conflict override.",
  );
  return abort(deps);
}

function findChannelsWithIncompleteCredentialHashes(plan: SandboxMessagingPlan): string[] {
  const activeChannelIds = new Set(getActiveChannelIdsFromPlan(plan));
  const manifestRegistry = createBuiltInChannelManifestRegistry();

  return [...activeChannelIds].filter((channelId) => {
    const manifest = manifestRegistry.get(channelId as MessagingChannelId);
    return manifest?.credentials.some((credential) => {
      const binding = plan.credentialBindings.find(
        (entry) =>
          entry.channelId === channelId && entry.providerEnvKey === credential.providerEnvKey,
      );
      return !binding?.credentialHash;
    });
  });
}

/**
 * Run both conflict axes and abort when a hard conflict is found. Calls the
 * injected `exit` and never returns when a credential conflict or an
 * abort-on-failure hook conflict is found.
 */
export async function enforceMessagingChannelConflicts(
  deps: MessagingConflictGuardDeps,
): Promise<void> {
  const { sandboxName, registry } = deps;

  // Fold channels stopped on this sandbox into the plan's disabled set so every
  // conflict axis sees the *effective* (post-`channels stop`) channel list.
  // Both manifest hook filtering and `planToConflictChannelRequests` already
  // honor `plan.disabledChannels`, so this single fold covers both axes.
  const currentPlan: SandboxMessagingPlan | null = deps.currentPlan
    ? {
        ...deps.currentPlan,
        disabledChannels: [
          ...new Set([
            ...deps.currentPlan.disabledChannels,
            ...(deps.currentSandboxDisabledChannels ?? []),
          ]),
        ],
      }
    : null;

  // Axis 1: credential-scoped conflict (#1953). Every active credential-bearing
  // channel must carry complete hashes so onboarding and rebuild fail closed.
  if (currentPlan) {
    const incompleteChannels = findChannelsWithIncompleteCredentialHashes(currentPlan);
    if (incompleteChannels.length > 0) {
      deps.error(
        `  Could not verify messaging channel conflicts: credential hashes are unavailable for ${incompleteChannels.join(", ")}`,
      );
      deps.error(
        "  Aborting: provide the intended channel credentials and rerun. Onboarding and rebuild do not support a conflict override.",
      );
      abort(deps);
    }

    let conflicts: ReturnType<typeof findChannelConflictsFromPlan>;
    try {
      conflicts = findChannelConflictsFromPlan(sandboxName, currentPlan, registry);
    } catch (error) {
      abortIncompleteConflictCheck(deps, "messaging channel conflicts", error);
    }
    if (conflicts.length > 0) {
      for (const { channel, sandbox, reason } of conflicts) {
        const detail =
          reason === "matching-token"
            ? `uses the same ${channel} credential`
            : `already has ${channel} enabled, but its credential hash is unavailable`;
        const message = `Sandbox '${sandbox}' ${detail}. Shared channel credentials only allow one sandbox to poll/connect.`;
        deps.error(`  Conflict: ${message}`);
      }
      deps.error(
        `  Aborting: resolve the messaging channel conflict above or run \`${deps.cliName()} <sandbox> channels stop <channel>\` / \`${deps.cliName()} <sandbox> channels remove <channel>\` on the other sandbox.`,
      );
      abort(deps);
    }
  }

  // Axis 2: channel-owned pre-enable checks. These may run even when credential
  // hashes are unavailable because a channel may have a non-credential conflict
  // axis.
  if (currentPlan) {
    await enforceMessagingPreEnableHooks(deps, currentPlan);
  }
}

async function enforceMessagingPreEnableHooks(
  deps: MessagingConflictGuardDeps,
  currentPlan: SandboxMessagingPlan,
): Promise<void> {
  const requests = MessagingSetupApplier.listPreEnableChecks(currentPlan);
  if (requests.length === 0) return;

  const hookRegistry = createBuiltInMessagingHookRegistry();
  let registryEntries: ConflictRegistryEntry[];
  try {
    registryEntries = deps.registry.listSandboxes().sandboxes;
  } catch (error) {
    abortIncompleteConflictCheck(deps, "messaging pre-enable checks", error);
  }
  const additionalInputs = createMessagingPreEnableHookInputs({
    currentSandbox: deps.sandboxName,
    currentGatewayName: deps.gatewayName,
    registryEntries,
  });

  try {
    await MessagingSetupApplier.applyPreEnableChecks(currentPlan, {
      additionalInputs,
      runHook: (request) =>
        runMessagingHook(
          {
            id: request.hookId,
            phase: request.phase,
            handler: request.handler,
            inputs: request.inputKeys,
            outputs: request.outputs,
            onFailure: request.onFailure,
          },
          hookRegistry,
          {
            channelId: request.channelId,
            isInteractive: !deps.isNonInteractive(),
            inputs: request.inputs,
          },
        ),
    });
  } catch (error) {
    if (!isMessagingHookConflictError(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const abortOnFailure = error.onFailure === "abort";
    for (const line of message.split("\n").filter((entry) => entry.trim().length > 0)) {
      if (abortOnFailure) {
        deps.error(`  Conflict: ${line}`);
      } else {
        deps.log(`  ⚠ ${line}`);
      }
    }
    if (abortOnFailure) {
      deps.error(
        `  Aborting: resolve the messaging pre-enable conflict above or run \`${deps.cliName()} <sandbox> channels stop <channel>\` / \`${deps.cliName()} <sandbox> channels remove <channel>\` on the other sandbox.`,
      );
      abort(deps);
    }
    if (deps.isNonInteractive()) {
      deps.error(
        `  Aborting: resolve the messaging pre-enable conflict above or run \`${deps.cliName()} <sandbox> channels stop <channel>\` / \`${deps.cliName()} <sandbox> channels remove <channel>\` on the other sandbox.`,
      );
      abort(deps);
    }
    if (!(await deps.promptContinue())) {
      deps.log("  Aborting sandbox creation.");
      abort(deps);
    }
  }
}
