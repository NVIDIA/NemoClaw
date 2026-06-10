// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-commit messaging channel conflict guard for the onboard entrypoint.
 *
 * Extracted from `onboard.ts` to keep that oversized entrypoint from growing
 * (the codebase-growth guardrail blocks net additions to `src/lib/onboard.ts`;
 * logic under `src/lib/onboard/` is allowed to grow). It bundles the two
 * conflict axes that must be checked before a sandbox is committed:
 *
 *   1. **Credential-scoped** (`findChannelConflictsFromPlan`): another sandbox
 *      already uses one of this sandbox's channel credentials. Shared channel
 *      credentials (Telegram getUpdates, Discord gateway, Slack Socket Mode)
 *      only allow one consumer, so two sandboxes with the same token silently
 *      break both bridges (#1953).
 *
 *   2. **Gateway-scoped Slack Socket Mode** (`findSlackSocketModeGatewayConflicts`):
 *      even with distinct Slack apps/tokens, only one sandbox per OpenShell
 *      gateway reliably receives Socket Mode events. A second Slack sandbox on
 *      the same gateway is a silent black hole — NemoClaw reports its bridge
 *      healthy while events never arrive (#4953). This axis is independent of
 *      the credential check, which only catches a *shared* token.
 *
 * Dependencies are injected so the orchestration is unit-testable without a
 * live gateway or the onboard module's global state.
 */

import type { ConflictRegistry, ConflictRegistryEntry } from "../messaging/applier";
import {
  backfillMessagingChannels,
  createMessagingConflictProbe,
  findChannelConflictsFromPlan,
  findSlackSocketModeGatewayConflicts,
  formatSlackSocketModeConflictMessage,
  getActiveChannelIdsFromPlan,
} from "../messaging/applier";
import type { SandboxMessagingPlan } from "../messaging/manifest";

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
   * conflict detection — e.g. a stopped Slack bridge must not block another
   * sandbox on the same gateway (CodeRabbit, #4953).
   */
  readonly currentSandboxDisabledChannels?: readonly string[];
  /** Registry facade: list/update sandboxes (state/registry satisfies this). */
  readonly registry: ConflictRegistry & {
    listSandboxes: () => { sandboxes: ConflictRegistryEntry[]; defaultSandbox?: string | null };
  };
  /** `openshell sandbox list` succeeded — gateway answered (for backfill probe). */
  readonly checkGatewayLiveness: () => boolean;
  /** Whether the named OpenShell provider exists (gateway assumed alive). */
  readonly providerExists: (name: string) => boolean;
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

/**
 * Run both conflict axes and warn/abort/prompt as appropriate. Returns when it
 * is safe (or the operator chose) to proceed; calls the injected `exit` (and
 * never returns) when the operator aborts or non-interactive mode blocks.
 */
export async function enforceMessagingChannelConflicts(
  deps: MessagingConflictGuardDeps,
): Promise<void> {
  const { sandboxName, registry } = deps;

  // Fold channels stopped on this sandbox into the plan's disabled set so every
  // conflict axis sees the *effective* (post-`channels stop`) channel list. A
  // stopped bridge is not re-registered, so it is neither a credential consumer
  // (axis 1) nor a Socket Mode consumer (axis 2) and must not block another
  // sandbox. Both `getActiveChannelIdsFromPlan` and `planToConflictChannelRequests`
  // already honor `plan.disabledChannels`, so this single fold covers both axes
  // (CodeRabbit, #4953).
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

  // Axis 1: credential-scoped conflict (#1953). Only runs when the plan carries
  // an available credential hash to compare; backfill first so legacy entries
  // expose their active channels.
  const hasPlanCredentials =
    currentPlan?.credentialBindings.some((b) => b.credentialAvailable) ?? false;
  if (currentPlan && hasPlanCredentials) {
    const probe = createMessagingConflictProbe({
      checkGatewayLiveness: deps.checkGatewayLiveness,
      providerExists: deps.providerExists,
    });
    backfillMessagingChannels(registry, probe);
    const conflicts = findChannelConflictsFromPlan(sandboxName, currentPlan, registry);
    if (conflicts.length > 0) {
      for (const { channel, sandbox, reason } of conflicts) {
        const detail =
          reason === "matching-token"
            ? `uses the same ${channel} credential`
            : `already has ${channel} enabled, but its credential hash is unavailable`;
        deps.log(
          `  ⚠ Sandbox '${sandbox}' ${detail}. Shared channel credentials only allow one sandbox to poll/connect — continuing may break both bridges.`,
        );
      }
      if (deps.isNonInteractive()) {
        deps.error(
          `  Aborting: resolve the messaging channel conflict above or run \`${deps.cliName()} <sandbox> channels stop <channel>\` / \`${deps.cliName()} <sandbox> channels remove <channel>\` on the other sandbox.`,
        );
        abort(deps);
      }
      if (!(await deps.promptContinue())) {
        deps.log("  Aborting sandbox creation.");
        abort(deps);
      }
    }
  }

  // Axis 2: gateway-scoped Slack Socket Mode conflict (#4953). Runs whenever the
  // effective plan still enables Slack, regardless of credential availability,
  // because the conflict is the shared gateway, not the shared token.
  if (currentPlan && getActiveChannelIdsFromPlan(currentPlan).includes("slack")) {
    const slackConflicts = findSlackSocketModeGatewayConflicts(
      sandboxName,
      deps.gatewayName,
      registry.listSandboxes().sandboxes,
    );
    if (slackConflicts.length > 0) {
      for (const { sandbox } of slackConflicts) {
        deps.log(`  ⚠ ${formatSlackSocketModeConflictMessage(sandbox)}`);
      }
      if (deps.isNonInteractive()) {
        deps.error(
          `  Aborting: only one sandbox per gateway can receive Slack Socket Mode events. Run \`${deps.cliName()} <sandbox> channels stop slack\` / \`${deps.cliName()} <sandbox> channels remove slack\` on the other sandbox, or onboard this sandbox on a separate gateway (set NEMOCLAW_GATEWAY_PORT).`,
        );
        abort(deps);
      }
      if (!(await deps.promptContinue())) {
        deps.log("  Aborting sandbox creation.");
        abort(deps);
      }
    }
  }
}
