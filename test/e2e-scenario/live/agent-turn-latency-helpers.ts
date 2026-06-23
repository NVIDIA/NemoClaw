// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import { expect } from "../fixtures/e2e-test.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { installShOnboardArgs } from "./install-sh-onboard.ts";
import { isTransientProviderValidationFailure } from "./network-policy-transient-provider.ts";

export const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
export const CLI = path.join(REPO_ROOT, "bin", "nemoclaw.js");
export const OPENCLAW_SANDBOX =
  process.env.NEMOCLAW_OPENCLAW_TURN_LATENCY_SANDBOX_NAME ?? "e2e-openclaw-turn-latency";
export const HERMES_SANDBOX =
  process.env.NEMOCLAW_HERMES_TURN_LATENCY_SANDBOX_NAME ?? "e2e-hermes-turn-latency";
validateSandboxName(OPENCLAW_SANDBOX);
validateSandboxName(HERMES_SANDBOX);
const DEFAULT_NVIDIA_MODEL = "nvidia/nemotron-3-super-120b-a12b";
const DEFAULT_COMPAT_MODEL = "nvidia/nvidia/nemotron-3-super-v3";
const USE_COMPATIBLE_HOSTED = process.env.NEMOCLAW_E2E_USE_HOSTED_INFERENCE === "1";
export const MODEL =
  process.env.NEMOCLAW_TURN_LATENCY_MODEL ??
  process.env.NEMOCLAW_MODEL ??
  process.env.NEMOCLAW_COMPAT_MODEL ??
  (USE_COMPATIBLE_HOSTED ? DEFAULT_COMPAT_MODEL : DEFAULT_NVIDIA_MODEL);
const PROVIDER =
  process.env.NEMOCLAW_TURN_LATENCY_PROVIDER ?? (USE_COMPATIBLE_HOSTED ? "custom" : "build");
export const EXPECTED_ROUTE_PROVIDER =
  process.env.NEMOCLAW_TURN_LATENCY_ROUTE_PROVIDER ??
  (PROVIDER === "custom" ? "compatible-endpoint" : "nvidia-prod");
export const MAX_TURN_SECONDS = positiveInt(process.env.NEMOCLAW_TURN_LATENCY_MAX_SECONDS, 300);
const INSTALL_ATTEMPTS = positiveInt(process.env.NEMOCLAW_TURN_LATENCY_INSTALL_ATTEMPTS, 2);

function positiveInt(value: string | undefined, fallback: number): number {
  return value && /^[1-9][0-9]*$/u.test(value) ? Number.parseInt(value, 10) : fallback;
}

export function env(
  sandboxName: string,
  agent: "openclaw" | "hermes",
  apiKey?: string,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_MODEL: MODEL,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_PROVIDER: PROVIDER,
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: sandboxName,
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
  };
  agent === "hermes" && (out.NEMOCLAW_AGENT = "hermes");
  apiKey && Object.assign(out, { NVIDIA_INFERENCE_API_KEY: apiKey, NVIDIA_API_KEY: apiKey });
  PROVIDER === "custom" &&
    Object.assign(out, {
      COMPATIBLE_API_KEY: apiKey,
      NEMOCLAW_COMPAT_MODEL: MODEL,
      NEMOCLAW_ENDPOINT_URL:
        process.env.NEMOCLAW_ENDPOINT_URL ?? "https://inference-api.nvidia.com/v1",
      NEMOCLAW_PREFERRED_API: process.env.NEMOCLAW_PREFERRED_API ?? "openai-completions",
    });
  return out;
}

export async function bestEffort(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.warn(
      `best-effort cleanup failed (${label}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseJsonObjectAt(output: string, start: number): unknown {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < output.length; index += 1) {
    const char = output[index];
    const state = updateJsonScanState({ depth, inString, escaped }, char);
    depth = state.depth;
    inString = state.inString;
    escaped = state.escaped;
    if (depth === 0 && char === "}") {
      try {
        return JSON.parse(output.slice(start, index + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function updateJsonScanState(
  state: { depth: number; inString: boolean; escaped: boolean },
  char: string,
): { depth: number; inString: boolean; escaped: boolean } {
  const inStringEscaped = state.inString && state.escaped;
  const startsEscape = state.inString && !state.escaped && char === "\\";
  const endsString = state.inString && !state.escaped && char === '"';
  const startsString = !state.inString && char === '"';
  const opensObject = !state.inString && char === "{";
  const closesObject = !state.inString && char === "}";
  return {
    depth: state.depth + (opensObject ? 1 : 0) - (closesObject ? 1 : 0),
    inString: startsString || (state.inString && !endsString),
    escaped: startsEscape || (state.escaped && !inStringEscaped),
  };
}

function collectAssistantText(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(collectAssistantText);
  const record = value as Record<string, unknown>;
  return [
    "result",
    "payloads",
    "payload",
    "messages",
    "choices",
    "message",
    "delta",
    "content",
    "reasoning_content",
    "response",
    "data",
    "output",
    "outputs",
    "items",
    "segments",
    "text",
  ].flatMap((key) => (key in record ? collectAssistantText(record[key]) : []));
}

export function extractOpenClawAgentText(output: string): string {
  for (let start = output.indexOf("{"); start >= 0; start = output.indexOf("{", start + 1)) {
    const text = collectAssistantText(parseJsonObjectAt(output, start))[0];
    if (text) return text;
  }
  return "";
}

export function responseBodyAndStatus(raw: string): { body: string; status: string } {
  const match = raw.match(/\n__NEMOCLAW_HTTP_STATUS__=(\d{3})\s*$/u);
  return { body: match ? raw.slice(0, match.index).trim() : raw, status: match?.[1] ?? "000" };
}

export function chatContent(raw: string): string {
  const parsed = JSON.parse(raw) as {
    choices?: Array<{ message?: Record<string, unknown>; text?: unknown }>;
  };
  const choice = parsed.choices?.[0];
  const message = choice?.message ?? {};
  return (
    [message.content, message.reasoning_content, message.reasoning, choice?.text]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0)
      ?.trim() ?? ""
  );
}

export function msSince(start: bigint): number {
  return Number((process.hrtime.bigint() - start) / 1_000_000n);
}

export function assertOpenClawConfig(raw: string, model: string): void {
  const cfg = JSON.parse(raw) as {
    agents?: { defaults?: { model?: { primary?: unknown } } };
    models?: {
      providers?: {
        inference?: { baseUrl?: unknown; models?: Array<{ id?: unknown; name?: unknown }> };
      };
    };
  };
  const provider = cfg.models?.providers?.inference;
  expect(cfg.agents?.defaults?.model?.primary).toBe(`inference/${model}`);
  expect(provider?.baseUrl).toBe("https://inference.local/v1");
  expect(provider?.models?.[0]?.id).toBe(model);
  expect(provider?.models?.[0]?.name).toBe(`inference/${model}`);
}

export function assertHermesConfig(raw: string, model: string): void {
  const values = parseHermesModelBlock(raw);
  expect(values.default).toBe(model);
  expect(values.base_url).toBe("https://inference.local/v1");
  expect(values.provider).toBe("custom");
  expect(raw).not.toMatch(/^models:\s*\n(?:[ \t].*\n)*?[ \t]+providers:/mu);
}

function parseHermesModelBlock(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  let inModel = false;
  for (const line of raw.split(/\r?\n/u)) {
    const entersModel = /^model:\s*$/u.test(line);
    entersModel && (inModel = true);
    if (entersModel) continue;
    if (inModel && /^[A-Za-z0-9_-]+:/u.test(line)) break;
    const match = inModel ? line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*?)\s*$/u) : null;
    match && (values[match[1]] = match[2].replace(/^['"]|['"]$/gu, ""));
  }
  return values;
}

export async function installSandbox(
  host: HostCliClient,
  sandboxName: string,
  agent: "openclaw" | "hermes",
  apiKey: string,
  cleanupBeforeRetry?: () => Promise<void>,
): Promise<ShellProbeResult> {
  let install: ShellProbeResult | undefined;
  for (let attempt = 1; attempt <= INSTALL_ATTEMPTS; attempt += 1) {
    install = await host.command("bash", installShOnboardArgs(), {
      artifactName: `${agent}-install-attempt-${attempt}`,
      cwd: REPO_ROOT,
      env: env(sandboxName, agent, apiKey),
      redactionValues: [apiKey],
      timeoutMs: 30 * 60_000,
    });
    const retry =
      install.exitCode !== 0 &&
      isTransientProviderValidationFailure(install) &&
      attempt < INSTALL_ATTEMPTS;
    install.exitCode === 0 && (attempt = INSTALL_ATTEMPTS + 1);
    retry && cleanupBeforeRetry && (await cleanupBeforeRetry());
    retry && (await new Promise((resolve) => setTimeout(resolve, 10_000 * attempt)));
    !retry && install.exitCode !== 0 && (attempt = INSTALL_ATTEMPTS + 1);
  }
  if (!install) throw new Error(`${agent} install command did not run`);
  return install;
}

export async function cleanupTurnSandboxes(
  host: HostCliClient,
  sandbox: SandboxClient,
): Promise<void> {
  for (const [name, agent] of [
    [OPENCLAW_SANDBOX, "openclaw"],
    [HERMES_SANDBOX, "hermes"],
  ] as const) {
    await bestEffort(`destroy ${agent} sandbox`, () =>
      host.command("node", [CLI, name, "destroy", "--yes"], {
        artifactName: `cleanup-${agent}-destroy`,
        env: env(name, agent),
        timeoutMs: 120_000,
      }),
    );
    await bestEffort(`delete ${agent} sandbox`, () =>
      sandbox.openshell(["sandbox", "delete", name], {
        artifactName: `cleanup-${agent}-delete`,
        env: env(name, agent),
        timeoutMs: 60_000,
      }),
    );
  }
  await bestEffort("stop Hermes API forward", () =>
    sandbox.openshell(["forward", "stop", "8642"], {
      artifactName: "cleanup-forward-stop-hermes-api",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    }),
  );
  await bestEffort("destroy OpenShell gateway", () =>
    sandbox.openshell(["gateway", "destroy", "-g", "nemoclaw"], {
      artifactName: "cleanup-gateway-destroy-turn-latency",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    }),
  );
}

export async function route(
  sandbox: SandboxClient,
  sandboxName: string,
  agent: "openclaw" | "hermes",
  artifactName: string,
): Promise<ShellProbeResult> {
  return await sandbox.openshell(["inference", "get", "-g", "nemoclaw"], {
    artifactName,
    env: env(sandboxName, agent),
    timeoutMs: 30_000,
  });
}

export async function openclawTurn(
  sandbox: SandboxClient,
  apiKey: string,
): Promise<{ result: ShellProbeResult; elapsedMs: number }> {
  const started = process.hrtime.bigint();
  const result = await sandbox.execShell(
    OPENCLAW_SANDBOX,
    trustedSandboxShellScript(
      "openclaw agent --agent main --json --thinking off --session-id e2e-turn-latency -m 'What is 6 multiplied by 7? Reply with only the integer, no extra words.'",
    ),
    {
      artifactName: "openclaw-agent-turn",
      env: env(OPENCLAW_SANDBOX, "openclaw"),
      redactionValues: [apiKey],
      timeoutMs: (MAX_TURN_SECONDS + 30) * 1000,
    },
  );
  return { result, elapsedMs: msSince(started) };
}

export async function waitHermesHealth(sandbox: SandboxClient): Promise<ShellProbeResult> {
  return await sandbox.execShell(
    HERMES_SANDBOX,
    trustedSandboxShellScript(
      "for attempt in $(seq 1 10); do body=$(curl -sf --max-time 10 http://localhost:8642/health 2>/dev/null || true); printf '%s' \"$body\" | grep -qi '\"ok\"' && { printf '%s' \"$body\"; exit 0; }; sleep 5; done; printf '%s' \"$body\"; exit 1",
    ),
    { artifactName: "hermes-health", env: env(HERMES_SANDBOX, "hermes"), timeoutMs: 90_000 },
  );
}

export function openclawConfigCommand(): string {
  return `node <<'NODE'
const fs = require('node:fs');
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = /api[_-]?key|token|secret|credential/i.test(key) ? '[REDACTED]' : redact(entry);
    }
    return out;
  }
  return value;
}
console.log(JSON.stringify(redact(JSON.parse(fs.readFileSync('/sandbox/.openclaw/openclaw.json', 'utf8'))), null, 2));
NODE`;
}

export function assertNoOpenClawTransportErrors(output: string): void {
  expect(output).not.toMatch(
    /SsrFBlockedError|transport error|ECONNREFUSED|EAI_AGAIN|gateway unavailable|network connection error/i,
  );
}

export function hermesTurnCommand(payload: string): string {
  return `set -a; [ ! -f /sandbox/.hermes/.env ] || . /sandbox/.hermes/.env; set +a; tmp=$(mktemp); if [ -n \"\${API_SERVER_KEY:-}\" ]; then code=$(curl -sS -o \"$tmp\" -w '%{http_code}' --max-time ${MAX_TURN_SECONDS} http://localhost:8642/v1/chat/completions -H 'Content-Type: application/json' -H \"Authorization: Bearer \${API_SERVER_KEY}\" -d '${payload.replace(/'/gu, `'\\''`)}'); else code=$(curl -sS -o \"$tmp\" -w '%{http_code}' --max-time ${MAX_TURN_SECONDS} http://localhost:8642/v1/chat/completions -H 'Content-Type: application/json' -d '${payload.replace(/'/gu, `'\\''`)}'); fi; rc=$?; cat \"$tmp\"; rm -f \"$tmp\"; printf '\n__NEMOCLAW_HTTP_STATUS__=%s\n' \"\${code:-000}\"; exit \"$rc\"`;
}
