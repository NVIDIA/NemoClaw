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
