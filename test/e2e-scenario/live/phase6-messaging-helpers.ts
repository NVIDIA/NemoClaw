// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  type SandboxClient,
  sandboxAccessEnv,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import { expect } from "../fixtures/e2e-test.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { isNvidiaEndpointRateLimitFailure } from "./messaging-providers-helpers.ts";

export const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
export const CLI = process.env.NEMOCLAW_CLI_BIN ?? path.join(REPO_ROOT, "bin", "nemoclaw.js");

export const INSTALL_TIMEOUT_MS = 45 * 60_000;
export const COMMAND_TIMEOUT_MS = 120_000;

export type AgentKind = "openclaw" | "hermes";

export function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

export function resultText(result: Pick<ShellProbeResult, "stdout" | "stderr">): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

export function phase6Env(options: {
  sandboxName: string;
  agent?: AgentKind;
  apiKey?: string;
  extra?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  validateSandboxName(options.sandboxName);
  return {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_FRESH: "1",
    NEMOCLAW_POLICY_TIER: process.env.NEMOCLAW_POLICY_TIER ?? "open",
    NEMOCLAW_SANDBOX_NAME: options.sandboxName,
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
    ...(options.agent ? { NEMOCLAW_AGENT: options.agent } : {}),
    ...(options.apiKey
      ? { NVIDIA_INFERENCE_API_KEY: options.apiKey, NVIDIA_API_KEY: options.apiKey }
      : {}),
    ...options.extra,
  };
}

export function redactionValues(apiKey: string | undefined): string[] {
  return [apiKey].filter((value): value is string => typeof value === "string" && value.length > 0);
}

export async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup and diagnostics must not hide primary test failures.
  }
}

export function expectExitZero(result: ShellProbeResult, label: string): void {
  expect(result.exitCode, `${label}\n${resultText(result)}`).toBe(0);
}

export async function precleanSandbox(
  host: HostCliClient,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
  redactions: string[],
  prefix: string,
): Promise<void> {
  await bestEffort(() =>
    host.command("node", [CLI, sandboxName, "destroy", "--yes"], {
      artifactName: `${prefix}-nemoclaw-destroy`,
      env,
      redactionValues: redactions,
      timeoutMs: 15 * 60_000,
    }),
  );
  await bestEffort(() =>
    host.command("openshell", ["sandbox", "delete", sandboxName], {
      artifactName: `${prefix}-openshell-sandbox-delete`,
      env,
      redactionValues: redactions,
      timeoutMs: 120_000,
    }),
  );
}

export async function cleanupSandbox(
  host: HostCliClient,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
  redactions: string[],
  prefix: string,
): Promise<void> {
  await precleanSandbox(host, sandboxName, env, redactions, prefix);
}

export async function installSandbox(
  host: HostCliClient,
  env: NodeJS.ProcessEnv,
  redactions: string[],
  artifactName: string,
): Promise<ShellProbeResult> {
  const result = await host.command("bash", ["install.sh", "--non-interactive"], {
    artifactName,
    cwd: REPO_ROOT,
    env,
    redactionValues: redactions,
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  if (result.exitCode !== 0 && isNvidiaEndpointRateLimitFailure(resultText(result))) {
    throw new Error(`NVIDIA_ENDPOINT_RATE_LIMIT:${artifactName}`);
  }
  return result;
}

export async function installSandboxOrSkipOnRateLimit(
  host: HostCliClient,
  env: NodeJS.ProcessEnv,
  redactions: string[],
  artifactName: string,
  skip: (note?: string) => never,
  skipMessage: string,
): Promise<ShellProbeResult> {
  try {
    return await installSandbox(host, env, redactions, artifactName);
  } catch (error) {
    if (String(error).includes("NVIDIA_ENDPOINT_RATE_LIMIT")) {
      skip(skipMessage);
    }
    throw error;
  }
}

export async function expectSandboxReady(
  host: HostCliClient,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
  redactions: string[],
  artifactName: string,
): Promise<void> {
  const list = await host.command("openshell", ["sandbox", "list"], {
    artifactName,
    env,
    redactionValues: redactions,
    timeoutMs: 60_000,
  });
  expectExitZero(list, "openshell sandbox list");
  const row = stripAnsi(list.stdout)
    .split(/\r?\n/)
    .find((line) => line.includes(sandboxName));
  expect(row, resultText(list)).toMatch(/\bReady\b/i);
}

export async function sandboxSh(
  sandbox: SandboxClient,
  sandboxName: string,
  script: string,
  options: {
    artifactName: string;
    redactionValues?: string[];
    timeoutMs?: number;
  },
): Promise<ShellProbeResult> {
  return sandbox.execShell(sandboxName, trustedSandboxShellScript(script), {
    artifactName: options.artifactName,
    env: sandboxAccessEnv(),
    redactionValues: options.redactionValues ?? [],
    timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
  });
}

export async function dockerInfo(
  host: HostCliClient,
  env: NodeJS.ProcessEnv,
): Promise<ShellProbeResult> {
  return host.command("docker", ["info"], {
    artifactName: "phase6-docker-info",
    env,
    timeoutMs: 30_000,
  });
}
