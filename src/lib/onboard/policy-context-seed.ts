// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Best-effort seed of the in-sandbox policy context file after the onboard
 * policy step. The refresh helper classifies the runtime outcome (`ok` /
 * `unreachable` / `failed` / `crashed`) and warns on `failed` paths; this
 * wrapper additionally guards against build-time regressions in the
 * require/build/render chain so any thrown error from those phases is logged
 * once on stderr instead of dropping the onboard run.
 *
 * The dynamic require avoids a circular import between the onboard module
 * and the actions/sandbox refresh helper (the latter depends on policy
 * registry code that policy-selection itself initialises). Tests inject the
 * refresh function via {@link SeedPolicyContextDeps} and never hit the
 * dynamic require path.
 */

export interface SeedPolicyContextDeps {
  /**
   * Concrete refresh implementation. Defaults to a dynamic require of
   * `../actions/sandbox/policy-context-refresh` so the dependency cycle is
   * broken at the import-time graph but tests can pass an in-memory fake.
   */
  refresh?: (sandboxName: string) => unknown;

  /**
   * Sink for the single-line log message emitted when {@link refresh}
   * throws. Defaults to `console.error` so the onboard transcript carries
   * the message without aborting the surrounding run.
   */
  logError?: (message: string) => void;
}

function defaultRefresh(sandboxName: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("../actions/sandbox/policy-context-refresh") as {
    refreshSandboxPolicyContextFile: (name: string) => unknown;
  };
  return mod.refreshSandboxPolicyContextFile(sandboxName);
}

const defaultLog = (message: string): void => {
  console.error(message);
};

export function seedInitialPolicyContext(
  sandboxName: string,
  deps: SeedPolicyContextDeps = {},
): void {
  const refresh = deps.refresh ?? defaultRefresh;
  const logError = deps.logError ?? defaultLog;
  // The refresh path eventually reaches `executeSandboxCommand` →
  // `captureSandboxSshConfig` → `captureOpenshellCommand`, which calls
  // `process.exit(1)` from `handleSpawnError` on any `spawnSync`-level
  // error (ENOENT, EMFILE, ETIMEDOUT, …) regardless of `ignoreError`.
  // When the onboard host is rebuild.ts, that exit fires inside rebuild's
  // overridden `process.exit` and corrupts the post-onboard recovery flag
  // even though the seed is supposed to be best-effort. Shadow
  // `process.exit` for the duration of the call so any exit attempt the
  // refresh helper triggers becomes a thrown error we can swallow without
  // leaking the exit signal to the surrounding onboard run.
  //
  // Removal condition: this monkey-patch must stay until
  // `src/lib/adapters/openshell/client.ts:handleSpawnError` (and the
  // `captureSandboxSshConfigCommand` / `captureOpenshellCommand` callers
  // in `src/lib/adapters/openshell/runtime.ts`) grow a "non-exiting"
  // mode for best-effort callers — at which point `executeSandboxCommand`
  // can return `null` on spawn failure rather than exiting and the seed
  // can drop the shadow. Refresh must remain synchronous as long as the
  // shadow is in place; an async refresh would let the surrounding
  // `process.exit = savedExit` restoration fire before a deferred
  // callback runs, defeating the isolation.
  const savedExit = process.exit;
  process.exit = ((code: number | undefined): never => {
    const message =
      typeof code === "number"
        ? `policy-context refresh attempted process.exit(${String(code)})`
        : "policy-context refresh attempted process.exit()";
    throw new Error(message);
  }) as typeof process.exit;
  try {
    refresh(sandboxName);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`  [onboard] Could not seed sandbox policy context: ${message}`);
  } finally {
    process.exit = savedExit;
  }
}
