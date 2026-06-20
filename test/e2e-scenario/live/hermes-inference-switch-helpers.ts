// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { resultText } from "../fixtures/clients/index.ts";
import {
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { isTransientProviderValidationFailure } from "./network-policy-transient-provider.ts";

export const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
export const CLI = path.join(REPO_ROOT, "bin", "nemoclaw.js");
export const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-hermes-inference-switch";
validateSandboxName(SANDBOX_NAME);
export const SWITCH_PROVIDER = process.env.NEMOCLAW_SWITCH_PROVIDER ?? "nvidia-prod";
export const SWITCH_MODEL = process.env.NEMOCLAW_SWITCH_MODEL ?? "z-ai/glm-5.1";
export const SWITCH_API = process.env.NEMOCLAW_SWITCH_INFERENCE_API ?? "openai-completions";
const INSTALL_ATTEMPTS = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true" ? 3 : 1;

export function env(apiKey?: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_AGENT: "hermes",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
  };
  apiKey && Object.assign(out, { NVIDIA_INFERENCE_API_KEY: apiKey, NVIDIA_API_KEY: apiKey });
  return out;
}

export async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {}
}

export function parseHermesModelBlock(text: string): Record<string, string> {
  const model: Record<string, string> = {};
  let inModel = false;
  for (const line of text.split(/\r?\n/u)) {
    const entersModel = /^model:\s*$/u.test(line);
    entersModel && (inModel = true);
    if (entersModel) continue;
    if (inModel && /^[A-Za-z0-9_-]+:/u.test(line)) break;
    const match = inModel ? line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*?)\s*$/u) : null;
    match && (model[match[1]] = match[2].replace(/^['"]|['"]$/gu, ""));
  }
  return model;
}

export function chatContent(raw: string): string {
  const parsed = JSON.parse(raw) as {
    choices?: Array<{ message?: Record<string, unknown> }>;
    content?: Array<{ text?: unknown }>;
  };
  const anthropicText = parsed.content?.find((part) => typeof part.text === "string")?.text;
  const message = parsed.choices?.[0]?.message ?? {};
  const values = [anthropicText, message.content, message.reasoning_content, message.reasoning];
  return (
    values
      .find((value): value is string => typeof value === "string" && value.trim().length > 0)
      ?.trim() ?? ""
  );
}

export async function cleanupHermesSwitch(
  host: HostCliClient,
  sandbox: SandboxClient,
): Promise<void> {
  await bestEffort(() =>
    host.command("node", [CLI, SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: "cleanup-nemoclaw-destroy",
      env: env(),
      timeoutMs: 120_000,
    }),
  );
  await bestEffort(() =>
    sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: "cleanup-openshell-delete",
      env: env(),
      timeoutMs: 60_000,
    }),
  );
}

export async function installHermes(
  host: HostCliClient,
  apiKey: string,
): Promise<ShellProbeResult> {
  let install: ShellProbeResult | undefined;
  for (let attempt = 1; attempt <= INSTALL_ATTEMPTS; attempt += 1) {
    install = await host.command(
      "bash",
      ["install.sh", "--non-interactive", "--yes-i-accept-third-party-software"],
      {
        artifactName: attempt === 1 ? "install-hermes" : `install-hermes-attempt-${attempt}`,
        cwd: REPO_ROOT,
        env: env(apiKey),
        redactionValues: [apiKey],
        timeoutMs: 25 * 60_000,
      },
    );
    const retry =
      install.exitCode !== 0 &&
      isTransientProviderValidationFailure(install) &&
      attempt < INSTALL_ATTEMPTS;
    install.exitCode === 0 && (attempt = INSTALL_ATTEMPTS + 1);
    retry && (await new Promise((resolve) => setTimeout(resolve, 10_000 * attempt)));
    !retry && install.exitCode !== 0 && (attempt = INSTALL_ATTEMPTS + 1);
  }
  if (!install) throw new Error("install command did not run");
  return install;
}

export async function hermesGatewayPid(
  sandbox: SandboxClient,
  artifactName: string,
): Promise<ShellProbeResult> {
  return await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript(
      "ps -eo pid=,comm=,args= | awk '$0 ~ /hermes/ && $0 ~ /gateway run/ { print $1; exit }'",
    ),
    { artifactName, env: env(), timeoutMs: 30_000 },
  );
}

export async function envHash(
  sandbox: SandboxClient,
  artifactName: string,
): Promise<ShellProbeResult> {
  return await sandbox.exec(SANDBOX_NAME, ["sha256sum", "/sandbox/.hermes/.env"], {
    artifactName,
    env: env(),
    timeoutMs: 30_000,
  });
}

export function maybeAssertPidStable(
  before: ShellProbeResult,
  after: ShellProbeResult,
  assertStable: (a: string, b: string) => void,
): void {
  const beforePid = before.stdout.trim();
  const afterPid = after.stdout.trim();
  beforePid && afterPid && assertStable(afterPid, beforePid);
}

export function expectedBaseUrl(): string {
  return SWITCH_API === "anthropic-messages"
    ? "https://inference.local"
    : "https://inference.local/v1";
}

export function expectedApiMode(): string | undefined {
  return new Map<string, string>([
    ["anthropic-messages", "anthropic_messages"],
    ["openai-responses", "codex_responses"],
  ]).get(SWITCH_API);
}

export async function apiKeyShape(sandbox: SandboxClient): Promise<ShellProbeResult> {
  return await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript(
      "python3 - <<'PY'\nimport re\ntext=open('/sandbox/.hermes/config.yaml', encoding='utf-8').read()\nmatch=re.search(r'^\\s+api_key:\\s*[\\\"\\']?(sk-[^\\\"\\'\\s]+)', text, re.M)\nraise SystemExit(0 if match else 1)\nPY",
    ),
    { artifactName: "hermes-config-api-key-shape", env: env(), timeoutMs: 30_000 },
  );
}

export async function hashCheck(
  sandbox: SandboxClient,
  file: string,
  artifact: string,
): Promise<ShellProbeResult> {
  return await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript(`sha256sum -c ${file} --status && echo OK`),
    { artifactName: `hermes-${artifact}-hash-check`, env: env(), timeoutMs: 30_000 },
  );
}

export async function strictHashPerms(sandbox: SandboxClient): Promise<ShellProbeResult> {
  return await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript("stat -c '%u %a' /etc/nemoclaw/hermes.config-hash"),
    { artifactName: "hermes-strict-hash-perms", env: env(), timeoutMs: 30_000 },
  );
}

export function maybeAssertEnvHashStable(
  before: ShellProbeResult,
  after: ShellProbeResult,
  assertStable: (a: string, b: string) => void,
): void {
  const beforeHash = before.stdout.split(/\s+/u)[0] ?? "";
  const afterHash = after.stdout.split(/\s+/u)[0] ?? "";
  beforeHash && assertStable(afterHash, beforeHash);
}

export function registryState(): { registry: Record<string, any>; session: Record<string, any> } {
  return {
    registry: JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".nemoclaw", "sandboxes.json"), "utf8"),
    ),
    session: JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".nemoclaw", "onboard-session.json"), "utf8"),
    ),
  };
}

function quotePayload(payload: string): string {
  return payload.replace(/'/gu, `'\\''`);
}

export function inferenceLocalCommand(payload: string): string {
  return SWITCH_API === "anthropic-messages"
    ? `curl -sS --max-time 90 https://inference.local/v1/messages -H 'Content-Type: application/json' -H 'anthropic-version: 2023-06-01' -d '${quotePayload(payload)}'`
    : `curl -sS --max-time 90 https://inference.local/v1/chat/completions -H 'Content-Type: application/json' -d '${quotePayload(payload)}'`;
}

export function hermesApiCommand(payload: string): string {
  return `set -a; [ ! -f /sandbox/.hermes/.env ] || . /sandbox/.hermes/.env; set +a; curl -sS --max-time 120 http://localhost:8642/v1/chat/completions -H 'Content-Type: application/json' -H "Authorization: Bearer \${API_SERVER_KEY:-}" -d '${quotePayload(payload)}'`;
}
