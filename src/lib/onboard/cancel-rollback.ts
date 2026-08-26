// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
}

export interface SandboxCancelRollback {
  /** Arm cancellation recovery guidance for a just-created sandbox. */
  arm(sandboxName: string, sandboxIdentityFingerprint?: string): void;
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
): string[] {
  return [
    "",
    `  Onboarding cancelled — preserved incomplete sandbox '${sandboxName}' because OpenShell cannot delete it by immutable identity.`,
    ...(sandboxIdentityFingerprint
      ? [
          `  Durable sandbox identity fingerprint: ${sandboxIdentityFingerprint}`,
          "  Preserve this fingerprint and give it to an OpenShell administrator for identity-bound recovery or removal.",
        ]
      : [
          "  Its durable identity fingerprint is unavailable; preserve the registry and onboarding recovery state.",
          "  Ask an OpenShell administrator to establish the immutable sandbox identity before recovery or removal.",
        ]),
    "  Do not delete the sandbox by mutable sandbox name.",
  ];
}

export interface InstallSandboxCancelRollbackOptions {
  log?: (message: string) => void;
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
  opts: InstallSandboxCancelRollbackOptions,
): SandboxCancelRollback {
  const rollback = createSandboxCancelRollback({
    log: opts.log ?? ((message) => console.error(message)),
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
  } | null = null;
  let cancelRequested = false;
  let done = false;

  return {
    arm(sandboxName: string, sandboxIdentityFingerprint?: string): void {
      armedSandbox = {
        name: sandboxName,
        identityFingerprint:
          typeof sandboxIdentityFingerprint === "string" &&
          /^[0-9a-f]{64}$/u.test(sandboxIdentityFingerprint)
            ? sandboxIdentityFingerprint
            : null,
      };
    },
    disarm(): void {
      armedSandbox = null;
    },
    markCancelled(): void {
      cancelRequested = true;
    },
    isArmed(): boolean {
      return armedSandbox !== null;
    },
    runIfArmed(): void {
      if (done || !cancelRequested || armedSandbox === null) return;
      done = true;
      const { name: sandboxName, identityFingerprint } = armedSandbox;
      armedSandbox = null;
      for (const line of buildCancelRollbackMessage(
        sandboxName,
        identityFingerprint ?? undefined,
      )) {
        deps.log(line);
      }
    },
  };
}
