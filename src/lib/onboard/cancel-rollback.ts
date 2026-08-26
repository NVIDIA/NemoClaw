// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Re-exported so the onboard entrypoint imports its sandbox default/cancel
// lifecycle helpers from a single module.
export { restoreDefaultAfterRecreate, wasSandboxDefault } from "./default-preservation";

/**
 * Rollback guard for a sandbox that was created during onboarding but whose
 * onboarding was cancelled before the policy-preset step was confirmed.
 *
 * Without this, pressing Ctrl+C at the `[8/8] Policy presets` screen leaves a
 * fully created OpenShell container registered as the default sandbox even
 * though no policies were ever applied (#4614).
 *
 * The guard is deliberately a two-key gate — it only fires when BOTH:
 *   - a freshly-created sandbox is `arm()`ed (set after createSandbox succeeds), AND
 *   - the operator actually cancelled via `markCancelled()` (the policy-step
 *     prompts call this on Ctrl+C / SIGTERM before exiting).
 *
 * This keeps every other `process.exit(1)` failure path untouched: a genuine
 * build/verify failure exits without `markCancelled()`, so the sandbox it left
 * behind is preserved exactly as before. Only an explicit cancel rolls back.
 */
export interface SandboxCancelRollbackDeps {
  /** Emit an operator-facing line (stderr). */
  log(message: string): void;
}

export interface SandboxCancelRollback {
  /** Arm rollback for a just-created sandbox. */
  arm(sandboxName: string, sandboxIdentityFingerprint?: string): void;
  /** Disarm once the sandbox is past the cancellable window (policies confirmed). */
  disarm(): void;
  /** Record that the operator cancelled at a cancellable step. */
  markCancelled(): void;
  /** Run the rollback iff armed AND cancelled. Idempotent. */
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
 * Wire a sandbox cancel-rollback to OpenShell + the registry and register the
 * process-exit hook that fires it. Kept here (not in onboard.ts) so the
 * orchestration lives in a focused module rather than the onboard entrypoint.
 *
 * `process.exit()` — how the policy-step prompts terminate on Ctrl+C —
 * synchronously emits 'exit', so the recovery notice completes inside the
 * handler. No-op unless armed AND cancelled.
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
 * Build the cancel handler the policy-step prompts run on Ctrl+C / SIGTERM:
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
