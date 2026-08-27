// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Re-exported so the onboard entrypoint imports its sandbox default/cancel
// lifecycle helpers from a single module.
export { restoreDefaultAfterRecreate, wasSandboxDefault } from "./default-preservation";

/**
 * Recovery guard for a sandbox that was created during onboarding but whose
 * onboarding was cancelled before the policy-preset step was confirmed.
 *
 * OpenShell can destroy a sandbox only by mutable name. Cancellation therefore
 * preserves the sandbox, registry entry, and onboarding session for
 * identity-bound recovery (#9833).
 *
 * The guard is deliberately a two-key gate — it only fires when BOTH:
 *   - a freshly-created sandbox is `arm()`ed (set after createSandbox succeeds), AND
 *   - the operator actually cancelled via `markCancelled()` (the policy-step
 *     prompts call this on Ctrl+C / SIGTERM before exiting).
 *
 * This keeps every other `process.exit(1)` failure path untouched. A genuine
 * build or verification failure exits without `markCancelled()`.
 */
export interface SandboxCancelRollbackDeps {
  /** Emit an operator-facing line (stderr). */
  log(message: string): void;
  /** Agent-specific CLI name used for the recovery command. */
  cliName: string;
}

export interface SandboxCancelRollback {
  /** Arm rollback for a just-created sandbox. */
  arm(sandboxName: string): void;
  /** Disarm once the sandbox is past the cancellable window (policies confirmed). */
  disarm(): void;
  /** Record that the operator cancelled at a cancellable step. */
  markCancelled(): void;
  /** Run the rollback iff armed AND cancelled. Idempotent. */
  runIfArmed(): void;
  /** Test/introspection helper. */
  isArmed(): boolean;
}

export function buildCancelRollbackMessage(sandboxName: string, cliName: string): string[] {
  return [
    "",
    `  Onboarding cancelled — preserved incomplete sandbox '${sandboxName}' because OpenShell cannot bind sandbox destruction to its durable identity.`,
    "  Preserve its sandbox registry entry and onboarding session for identity-bound recovery.",
    `  Run \`${cliName} onboard --resume\` to continue the saved onboarding session.`,
    "  Do not destroy this sandbox by mutable sandbox name.",
  ];
}

export interface InstallSandboxCancelRollbackOptions {
  cliName?: string;
  log?: (message: string) => void;
  /** Override for tests; defaults to `process.on("exit", ...)`. */
  registerExitHandler?: (handler: () => void) => void;
}

/**
 * Register the process-exit hook for sandbox cancellation recovery. Kept here
 * so the orchestration lives in a focused module rather than the onboard
 * entrypoint.
 *
 * `process.exit()` synchronously emits `exit`. The handler records recovery
 * guidance only when the guard is armed and the operator cancelled.
 */
export function installSandboxCancelRollback(
  opts: InstallSandboxCancelRollbackOptions = {},
): SandboxCancelRollback {
  const rollback = createSandboxCancelRollback({
    cliName: opts.cliName ?? "nemoclaw",
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
  let armedSandboxName: string | null = null;
  let cancelRequested = false;
  let done = false;

  return {
    arm(sandboxName: string): void {
      armedSandboxName = sandboxName;
    },
    disarm(): void {
      armedSandboxName = null;
    },
    markCancelled(): void {
      cancelRequested = true;
    },
    isArmed(): boolean {
      return armedSandboxName !== null;
    },
    runIfArmed(): void {
      if (done || !cancelRequested || armedSandboxName === null) return;
      done = true;
      const sandboxName = armedSandboxName;
      armedSandboxName = null;

      for (const line of buildCancelRollbackMessage(sandboxName, deps.cliName)) {
        deps.log(line);
      }
    },
  };
}
