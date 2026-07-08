// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Rebuild-time messaging credential conflict preflight (#5954).
 *
 * A `channels start`/rebuild that shares a messaging credential (e.g. the same
 * Microsoft Teams app) with another sandbox used to surface the conflict only
 * during the recreate (`onboard --resume`) phase — i.e. AFTER the original
 * sandbox had already been backed up and destroyed. The recreate then aborted
 * on the conflict, leaving the sandbox permanently lost with only a manual
 * snapshot-restore recovery path. That is a regression of the rebuild
 * non-atomicity boundary (#2273): a failed preflight must occur before any
 * destructive backup/delete.
 *
 * Running the shared conflict guard here, against the already-staged rebuild
 * plan and before backup/delete, aborts with the sandbox still intact.
 *
 * The guard is run with non-interactive (abort-on-conflict) semantics on
 * purpose: the downstream recreate already runs it non-interactively, so an
 * interactive "continue anyway" could never have survived the recreate guard
 * anyway. Aborting before destroy is therefore both safe and faithful to the
 * effective behavior, and it avoids leaving a half-destroyed sandbox.
 */

import type { SandboxMessagingPlan } from "../../messaging/manifest";
import {
  enforceMessagingChannelConflicts as defaultEnforceMessagingChannelConflicts,
  type MessagingConflictGuardDeps,
} from "../../onboard/messaging-conflict-guard";

export interface RebuildMessagingConflictPreflightDeps {
  readonly sandboxName: string;
  /** OpenShell gateway registration name this sandbox is bound to. */
  readonly gatewayName: string;
  readonly registry: MessagingConflictGuardDeps["registry"];
  readonly cliName: () => string;
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
  /**
   * Abort the rebuild while leaving the sandbox intact (rebuild's `bail`).
   * Must not return — it either throws or exits the process.
   */
  readonly bail: (message: string, code?: number) => never;
  /** Injectable for tests; defaults to the shared onboard conflict guard. */
  readonly enforceMessagingChannelConflicts?: (deps: MessagingConflictGuardDeps) => Promise<void>;
}

export async function preflightRebuildMessagingConflicts(
  plan: SandboxMessagingPlan | null,
  deps: RebuildMessagingConflictPreflightDeps,
): Promise<void> {
  if (!plan) return;

  const enforce = deps.enforceMessagingChannelConflicts ?? defaultEnforceMessagingChannelConflicts;

  await enforce({
    sandboxName: deps.sandboxName,
    gatewayName: deps.gatewayName,
    currentPlan: plan,
    // The staged plan already carries this sandbox's `channels stop` set in
    // `plan.disabledChannels`, which the guard folds in; nothing extra to add.
    registry: deps.registry,
    isNonInteractive: () => true,
    promptContinue: async () => false,
    cliName: deps.cliName,
    log: deps.log,
    error: deps.error,
    exit: (code: number) => deps.bail("Rebuild aborted: messaging channel conflict.", code),
  });
}
