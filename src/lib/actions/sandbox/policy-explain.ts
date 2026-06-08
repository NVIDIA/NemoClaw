// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
}

/**
 * Lazy executor loader. The seed runs from policy mutation hooks and from
 * the onboard policy step, both of which can be called from contexts that
 * have no OpenShell binary (unit tests, host-side dev shells before the
 * runtime is installed). We gate three boundary conditions explicitly:
 *
 * - Vitest: return null so test runs never spawn OpenShell. Vitest sets
 *   `process.env.VITEST === "true"` automatically; honouring it keeps the
 *   seed inert in the test process without requiring every consumer test
 *   to mock {@link writePolicyContextToSandbox}.
 * - OpenShell unresolvable: `resolveOpenshell()` does an X_OK check, so a
 *   missing binary or a stale path returns null here instead of letting
 *   `getOpenshellBinary()` call `process.exit(1)` on spawn.
 * - Lazy require failure: any require error (cycle, missing module,
 *   transient build state) is swallowed and we return null. Refresh
 *   callers treat null as `sandbox unreachable`; the onboard wrapper
 *   surfaces unexpected throws separately.
 *
 * Once the seed has a real executor, ownership of the actual subprocess
 * call lives in `process-recovery`'s {@link executeSandboxCommand}, which
 * is the single source of truth for sandbox SSH spawning. This function
 * does not invent a parallel spawn pipeline.
 */
function loadExecutor(): SandboxExec | null {
  if (process.env.VITEST === "true") return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const resolve = require("../../adapters/openshell/resolve") as {
      resolveOpenshell?: () => string | null;
    };
    const resolved = resolve.resolveOpenshell ? resolve.resolveOpenshell() : null;
    if (!resolved) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const recovery = require("./process-recovery") as {
      executeSandboxCommand: SandboxExec;
    };
    return recovery.executeSandboxCommand;
  } catch {
    return null;
  }
}

/**
 * Render the in-sandbox write command. Three explicit safety guarantees:
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
 */
function buildWriteCommand(markdown: string, targetPath: string): string {
  const encoded = Buffer.from(markdown, "utf-8").toString("base64");
  const dir = targetPath.replace(/\/[^/]+$/, "") || "/";
  return [
    `mkdir -p ${dir}`,
    "umask 077",
    `printf '%s' '${encoded}' | base64 -d > ${targetPath}`,
    `chmod 0644 ${targetPath}`,
  ].join(" && ");
}

export function writePolicyContextToSandbox(
  sandboxName: string,
  deps: ExplainPolicyDeps = {},
): WritePolicyContextResult {
  const build = deps.build ?? buildPolicyContext;
  const render = deps.render ?? renderPolicyContextMarkdown;
  const exec = deps.exec ?? loadExecutor();
  if (!exec) {
    return { written: false, reason: "sandbox unreachable" };
  }
  const ctx = build(sandboxName);
  const markdown = render(ctx);
  const command = buildWriteCommand(markdown, POLICY_CONTEXT_SANDBOX_PATH);
  const result = exec(sandboxName, command);
  if (result === null) {
    return { written: false, reason: "sandbox unreachable" };
  }
  if (result.status !== 0) {
    return {
      written: false,
      reason: `write failed (status ${String(result.status)}): ${result.stderr || "(no stderr)"}`,
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
