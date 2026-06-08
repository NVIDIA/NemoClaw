// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Host-side write path for the agent-facing policy context file. The
 * shell command construction (payload encoding, atomic mv replacement,
 * symlink resistance) and the failure-routing contract are pinned by the
 * unit tests in this directory. The cross-boundary runtime behaviour —
 * the file actually appearing inside the sandbox with the expected mode,
 * symlinks at the target being replaced rather than followed, and the
 * refresh firing only after a successful policy mutation — is exercised
 * end-to-end by the `network-policy-e2e` and `channels-add-remove-e2e`
 * jobs under `test/e2e/`, which spin up a real OpenShell sandbox and run
 * the full `policy-add`/`policy-remove`/`rebuild` flow. The unit
 * harness intentionally stays inside the JS process; runtime regressions
 * surface in those e2e jobs before merge.
 */

import {
  buildPolicyContext,
  type PolicyContext,
  renderPolicyContextMarkdown,
} from "../../policy/context";

export const POLICY_CONTEXT_SANDBOX_PATH = "/sandbox/.openclaw/workspace/POLICY.md";

export type SandboxExec = (
  sandboxName: string,
  command: string,
) => { status: number; stdout: string; stderr: string } | null;

export interface ExplainPolicyOptions {
  json?: boolean;
  writeToSandbox?: boolean;
}

export interface ExplainPolicyDeps {
  build?: (sandboxName: string) => PolicyContext;
  render?: (ctx: PolicyContext) => string;
  log?: (line: string) => void;
  logJson?: (value: unknown) => void;
  exec?: SandboxExec;
  warn?: (line: string) => void;
}

export interface WritePolicyContextResult {
  written: boolean;
  reason?: string;
  /**
   * Set to `unexpected-loader` when the executor loader caught an
   * import/resolve error (cycle, missing module, process-recovery
   * regression). Callers use this to distinguish a legitimate
   * `sandbox unreachable` from a code regression that needs surfacing.
   */
  failure?: "loader-vitest" | "no-runtime" | "unexpected-loader" | "sandbox-unreachable" | "exec-failed";
  /** Error captured by the loader, if any. */
  errorMessage?: string;
}

type ExecutorLoad =
  | { kind: "ok"; exec: SandboxExec }
  | { kind: "vitest" }
  | { kind: "no-runtime" }
  | { kind: "crashed"; error: Error };

/**
 * Lazy executor loader. The seed runs from policy mutation hooks and from
 * the onboard policy step, both of which can be called from contexts that
 * have no OpenShell binary (unit tests, host-side dev shells before the
 * runtime is installed). The loader returns a tagged union so callers can
 * distinguish three expected boundary conditions from a regression:
 *
 * - `vitest`: `process.env.VITEST === "true"`. Tests never spawn
 *   OpenShell. The seed is silently inert in the test process without
 *   requiring every consumer test to mock {@link writePolicyContextToSandbox}.
 * - `no-runtime`: `resolveOpenshell()` returned null (no binary on PATH,
 *   stale path, X_OK fail). The sandbox surface genuinely cannot spawn
 *   OpenShell; treat as `sandbox unreachable` and warn at most once per
 *   call site at the caller's discretion.
 * - `crashed`: require/resolve threw. Either an import cycle, a missing
 *   module, or a process-recovery regression. Callers must route this
 *   through the refresh helper's `unexpected` sink so a code regression
 *   is not silently treated as `sandbox unreachable`.
 *
 * Once the loader returns `ok`, ownership of the actual subprocess call
 * lives in `process-recovery`'s {@link executeSandboxCommand}, which is
 * the single source of truth for sandbox SSH spawning. This function
 * does not invent a parallel spawn pipeline.
 */
function loadExecutor(): ExecutorLoad {
  if (process.env.VITEST === "true") return { kind: "vitest" };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const resolve = require("../../adapters/openshell/resolve") as {
      resolveOpenshell?: () => string | null;
    };
    const resolved = resolve.resolveOpenshell ? resolve.resolveOpenshell() : null;
    if (!resolved) return { kind: "no-runtime" };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const recovery = require("./process-recovery") as {
      executeSandboxCommand: SandboxExec;
    };
    return { kind: "ok", exec: recovery.executeSandboxCommand };
  } catch (error: unknown) {
    return {
      kind: "crashed",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Render the in-sandbox write command. Four explicit safety guarantees:
 *
 * - The markdown payload is base64-encoded before it is interpolated into
 *   the shell string, so anything in the rendered context — quotes,
 *   semicolons, backticks, command substitutions, redirections, newlines —
 *   reaches `base64 -d` as inert data rather than the parent shell. The
 *   hostile-markdown negative test in policy-explain.test.ts guards this.
 * - The destination path is the module-scoped constant
 *   {@link POLICY_CONTEXT_SANDBOX_PATH}. We do not accept user-controlled
 *   paths here; any future caller that wants a variable path must
 *   shell-quote it before reaching this helper.
 * - The intermediate `mkdir -p` and `chmod 0644` reuse the same constant
 *   path so the command never mixes interpolated user data with shell
 *   tokens. The `dir` derivation is a string operation on the constant
 *   path and never sees external input.
 * - The payload is first written to a freshly-created sibling temp file
 *   with restrictive permissions (umask 077 + mktemp template), then
 *   atomically replaces the target via `mv -fT`. Replacement uses the
 *   `rename(2)` semantics, which acts on the link itself rather than the
 *   target of a symlink, so an in-sandbox attacker who pre-created
 *   POLICY.md as a symlink cannot redirect the policy-context write into
 *   another file reachable from the sandbox user. `mv -fT` additionally
 *   refuses to descend into a directory pre-staged at the target path.
 */
function buildWriteCommand(markdown: string, targetPath: string): string {
  const encoded = Buffer.from(markdown, "utf-8").toString("base64");
  const dir = targetPath.replace(/\/[^/]+$/, "") || "/";
  return [
    `mkdir -p ${dir}`,
    "umask 077",
    `__pm_tmp=$(mktemp ${dir}/.POLICY.md.XXXXXX)`,
    `printf '%s' '${encoded}' | base64 -d > "$__pm_tmp"`,
    `chmod 0644 "$__pm_tmp"`,
    `mv -fT -- "$__pm_tmp" ${targetPath}`,
  ].join(" && ");
}

export function writePolicyContextToSandbox(
  sandboxName: string,
  deps: ExplainPolicyDeps = {},
): WritePolicyContextResult {
  const build = deps.build ?? buildPolicyContext;
  const render = deps.render ?? renderPolicyContextMarkdown;
  let exec: SandboxExec | undefined = deps.exec;
  if (!exec) {
    const load = loadExecutor();
    if (load.kind === "vitest") {
      return { written: false, reason: "sandbox unreachable", failure: "loader-vitest" };
    }
    if (load.kind === "no-runtime") {
      return { written: false, reason: "sandbox unreachable", failure: "no-runtime" };
    }
    if (load.kind === "crashed") {
      return {
        written: false,
        reason: `policy-context executor failed to load: ${load.error.message}`,
        failure: "unexpected-loader",
        errorMessage: load.error.message,
      };
    }
    exec = load.exec;
  }
  const ctx = build(sandboxName);
  const markdown = render(ctx);
  const command = buildWriteCommand(markdown, POLICY_CONTEXT_SANDBOX_PATH);
  const result = exec(sandboxName, command);
  if (result === null) {
    return { written: false, reason: "sandbox unreachable", failure: "sandbox-unreachable" };
  }
  if (result.status !== 0) {
    return {
      written: false,
      reason: `write failed (status ${String(result.status)}): ${result.stderr || "(no stderr)"}`,
      failure: "exec-failed",
    };
  }
  return { written: true };
}

export function explainSandboxPolicy(
  sandboxName: string,
  options: ExplainPolicyOptions = {},
  deps: ExplainPolicyDeps = {},
): PolicyContext {
  const build = deps.build ?? buildPolicyContext;
  const render = deps.render ?? renderPolicyContextMarkdown;
  const log = deps.log ?? ((line: string) => console.log(line));
  const logJson =
    deps.logJson ?? ((value: unknown) => console.log(JSON.stringify(value, null, 2)));
  const warn = deps.warn ?? ((line: string) => console.error(line));
  const ctx = build(sandboxName);
  if (options.json) {
    logJson(ctx);
  } else {
    log(render(ctx));
  }
  if (options.writeToSandbox) {
    const writeResult = writePolicyContextToSandbox(sandboxName, { ...deps, build, render });
    if (!writeResult.written) {
      const detail = writeResult.reason ?? "unknown reason";
      warn(`  Could not seed ${POLICY_CONTEXT_SANDBOX_PATH}: ${detail}.`);
    }
  }
  return ctx;
}
