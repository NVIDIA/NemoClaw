// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import { expect } from "../fixtures/e2e-test.ts";
import type { E2EInferenceAdapter } from "../fixtures/inference-adapter.ts";
import { CLI_ENTRYPOINT, REPO_ROOT } from "../fixtures/paths.ts";
import type { TestProgress } from "../fixtures/progress.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { isTransientProviderValidationFailure } from "./network-policy-transient-provider.ts";

// The injected E2E inference adapter (#5745) is the single source of the
// model, provider, expected route, and credential this suite exercises;
// this file must not rederive them from ad hoc NEMOCLAW_* env inspection.
export type AgentTurnInference = Pick<
  E2EInferenceAdapter,
  "env" | "expectedRouteProvider" | "model" | "mode" | "provider" | "redactionValues"
>;

export { REPO_ROOT };

export const CLI = CLI_ENTRYPOINT;
export const OPENCLAW_SANDBOX =
  process.env.NEMOCLAW_OPENCLAW_TURN_LATENCY_SANDBOX_NAME ?? "e2e-oc-turn-lat";
export const HERMES_SANDBOX =
  process.env.NEMOCLAW_HERMES_TURN_LATENCY_SANDBOX_NAME ?? "e2e-hm-turn-lat";
validateSandboxName(OPENCLAW_SANDBOX);
validateSandboxName(HERMES_SANDBOX);
export const MAX_TURN_SECONDS = positiveInt(process.env.NEMOCLAW_TURN_LATENCY_MAX_SECONDS, 300);
const INSTALL_ATTEMPTS = positiveInt(process.env.NEMOCLAW_TURN_LATENCY_INSTALL_ATTEMPTS, 2);
const INSTALL_TIMEOUT_MS = 30 * 60_000;

type AgentTurnProgress = Pick<TestProgress, "activity" | "event" | "onOutput">;

function positiveInt(value: string | undefined, fallback: number): number {
  return value && /^[1-9][0-9]*$/u.test(value) ? Number.parseInt(value, 10) : fallback;
}

export function env(
  sandboxName: string,
  agent: "openclaw" | "hermes",
  inference: AgentTurnInference,
  includeCredential = false,
): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_FRESH: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: sandboxName,
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
  };
  agent === "hermes" && (base.NEMOCLAW_AGENT = "hermes");
  if (!includeCredential) {
    base.NEMOCLAW_PROVIDER = inference.provider;
    base.NEMOCLAW_MODEL = inference.model;
    return base;
  }
  return inference.env(base);
}

export async function bestEffortPreclean(
  label: string,
  run: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await run();
    return true;
  } catch {
    console.warn(`best-effort cleanup failed (${label}); see redacted command artifacts`);
    return false;
  }
}

function emitProgressEvent(progress: AgentTurnProgress | undefined, label: string): void {
  try {
    progress?.event(label);
  } catch {
    // Progress diagnostics must never change the agent-turn result.
  }
}

function startProgressActivity(progress: AgentTurnProgress | undefined, label: string): () => void {
  let finish: (() => void) | undefined;
  try {
    finish = progress?.activity(label);
  } catch {
    return () => undefined;
  }
  return () => {
    try {
      finish?.();
    } catch {
      // Progress diagnostics must never change the agent-turn result.
    }
  };
}

async function runBestEffortCleanupStep(
  label: string,
  run: () => Promise<unknown>,
  progress?: AgentTurnProgress,
): Promise<void> {
  emitProgressEvent(progress, `${label} started`);
  const finishActivity = startProgressActivity(progress, `cleanup: ${label}`);
  try {
    const succeeded = await bestEffortPreclean(label, run);
    emitProgressEvent(progress, `${label} ${succeeded ? "passed" : "failed"}`);
  } finally {
    finishActivity();
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

function collectOpenClawPayloadText(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const result =
    record.result && typeof record.result === "object" && !Array.isArray(record.result)
      ? (record.result as Record<string, unknown>)
      : null;
  const payloads = Array.isArray(record.payloads)
    ? record.payloads
    : Array.isArray(result?.payloads)
      ? result.payloads
      : [];
  return payloads.flatMap((payload) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
    const text = (payload as Record<string, unknown>).text;
    return typeof text === "string" && text.trim() ? [text.trim()] : [];
  });
}

/** Read only OpenClaw's agent-output payloads, excluding echoed request messages. */
export function extractOpenClawAgentPayloadText(output: string): string {
  for (let start = output.indexOf("{"); start >= 0; start = output.indexOf("{", start + 1)) {
    const text = collectOpenClawPayloadText(parseJsonObjectAt(output, start));
    if (text.length > 0) return text.join("\n");
  }
  return "";
}

export type OpenClawAgentDurationEvidence =
  | { durationMs: number; status: "available" }
  | { reason: "malformed" | "missing"; status: "unavailable" };

export interface OpenClawFirstTurnLatencyEvidence {
  firstTurnAgentDuration: OpenClawAgentDurationEvidence;
  firstTurnCommandMs: number;
}

/**
 * Extract OpenClaw's internal agent duration without fabricating a value when
 * older or malformed output omits the metadata contract.
 */
export function extractOpenClawAgentDurationEvidence(
  output: string,
): OpenClawAgentDurationEvidence {
  let malformed = false;
  for (let start = output.indexOf("{"); start >= 0; start = output.indexOf("{", start + 1)) {
    const parsed = parseJsonObjectAt(output, start);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const result = (parsed as Record<string, unknown>).result;
    if (!result || typeof result !== "object" || Array.isArray(result)) continue;
    const meta = (result as Record<string, unknown>).meta;
    if (meta === undefined) continue;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
      malformed = true;
      continue;
    }
    const durationMs = (meta as Record<string, unknown>).durationMs;
    if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0) {
      return { durationMs, status: "available" };
    }
    if (durationMs !== undefined) malformed = true;
  }
  return { reason: malformed ? "malformed" : "missing", status: "unavailable" };
}

export function buildOpenClawFirstTurnLatencyEvidence(
  output: string,
  firstTurnCommandMs: number,
): OpenClawFirstTurnLatencyEvidence {
  if (
    typeof firstTurnCommandMs !== "number" ||
    !Number.isFinite(firstTurnCommandMs) ||
    firstTurnCommandMs < 0
  ) {
    throw new Error("first-turn command duration is invalid");
  }
  return {
    firstTurnAgentDuration: extractOpenClawAgentDurationEvidence(output),
    firstTurnCommandMs,
  };
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
  inference: AgentTurnInference,
  cleanupBeforeRetry?: () => Promise<void>,
  progress?: AgentTurnProgress,
): Promise<ShellProbeResult> {
  let install: ShellProbeResult | undefined;
  for (let attempt = 1; attempt <= INSTALL_ATTEMPTS; attempt += 1) {
    const attemptLabel = `${agent} install attempt ${attempt}/${INSTALL_ATTEMPTS}`;
    emitProgressEvent(progress, `${attemptLabel} started`);
    const finishInstallActivity = startProgressActivity(
      progress,
      `command: ${agent}-install-attempt-${attempt}`,
    );
    try {
      install = await host.command(
        "bash",
        ["install.sh", "--non-interactive", "--fresh", "--yes-i-accept-third-party-software"],
        {
          artifactName: `${agent}-install-attempt-${attempt}`,
          cwd: REPO_ROOT,
          env: env(sandboxName, agent, inference, true),
          onOutput: progress?.onOutput,
          redactionValues: inference.redactionValues(),
          timeoutMs: INSTALL_TIMEOUT_MS,
        },
      );
    } catch (error) {
      emitProgressEvent(progress, `${attemptLabel} failed before returning a result`);
      throw error;
    } finally {
      finishInstallActivity();
    }
    emitProgressEvent(
      progress,
      install.timedOut
        ? `${attemptLabel} timeout fired at the 30-minute limit`
        : `${attemptLabel} ${install.exitCode === 0 ? "passed" : "failed"}`,
    );
    const retry =
      install.exitCode !== 0 &&
      isTransientProviderValidationFailure(install) &&
      attempt < INSTALL_ATTEMPTS;
    install.exitCode === 0 && (attempt = INSTALL_ATTEMPTS + 1);
    if (retry && cleanupBeforeRetry) {
      emitProgressEvent(progress, `${attemptLabel} starting cleanup before retry`);
      const finishCleanupActivity = startProgressActivity(
        progress,
        `cleanup: ${agent}-install-attempt-${attempt}-retry`,
      );
      try {
        await cleanupBeforeRetry();
        emitProgressEvent(progress, `${attemptLabel} cleanup before retry passed`);
      } catch (error) {
        emitProgressEvent(progress, `${attemptLabel} cleanup before retry failed`);
        throw error;
      } finally {
        finishCleanupActivity();
      }
    }
    if (retry) {
      const backoffSeconds = 10 * attempt;
      emitProgressEvent(progress, `${attemptLabel} waiting ${backoffSeconds}s before retry`);
      await new Promise((resolve) => setTimeout(resolve, backoffSeconds * 1_000));
    }
    !retry && install.exitCode !== 0 && (attempt = INSTALL_ATTEMPTS + 1);
  }
  if (!install) throw new Error(`${agent} install command did not run`);
  return install;
}

export async function cleanupTurnSandboxes(
  host: HostCliClient,
  sandbox: SandboxClient,
  inference: AgentTurnInference,
  progress?: AgentTurnProgress,
): Promise<void> {
  for (const [name, agent] of [
    [OPENCLAW_SANDBOX, "openclaw"],
    [HERMES_SANDBOX, "hermes"],
  ] as const) {
    await runBestEffortCleanupStep(
      `destroy ${agent} sandbox`,
      () => cleanupTurnSandbox(host, name, agent, inference, progress),
      progress,
    );
    await runBestEffortCleanupStep(
      `delete ${agent} sandbox`,
      () =>
        sandbox.openshell(["sandbox", "delete", name], {
          artifactName: `cleanup-${agent}-delete`,
          env: env(name, agent, inference),
          onOutput: progress?.onOutput,
          timeoutMs: 60_000,
        }),
      progress,
    );
  }
  await runBestEffortCleanupStep(
    "stop Hermes API forward",
    () =>
      sandbox.openshell(["forward", "stop", "8642"], {
        artifactName: "cleanup-forward-stop-hermes-api",
        env: buildAvailabilityProbeEnv(),
        onOutput: progress?.onOutput,
        timeoutMs: 30_000,
      }),
    progress,
  );
  await runBestEffortCleanupStep(
    "destroy OpenShell gateway",
    () =>
      sandbox.openshell(["gateway", "destroy", "-g", "nemoclaw"], {
        artifactName: "cleanup-gateway-destroy-turn-latency",
        env: buildAvailabilityProbeEnv(),
        onOutput: progress?.onOutput,
        timeoutMs: 60_000,
      }),
    progress,
  );
}

export async function cleanupTurnSandbox(
  host: HostCliClient,
  name: string,
  agent: "openclaw" | "hermes",
  inference: AgentTurnInference,
  progress?: Pick<TestProgress, "onOutput">,
): Promise<void> {
  const result = await host.command("node", [CLI, name, "destroy", "--yes"], {
    artifactName: `cleanup-${agent}-destroy`,
    env: env(name, agent, inference),
    onOutput: progress?.onOutput,
    timeoutMs: 120_000,
  });
  const output = resultText(result);
  expect(
    result.exitCode === 0 ||
      /Sandbox '.+' does not exist|Run 'nemoclaw onboard' to create one|sandbox .* not found|no such sandbox/iu.test(
        output,
      ),
    `cleanup ${agent} sandbox ${name}: ${output}`,
  ).toBe(true);
}

export async function route(
  sandbox: SandboxClient,
  sandboxName: string,
  agent: "openclaw" | "hermes",
  inference: AgentTurnInference,
  artifactName: string,
  progress?: Pick<TestProgress, "onOutput">,
): Promise<ShellProbeResult> {
  return await sandbox.openshell(["inference", "get", "-g", "nemoclaw"], {
    artifactName,
    env: env(sandboxName, agent, inference),
    onOutput: progress?.onOutput,
    timeoutMs: 30_000,
  });
}

export async function openclawTurn(
  sandbox: SandboxClient,
  inference: AgentTurnInference,
  progress?: Pick<TestProgress, "onOutput">,
): Promise<{ result: ShellProbeResult; elapsedMs: number }> {
  const started = process.hrtime.bigint();
  const result = await sandbox.execShell(
    OPENCLAW_SANDBOX,
    trustedSandboxShellScript(
      "openclaw agent --agent main --json --thinking off --session-id e2e-turn-latency -m 'What is 6 multiplied by 7? Reply with only the integer, no extra words.'",
    ),
    {
      artifactName: "openclaw-agent-turn",
      env: env(OPENCLAW_SANDBOX, "openclaw", inference),
      onOutput: progress?.onOutput,
      redactionValues: inference.redactionValues(),
      timeoutMs: (MAX_TURN_SECONDS + 30) * 1000,
    },
  );
  return { result, elapsedMs: msSince(started) };
}

export async function waitHermesHealth(
  sandbox: SandboxClient,
  inference: AgentTurnInference,
  progress?: Pick<TestProgress, "onOutput">,
): Promise<ShellProbeResult> {
  return await sandbox.execShell(
    HERMES_SANDBOX,
    trustedSandboxShellScript(
      "for attempt in $(seq 1 10); do body=$(curl -sf --max-time 10 http://localhost:8642/health 2>/dev/null || true); printf '%s' \"$body\" | grep -qi '\"ok\"' && { printf '%s' \"$body\"; exit 0; }; sleep 5; done; printf '%s' \"$body\"; exit 1",
    ),
    {
      artifactName: "hermes-health",
      env: env(HERMES_SANDBOX, "hermes", inference),
      onOutput: progress?.onOutput,
      timeoutMs: 90_000,
    },
  );
}

export function openclawConfigCommand(): string {
  const script =
    "const fs=require('node:fs');" +
    "function redact(value){" +
    "if(Array.isArray(value))return value.map(redact);" +
    "if(value&&typeof value==='object'){" +
    "const out={};" +
    "for(const [key,entry] of Object.entries(value)){" +
    "out[key]=/api[_-]?key|token|secret|credential/i.test(key)?'[REDACTED]':redact(entry);" +
    "}" +
    "return out;" +
    "}" +
    "return value;" +
    "}" +
    "console.log(JSON.stringify(redact(JSON.parse(fs.readFileSync('/sandbox/.openclaw/openclaw.json','utf8'))),null,2));";
  return `node -e ${JSON.stringify(script)}`;
}

export function assertNoOpenClawTransportErrors(output: string): void {
  expect(output).not.toMatch(
    /SsrFBlockedError|transport error|ECONNREFUSED|EAI_AGAIN|gateway unavailable|network connection error/i,
  );
}

export function hermesTurnCommand(payload: string): string {
  return `set -a; [ ! -f /sandbox/.hermes/.env ] || . /sandbox/.hermes/.env; set +a; tmp=$(mktemp); if [ -n \"\${API_SERVER_KEY:-}\" ]; then code=$(curl -sS -o \"$tmp\" -w '%{http_code}' --max-time ${MAX_TURN_SECONDS} http://localhost:8642/v1/chat/completions -H 'Content-Type: application/json' -H \"Authorization: Bearer \${API_SERVER_KEY}\" -d '${payload.replace(/'/gu, `'\\''`)}'); else code=$(curl -sS -o \"$tmp\" -w '%{http_code}' --max-time ${MAX_TURN_SECONDS} http://localhost:8642/v1/chat/completions -H 'Content-Type: application/json' -d '${payload.replace(/'/gu, `'\\''`)}'); fi; rc=$?; cat \"$tmp\"; rm -f \"$tmp\"; printf '\\n__NEMOCLAW_HTTP_STATUS__=%s\\n' \"\${code:-000}\"; exit \"$rc\"`;
}
