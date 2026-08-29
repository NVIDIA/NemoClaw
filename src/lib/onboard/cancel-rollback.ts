// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NEMOCLAW_CREATE_ATTEMPT_LABEL } from "../adapters/openshell/sandbox-identity";
import type { RetainedSandboxRecoveryContext } from "../state/onboard-session";
import { cliName } from "./branding";

// Re-exported so the onboard entrypoint imports its sandbox default/cancel
// lifecycle helpers from a single module.
export { restoreDefaultAfterRecreate, wasSandboxDefault } from "./default-preservation";

/**
 * Preservation guard for a sandbox whose onboarding is cancelled before the
 * policy tier and preset selection window is confirmed.
 *
 * Cancellation preserves the incomplete sandbox, registry entry, and onboarding
 * session. The guard emits identity-bound recovery guidance and never deletes a
 * sandbox by mutable name (#4614).
 *
 * The guard activates only when both conditions are true:
 *   - `arm()` records a newly created sandbox after `createSandbox` succeeds.
 *   - `markCancelled()` records Ctrl+C or SIGTERM at the policy-tier or either
 *     policy-preset selector.
 *
 * Other `process.exit(1)` failure paths do not call `markCancelled()`. Their
 * existing preservation behavior remains unchanged.
 */
export interface SandboxCancelRollbackDeps {
  /** Emit an operator-facing line (stderr). */
  log(message: string): void;
  /** Persist the recovery-only session before process exit completes. */
  recordRecovery?(
    sandboxName: string,
    sandboxIdentityFingerprint?: string,
    context?: RetainedSandboxRecoveryContext,
  ): void;
}

export interface SandboxCancelRollback {
  /** Arm cancellation recovery guidance for a just-created sandbox. */
  arm(
    sandboxName: string,
    sandboxIdentityFingerprint?: string,
    context?: RetainedSandboxRecoveryContext,
  ): void;
  /** Disarm once the sandbox is past the cancellable policy-selection window. */
  disarm(): void;
  /** Record that the operator cancelled at a cancellable step. */
  markCancelled(): void;
  /** Report preservation guidance iff armed AND cancelled. Idempotent. */
  runIfArmed(): void;
  /** Test/introspection helper. */
  isArmed(): boolean;
}

export function buildCancelRollbackMessage(
  sandboxName: string,
  sandboxIdentityFingerprint?: string,
  recoveryContext?: Pick<RetainedSandboxRecoveryContext, "createAttemptNonce">,
): string[] {
  return [
    "",
    `  Onboarding cancelled — preserved incomplete sandbox '${sandboxName}'.`,
    ...(recoveryContext
      ? [
          `  Create-attempt label: ${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${recoveryContext.createAttemptNonce}`,
        ]
      : []),
    ...(sandboxIdentityFingerprint
      ? [
          `  Durable sandbox identity fingerprint: ${sandboxIdentityFingerprint}`,
          "  Preserve this fingerprint for identity-bound inspection, recovery, or removal.",
        ]
      : [
          "  Its durable identity fingerprint is unavailable; preserve the registry and onboarding recovery state.",
          "  Ask an OpenShell administrator to establish the exact sandbox identity before recovery or removal.",
        ]),
    "  NemoClaw did not run OpenShell's mutable-name deletion command because the name may now identify a replacement sandbox.",
    "  Do not delete the sandbox by mutable sandbox name.",
    "  Shared inference providers are gateway configuration and are not sandbox cleanup targets.",
    ...(sandboxIdentityFingerprint
      ? [
          `  Run '${cliName()} ${sandboxName} destroy'. If OpenShell confirms the retained sandbox absent, destroy removes only verified residual containers and can clear the matching recovery record.`,
          recoveryContext
            ? "  If it is still live, give the displayed create-attempt label to an OpenShell administrator for identity-bound removal."
            : "  If it is still live, preserve the displayed fingerprint and ask an OpenShell administrator for identity-bound removal.",
        ]
      : [
          "  NemoClaw cannot clear this recovery record until an OpenShell administrator establishes the exact sandbox identity.",
        ]),
  ];
}

export interface InstallSandboxCancelRollbackOptions {
  log?: (message: string) => void;
  recordRecovery?: SandboxCancelRollbackDeps["recordRecovery"];
  /** Override for tests; defaults to `process.on("exit", ...)`. */
  registerExitHandler?: (handler: () => void) => void;
}

/**
 * Register the process-exit hook that emits cancellation recovery guidance.
 * Keep this orchestration outside the onboard entrypoint.
 *
 * Policy-step prompts use `process.exit()` for Ctrl+C. It synchronously emits
 * `exit`, so the handler reports the recovery guidance before exit completes.
 * The handler does nothing unless it is armed and the operator cancels.
 */
export function installSandboxCancelRollback(
  opts: InstallSandboxCancelRollbackOptions = {},
): SandboxCancelRollback {
  const rollback = createSandboxCancelRollback({
    log: opts.log ?? ((message) => console.error(message)),
    recordRecovery: opts.recordRecovery,
  });
  const register =
    opts.registerExitHandler ??
    ((handler: () => void) => {
      process.on("exit", handler);
    });
  register(() => rollback.runIfArmed());
  return rollback;
}

/**
 * Build the cancel handler the policy-selection prompts run on Ctrl+C / SIGTERM:
 * restore the terminal (`cleanup`), record the cancel, then exit non-zero.
 * Shared so both the tier and preset selectors stay in sync.
 */
export function makeOnboardCancelExit(
  rollback: Pick<SandboxCancelRollback, "markCancelled">,
  cleanup: () => void,
  exit: (code: number) => void = (code) => process.exit(code),
): () => void {
  return () => {
    cleanup();
    rollback.markCancelled();
    exit(1);
  };
}

export function createSandboxCancelRollback(
  deps: SandboxCancelRollbackDeps,
): SandboxCancelRollback {
  let armedSandbox: {
    readonly name: string;
    readonly identityFingerprint: string | null;
    readonly context: RetainedSandboxRecoveryContext | undefined;
  } | null = null;
  let cancelRequested = false;
  let recoveryRecorded = false;
  let recoveryPersistenceFailed = false;
  let guidanceReported = false;
  let done = false;

  const recordArmedRecovery = (): boolean => {
    if (recoveryRecorded) return true;
    if (armedSandbox === null) return false;
    try {
      deps.recordRecovery?.(
        armedSandbox.name,
        armedSandbox.identityFingerprint ?? undefined,
        armedSandbox.context,
      );
      recoveryRecorded = true;
      recoveryPersistenceFailed = false;
      return true;
    } catch {
      recoveryPersistenceFailed = true;
      return false;
    }
  };

  return {
    arm(
      sandboxName: string,
      sandboxIdentityFingerprint?: string,
      context?: RetainedSandboxRecoveryContext,
    ): void {
      armedSandbox = {
        name: sandboxName,
        identityFingerprint:
          typeof sandboxIdentityFingerprint === "string" &&
          /^[0-9a-f]{64}$/u.test(sandboxIdentityFingerprint)
            ? sandboxIdentityFingerprint
            : null,
        context,
      };
    },
    disarm(): void {
      armedSandbox = null;
    },
    markCancelled(): void {
      cancelRequested = true;
      // Persist before requesting process exit. This also covers callers that
      // defer the real exit and prevents later exit handlers from replacing
      // the recovery-only marker with an ordinary resumable failure.
      recordArmedRecovery();
    },
    isArmed(): boolean {
      return armedSandbox !== null;
    },
    runIfArmed(): void {
      if (done || !cancelRequested || armedSandbox === null) return;
      const { name: sandboxName, identityFingerprint } = armedSandbox;
      const persisted = recordArmedRecovery();
      if (!guidanceReported) {
        guidanceReported = true;
        if (recoveryPersistenceFailed) {
          deps.log(
            "  NemoClaw could not save the onboarding recovery record; preserve the registry entry and exact sandbox identity for administrator recovery.",
          );
        }
        for (const line of buildCancelRollbackMessage(
          sandboxName,
          identityFingerprint ?? undefined,
          armedSandbox.context,
        )) {
          deps.log(line);
        }
      }
      if (!persisted) return;
      done = true;
      armedSandbox = null;
    },
  };
}
