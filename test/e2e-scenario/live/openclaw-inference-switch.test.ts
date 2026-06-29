// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live Vitest migration for test/e2e/test-openclaw-inference-switch.sh.
 *
 * Preserve the script's real user-visible boundary: install.sh onboards an
 * OpenClaw sandbox, `nemoclaw inference set` switches the running route, then
 * OpenShell route state, OpenClaw config/hash state, registry/session state,
 * inference.local, and a real OpenClaw agent turn are checked from the live
 * host/sandbox boundary. Helpers stay local because this is one focused
 * free-standing migration rather than a new shared fixture family.
 */

import fs from "node:fs";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import {
  inferenceSetAttemptCount,
  runInferenceSetWithRetry,
} from "../fixtures/inference-switch-retry.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const SANDBOX_NAME =
  process.env.NEMOCLAW_SANDBOX_NAME ?? uniqueSandboxName("e2e-openclaw-inference-switch");
const USE_COMPATIBLE_HOSTED = process.env.NEMOCLAW_E2E_USE_HOSTED_INFERENCE === "1";
const DEFAULT_COMPAT_MODEL = "nvidia/nvidia/nemotron-3-super-v3";
const SWITCH_PROVIDER =
  process.env.NEMOCLAW_SWITCH_PROVIDER ??
  (USE_COMPATIBLE_HOSTED ? "compatible-endpoint" : "nvidia-prod");
const SWITCH_MODEL =
  process.env.NEMOCLAW_SWITCH_MODEL ??
  (USE_COMPATIBLE_HOSTED ? DEFAULT_COMPAT_MODEL : "z-ai/glm-5.1");
const SWITCH_INFERENCE_API = process.env.NEMOCLAW_SWITCH_INFERENCE_API ?? "openai-completions";
const SWITCH_MOCK_ANTHROPIC = process.env.NEMOCLAW_SWITCH_MOCK_ANTHROPIC ?? "0";
const SWITCH_MOCK_PORT = parsePortEnv("NEMOCLAW_SWITCH_MOCK_PORT", 0);
const TEST_TIMEOUT_MS = 75 * 60_000;
const INSTALL_TIMEOUT_MS = 30 * 60_000;
const COMMAND_TIMEOUT_MS = 120_000;
const INFERENCE_TIMEOUT_MS = 150_000;
const AGENT_TIMEOUT_MS = 150_000;
const RUN_OPENCLAW_INFERENCE_SWITCH_TEST = shouldRunLiveE2EScenarios() ? test : test.skip;

validateSandboxName(SANDBOX_NAME);

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
      reasoning_content?: unknown;
      reasoning?: unknown;
    };
    text?: unknown;
  }>;
}

interface AnthropicResponse {
  content?: Array<{ text?: unknown }>;
}

interface OpenClawConfig {
  agents?: {
    defaults?: {
      model?: {
        primary?: unknown;
      };
    };
  };
  models?: {
    providers?: Record<
      string,
      {
        baseUrl?: unknown;
        api?: unknown;
        models?: Array<{ id?: unknown; name?: unknown }>;
      }
    >;
  };
}

interface SandboxRegistry {
  sandboxes?: Record<
    string,
    {
      provider?: unknown;
      model?: unknown;
      endpointUrl?: unknown;
      credentialEnv?: unknown;
      preferredInferenceApi?: unknown;
      nimContainer?: unknown;
    }
  >;
}

interface OnboardSession {
  sandboxName?: unknown;
  provider?: unknown;
  model?: unknown;
  endpointUrl?: unknown;
  credentialEnv?: unknown;
  preferredInferenceApi?: unknown;
}

interface MockAnthropicProvider {
  endpointUrl: string;
  close(): Promise<void>;
}

function resultText(result: Pick<ShellProbeResult, "stdout" | "stderr">): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function uniqueSandboxName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}`;
}

function parsePortEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`${name} must be an integer between 0 and 65535; got ${raw}`);
  }
  return parsed;
}

function commandEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const base = buildAvailabilityProbeEnv();
  return {
    ...base,
    HOME: home,
    PATH: [path.join(home, ".local", "bin"), path.join(home, ".npm-global", "bin"), base.PATH]
      .filter(Boolean)
      .join(":"),
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
    ...extra,
  };
}

async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup probes are intentionally best-effort so early setup failures do
    // not hide the primary assertion or install failure.
  }
}

async function runNemoclaw(
  host: HostCliClient,
  home: string,
  args: string[],
  options: { artifactName: string; timeoutMs?: number; redactionValues?: string[] } = {
    artifactName: "nemoclaw",
  },
): Promise<ShellProbeResult> {
  return host.command("node", [CLI_ENTRYPOINT, ...args], {
    artifactName: options.artifactName,
    env: commandEnv(home),
    timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    redactionValues: options.redactionValues,
  });
}

function singleLineSandboxShellScript(script: string): string {
  if (!/[\r\n]/.test(script)) return script;
  return `printf '%s' ${shellQuote(Buffer.from(script, "utf8").toString("base64"))} | base64 -d | sh`;
}

async function sandboxShell(
  sandbox: SandboxClient,
  home: string,
  script: string,
  options: { artifactName: string; timeoutMs?: number; redactionValues?: string[] },
): Promise<ShellProbeResult> {
  return sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript(singleLineSandboxShellScript(script)),
    {
      artifactName: options.artifactName,
      env: commandEnv(home),
      timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
      redactionValues: options.redactionValues,
    },
  );
}

async function cleanupOpenClawInferenceSwitchState(
  host: HostCliClient,
  sandbox: SandboxClient,
  home: string,
  artifactPrefix: string,
): Promise<void> {
  await bestEffort(() =>
    runNemoclaw(host, home, [SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: `${artifactPrefix}-nemoclaw-destroy-openclaw-inference-switch`,
      timeoutMs: 120_000,
    }),
  );
  await bestEffort(() =>
    sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: `${artifactPrefix}-openshell-sandbox-delete-openclaw-inference-switch`,
      env: commandEnv(home),
      timeoutMs: 60_000,
    }),
  );
  await bestEffort(() =>
    sandbox.openshell(["gateway", "destroy", "-g", "nemoclaw"], {
      artifactName: `${artifactPrefix}-openshell-gateway-destroy-openclaw-inference-switch`,
      env: commandEnv(home),
      timeoutMs: 120_000,
    }),
  );
}

function jsonResponse(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sseResponse(res: http.ServerResponse, events: Array<[string, unknown]>): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  for (const [name, payload] of events) {
    res.write(`event: ${name}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
  res.end();
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function startMockAnthropicProvider(): Promise<MockAnthropicProvider> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://mock.local");
    if (req.method === "GET" && url.pathname === "/health") {
      jsonResponse(res, 200, { ok: true });
      return;
    }
    if (
      req.method === "GET" &&
      ["/v1/models", "/v1/models/mock-anthropic-model"].includes(url.pathname)
    ) {
      jsonResponse(res, 200, { data: [{ id: "mock-anthropic-model" }] });
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/v1/messages") {
      jsonResponse(res, 404, { error: "not found", path: url.pathname });
      return;
    }

    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let payload: { model?: unknown; stream?: unknown } = {};
      try {
        payload = JSON.parse(raw || "{}") as { model?: unknown; stream?: unknown };
      } catch {
        payload = {};
      }
      const model = typeof payload.model === "string" ? payload.model : "mock-anthropic-model";
      if (payload.stream === true) {
        const message = {
          id: "msg_mock",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        };
        sseResponse(res, [
          ["message_start", { type: "message_start", message }],
          [
            "content_block_start",
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            },
          ],
          [
            "content_block_delta",
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "PONG" } },
          ],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          [
            "message_delta",
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 1 },
            },
          ],
          ["message_stop", { type: "message_stop" }],
        ]);
        return;
      }
      jsonResponse(res, 200, {
        id: "msg_mock",
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: "PONG" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(SWITCH_MOCK_PORT, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("mock Anthropic provider did not expose a TCP port");
  }
  const port = (address as AddressInfo).port;
  return {
    endpointUrl: `http://host.openshell.internal:${port}`,
    close: () => closeServer(server),
  };
}

async function ensureCompatibleAnthropicSwitchProvider(
  host: HostCliClient,
  home: string,
  mockProvider: MockAnthropicProvider | undefined,
): Promise<string | null> {
  if (SWITCH_PROVIDER !== "compatible-anthropic-endpoint") return null;
  if (SWITCH_INFERENCE_API !== "anthropic-messages") return null;

  const endpointUrl = process.env.NEMOCLAW_SWITCH_ENDPOINT_URL ?? mockProvider?.endpointUrl ?? "";
  const apiKey = process.env.COMPATIBLE_ANTHROPIC_API_KEY ?? "test-compatible-anthropic-key";
  expect(
    endpointUrl,
    "NEMOCLAW_SWITCH_ENDPOINT_URL is required for compatible Anthropic inference switches",
  ).not.toBe("");
  expect(
    apiKey,
    "COMPATIBLE_ANTHROPIC_API_KEY is required for compatible Anthropic inference switches",
  ).not.toBe("");

  const providerScript = [
    "set -euo pipefail",
    "if openshell provider get -g nemoclaw compatible-anthropic-endpoint >/dev/null 2>&1; then",
    '  openshell provider update -g nemoclaw compatible-anthropic-endpoint --credential COMPATIBLE_ANTHROPIC_API_KEY --config "ANTHROPIC_BASE_URL=${SWITCH_ENDPOINT_URL}"',
    "else",
    '  openshell provider create -g nemoclaw --name compatible-anthropic-endpoint --type anthropic --credential COMPATIBLE_ANTHROPIC_API_KEY --config "ANTHROPIC_BASE_URL=${SWITCH_ENDPOINT_URL}"',
    "fi",
  ].join("\n");
  const provider = await host.command("bash", ["-lc", providerScript], {
    artifactName: "register-compatible-anthropic-switch-provider",
    env: commandEnv(home, {
      COMPATIBLE_ANTHROPIC_API_KEY: apiKey,
      SWITCH_ENDPOINT_URL: endpointUrl,
    }),
    redactionValues: [apiKey],
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  expect(provider.exitCode, resultText(provider)).toBe(0);
  return endpointUrl;
}

async function openclawGatewayPid(sandbox: SandboxClient, home: string): Promise<string> {
  const result = await sandboxShell(
    sandbox,
    home,
    'ps -eo pid=,comm=,args= 2>/dev/null | awk \'$2 != "sh" && $2 != "bash" && $2 != "awk" && $0 ~ /openclaw/ && $0 ~ /gateway run/ { print $1; exit }\' || true',
    {
      artifactName: "openclaw-gateway-pid",
      timeoutMs: 30_000,
    },
  );
  return result.stdout.trim();
}

async function getRouteOutput(host: HostCliClient, home: string): Promise<ShellProbeResult> {
  return host.command(
    "bash",
    ["-lc", "openshell inference get -g nemoclaw 2>&1 || openshell inference get 2>&1"],
    {
      artifactName: "openshell-inference-get-after-switch",
      env: commandEnv(home),
      timeoutMs: COMMAND_TIMEOUT_MS,
    },
  );
}

async function assertOpenShellRoute(host: HostCliClient, home: string): Promise<void> {
  const route = await getRouteOutput(host, home);
  expect(route.exitCode, resultText(route)).toBe(0);
  const plain = stripAnsi(resultText(route));
  expect(plain).toContain(`Provider: ${SWITCH_PROVIDER}`);
  expect(plain).toContain(`Model: ${SWITCH_MODEL}`);
}

async function assertRegistryAndSession(
  home: string,
  options: { hostedEndpointUrl: string; mockProvider?: MockAnthropicProvider },
): Promise<void> {
  const registryPath = path.join(home, ".nemoclaw", "sandboxes.json");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8")) as SandboxRegistry;
  const sandbox = registry.sandboxes?.[SANDBOX_NAME];
  expect(sandbox, `sandbox ${SANDBOX_NAME} missing from registry`).toBeTruthy();
  expect(sandbox?.provider).toBe(SWITCH_PROVIDER);
  expect(sandbox?.model).toBe(SWITCH_MODEL);
  expect(sandbox?.nimContainer).toBeNull();
  switch (SWITCH_PROVIDER) {
    case "compatible-endpoint":
      expect(sandbox?.endpointUrl).toBe(options.hostedEndpointUrl);
      expect(sandbox?.credentialEnv).toBe("COMPATIBLE_API_KEY");
      expect(sandbox?.preferredInferenceApi).toBe("openai-completions");
      break;
    case "compatible-anthropic-endpoint":
      expect(sandbox?.endpointUrl).toBe(
        process.env.NEMOCLAW_SWITCH_ENDPOINT_URL ?? options.mockProvider?.endpointUrl,
      );
      expect(sandbox?.credentialEnv).toBe("COMPATIBLE_ANTHROPIC_API_KEY");
      expect(sandbox?.preferredInferenceApi).toBe("anthropic-messages");
      break;
    default:
      expect(sandbox?.endpointUrl).toBeNull();
      expect(sandbox?.credentialEnv).toBe(sandbox?.provider === SWITCH_PROVIDER ? null : undefined);
      expect(sandbox?.preferredInferenceApi).toBeNull();
  }

  const sessionPath = path.join(home, ".nemoclaw", "onboard-session.json");
  const session = JSON.parse(fs.readFileSync(sessionPath, "utf8")) as OnboardSession;
  expect(Object.keys(session).length, "onboard session is empty").toBeGreaterThan(0);
  expect(session.sandboxName).toBe(SANDBOX_NAME);
  expect(session.provider).toBe(SWITCH_PROVIDER);
  expect(session.model).toBe(SWITCH_MODEL);
  switch (SWITCH_PROVIDER) {
    case "compatible-endpoint":
      expect(session.preferredInferenceApi).toBe("openai-completions");
      break;
    case "compatible-anthropic-endpoint":
      expect(session.preferredInferenceApi).toBe("anthropic-messages");
      break;
  }
}

async function assertOpenClawConfig(sandbox: SandboxClient, home: string): Promise<void> {
  const configResult = await sandbox.exec(
    SANDBOX_NAME,
    ["cat", "/sandbox/.openclaw/openclaw.json"],
    {
      artifactName: "read-openclaw-config-after-inference-switch",
      env: commandEnv(home),
      timeoutMs: COMMAND_TIMEOUT_MS,
    },
  );
  expect(configResult.exitCode, resultText(configResult)).toBe(0);
  const config = JSON.parse(configResult.stdout) as OpenClawConfig;
  const expectedProviderKey =
    SWITCH_INFERENCE_API === "anthropic-messages" ? "anthropic" : "inference";
  const expectedPrimary = `${expectedProviderKey}/${SWITCH_MODEL}`;
  const provider = config.models?.providers?.[expectedProviderKey];
  const firstModel = provider?.models?.[0];

  expect(config.agents?.defaults?.model?.primary).toBe(expectedPrimary);
  expect(provider?.baseUrl).toBe(
    SWITCH_INFERENCE_API === "anthropic-messages"
      ? "https://inference.local"
      : "https://inference.local/v1",
  );
  expect(provider?.api).toBe(SWITCH_INFERENCE_API);
  expect(firstModel?.id).toBe(SWITCH_MODEL);
  expect(firstModel?.name).toBe(expectedPrimary);

  const hashCheck = await sandboxShell(
    sandbox,
    home,
    "cd /sandbox/.openclaw && sha256sum -c .config-hash --status && echo OK",
    {
      artifactName: "openclaw-config-hash-after-inference-switch",
      timeoutMs: COMMAND_TIMEOUT_MS,
    },
  );
  expect(hashCheck.exitCode, resultText(hashCheck)).toBe(0);
  expect(hashCheck.stdout.trim()).toBe("OK");
}

function isTransientLiveHttpCode(status: string): boolean {
  return ["502", "503", "504"].includes(status);
}

function httpStatusFromResponse(response: string): string {
  return (
    response
      .split("\n")
      .filter((line) => line.startsWith("__NEMOCLAW_HTTP_STATUS__="))
      .at(-1)
      ?.replace("__NEMOCLAW_HTTP_STATUS__=", "")
      .trim() ?? ""
  );
}

function httpBodyFromResponse(response: string): string {
  return response
    .split("\n")
    .filter((line) => !line.startsWith("__NEMOCLAW_HTTP_STATUS__="))
    .join("\n");
}

function parseChatContent(raw: string): string {
  const response = JSON.parse(raw) as ChatCompletionResponse;
  return (response.choices ?? [])
    .map((choice) => {
      const message = choice.message ?? {};
      if (typeof message.content === "string") return message.content;
      if (typeof message.reasoning_content === "string") return message.reasoning_content;
      if (typeof message.reasoning === "string") return message.reasoning;
      if (typeof choice.text === "string") return choice.text;
      return "";
    })
    .join("\n")
    .trim();
}

function parseAnthropicContent(raw: string): string {
  const response = JSON.parse(raw) as AnthropicResponse;
  return (response.content ?? [])
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join(" ")
    .trim();
}

async function checkSandboxInference(
  sandbox: SandboxClient,
  home: string,
): Promise<"ok" | { skipped: string }> {
  const payload =
    SWITCH_INFERENCE_API === "anthropic-messages"
      ? {
          model: SWITCH_MODEL,
          messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
          max_tokens: 32,
        }
      : {
          model: SWITCH_MODEL,
          messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
          max_tokens: 100,
        };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const curlCommand =
    SWITCH_INFERENCE_API === "anthropic-messages"
      ? `curl -sS -o "$tmp" -w '%{http_code}' --max-time 90 https://inference.local/v1/messages -H 'Content-Type: application/json' -H 'anthropic-version: 2023-06-01' --data-binary @/tmp/nemoclaw-switch-payload.json`
      : `curl -sS -o "$tmp" -w '%{http_code}' --max-time 90 https://inference.local/v1/chat/completions -H 'Content-Type: application/json' --data-binary @/tmp/nemoclaw-switch-payload.json`;
  const script = [
    "set -u",
    "tmp=$(mktemp)",
    `printf '%s' ${shellQuote(payloadB64)} | base64 -d >/tmp/nemoclaw-switch-payload.json`,
    "set +e",
    `code=$(${curlCommand})`,
    "rc=$?",
    "set -e",
    'cat "$tmp"',
    'rm -f "$tmp" /tmp/nemoclaw-switch-payload.json',
    'printf "\\n__NEMOCLAW_HTTP_STATUS__=%s\\n" "${code:-000}"',
    'exit "$rc"',
  ].join("\n");

  let lastFailure = "not attempted";
  let transient = false;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    transient = false;
    const result = await sandboxShell(sandbox, home, script, {
      artifactName: `sandbox-inference-local-after-switch-${attempt}`,
      timeoutMs: INFERENCE_TIMEOUT_MS,
    });
    const response = resultText(result);
    const httpCode = httpStatusFromResponse(response) || "000";
    const body = httpBodyFromResponse(response);

    if (result.exitCode !== 0) {
      transient = result.exitCode === 28;
      lastFailure = `curl failed with exit ${result.exitCode}; HTTP ${httpCode}: ${body.slice(0, 300)}`;
    } else if (isTransientLiveHttpCode(httpCode)) {
      transient = true;
      lastFailure = `transient HTTP ${httpCode}: ${body.slice(0, 300)}`;
    } else if (httpCode !== "200") {
      lastFailure = `HTTP ${httpCode}: ${body.slice(0, 300)}`;
    } else {
      const content =
        SWITCH_INFERENCE_API === "anthropic-messages"
          ? parseAnthropicContent(body)
          : parseChatContent(body);
      if (/\bPONG\b/i.test(content)) return "ok";
      lastFailure = `expected PONG, got ${content.slice(0, 300)}`;
    }

    if (attempt < 3) await sleep(5_000);
  }

  if (transient) {
    return {
      skipped: `Sandbox inference.local transient failure after switch; route/config checks already passed: ${lastFailure}`,
    };
  }
  throw new Error(`Sandbox inference.local did not work after switch: ${lastFailure}`);
}

function collectOpenClawAgentText(value: unknown, parts: string[], visited: Set<unknown>): void {
  if (value === null || value === undefined || visited.has(value)) return;
  if (typeof value === "string") {
    if (value.trim()) parts.push(value.trim());
    return;
  }
  if (typeof value !== "object") return;
  visited.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectOpenClawAgentText(item, parts, visited);
    return;
  }

  const record = value as Record<string, unknown>;
  for (const key of ["text", "content", "reasoning_content"]) {
    const text = record[key];
    if (typeof text === "string" && text.trim()) parts.push(text.trim());
  }
  const choices = record.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!choice || typeof choice !== "object") continue;
      const choiceRecord = choice as Record<string, unknown>;
      collectOpenClawAgentText(choiceRecord.message, parts, visited);
      collectOpenClawAgentText(choiceRecord.delta, parts, visited);
      const text = choiceRecord.text;
      if (typeof text === "string" && text.trim()) parts.push(text.trim());
    }
  }
  for (const key of [
    "result",
    "payloads",
    "payload",
    "messages",
    "response",
    "data",
    "output",
    "outputs",
    "items",
    "segments",
    "delta",
  ]) {
    if (Object.hasOwn(record, key)) collectOpenClawAgentText(record[key], parts, visited);
  }
}

function agentReplyContainsToken(reply: string, expected: string): boolean {
  const normalizedReply = reply.replace(/\s+/gu, "").toUpperCase();
  const normalizedExpected = expected.replace(/\s+/gu, "").toUpperCase();
  return normalizedExpected.length > 0 && normalizedReply === normalizedExpected;
}

function parseOpenClawAgentText(raw: string): string {
  if (!raw.trim()) return "";
  const parts: string[] = [];
  try {
    const doc = JSON.parse(raw) as unknown;
    const root =
      doc && typeof doc === "object" && "result" in doc
        ? (doc as { result?: unknown }).result
        : doc;
    collectOpenClawAgentText(root, parts, new Set());
  } catch {
    const decoder = new RegExp("{", "g");
    let match: RegExpExecArray | null;
    while ((match = decoder.exec(raw)) !== null) {
      try {
        const doc = JSON.parse(raw.slice(match.index)) as unknown;
        const before = parts.length;
        const root =
          doc && typeof doc === "object" && "result" in doc
            ? (doc as { result?: unknown }).result
            : doc;
        collectOpenClawAgentText(root, parts, new Set());
        if (parts.length > before) break;
      } catch {
        // Try the next JSON-looking offset; wrappers sometimes print chatter
        // before the actual OpenClaw JSON envelope.
      }
    }
  }
  return parts.join("\n");
}

async function checkOpenClawAgentTurn(
  host: HostCliClient,
  home: string,
): Promise<"ok" | { skipped: string }> {
  const sessionId = `e2e-inference-switch-openclaw-${Date.now()}-${process.pid}`;
  const script = String.raw`
set -u
ssh_config="$(mktemp)"
stderr_file="$(mktemp)"
cleanup() { rm -f "$ssh_config" "$stderr_file"; }
trap cleanup EXIT
openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null || exit 70
run_with_timeout() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$@"
  else
    shift
    "$@"
  fi
}
set +e
run_with_timeout 120s ssh -F "$ssh_config" \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o ConnectTimeout=10 \
  -o LogLevel=ERROR \
  "openshell-${SANDBOX_NAME}" \
  "openclaw agent --agent main --json --session-id '$SESSION_ID' -m 'Reply with exactly one word: PONG'" \
  2>"$stderr_file"
rc=$?
set -e
printf '\n__NEMOCLAW_AGENT_STDERR__\n'
cat "$stderr_file" 2>/dev/null || true
exit "$rc"
`;
  const result = await host.command("bash", ["-lc", script], {
    artifactName: "openclaw-agent-turn-after-inference-switch",
    env: commandEnv(home, {
      SANDBOX_NAME,
      SESSION_ID: sessionId,
    }),
    timeoutMs: AGENT_TIMEOUT_MS,
  });
  const [raw = "", warnings = ""] = result.stdout.split("\n__NEMOCLAW_AGENT_STDERR__\n", 2);
  const reply = parseOpenClawAgentText(raw);
  if (result.exitCode === 0 && agentReplyContainsToken(reply, "PONG")) return "ok";
  if (result.exitCode === 124) {
    return {
      skipped: "OpenClaw agent turn timed out after switch; route/config checks already passed",
    };
  }
  throw new Error(
    [
      `OpenClaw agent turn failed after switch (exit ${result.exitCode})`,
      `reply=${reply.slice(0, 200)}`,
      `raw=${raw.slice(0, 200)}`,
      `stderr=${[warnings, result.stderr].filter(Boolean).join("\n").slice(0, 200)}`,
    ].join("; "),
  );
}

test("openclaw-inference-switch agent reply matching tolerates wrapped PONG", () => {
  expect(agentReplyContainsToken("P\nO N G", "PONG")).toBe(true);
  expect(agentReplyContainsToken("wrapped: p o\nng", "PONG")).toBe(false);
  expect(agentReplyContainsToken("the answer is PONG", "PONG")).toBe(false);
  expect(agentReplyContainsToken("PONG because the route works", "PONG")).toBe(false);
  expect(agentReplyContainsToken("PANG", "PONG")).toBe(false);
  expect(agentReplyContainsToken("SPONGE", "PONG")).toBe(false);
  expect(agentReplyContainsToken("pingpong", "PONG")).toBe(false);
});

function isExternalProviderValidationFailure(text: string): boolean {
  return (
    /NVIDIA Endpoints endpoint validation failed/i.test(text) &&
    /HTTP 429|rate limit|quota|temporarily unavailable|timed out|timeout/i.test(text)
  );
}

async function runOpenClawInferenceSetWithRetry(
  host: HostCliClient,
  home: string,
  redactionValues: string[],
  switchEndpointUrl: string | null,
): Promise<ShellProbeResult> {
  const attempts = inferenceSetAttemptCount(process.env.NEMOCLAW_SWITCH_SET_ATTEMPTS);
  const compatibleCredentialEnv = (() => {
    switch (SWITCH_PROVIDER) {
      case "compatible-endpoint":
        return "COMPATIBLE_API_KEY";
      case "compatible-anthropic-endpoint":
        return "COMPATIBLE_ANTHROPIC_API_KEY";
      default:
        return null;
    }
  })();
  const compatibleMetadataArgs = switchEndpointUrl
    ? [
        "--endpoint-url",
        switchEndpointUrl,
        "--credential-env",
        compatibleCredentialEnv ?? "",
        "--inference-api",
        SWITCH_INFERENCE_API,
      ]
    : [];
  const args = [
    "inference",
    "set",
    "--provider",
    SWITCH_PROVIDER,
    "--model",
    SWITCH_MODEL,
    "--sandbox",
    SANDBOX_NAME,
    ...compatibleMetadataArgs,
  ];

  return runInferenceSetWithRetry({
    attempts,
    run: (attempt, verify) =>
      runNemoclaw(host, home, verify ? args : [...args, "--no-verify"], {
        artifactName: verify
          ? `nemoclaw-inference-set-${attempt}`
          : "nemoclaw-inference-set-no-verify-after-transient-failures",
        redactionValues,
        timeoutMs: COMMAND_TIMEOUT_MS,
      }),
  });
}

RUN_OPENCLAW_INFERENCE_SWITCH_TEST(
  "openclaw-inference-switch: switches route and preserves live OpenClaw behavior",
  { timeout: TEST_TIMEOUT_MS },
  async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
    await artifacts.writeJson("scenario.json", {
      id: "openclaw-inference-switch",
      runner: "vitest",
      boundary: "install-sh-openclaw-inference-set-and-live-agent-turn",
      legacySource: "test/e2e/test-openclaw-inference-switch.sh",
      sandboxName: SANDBOX_NAME,
      switchProvider: SWITCH_PROVIDER,
      switchModel: SWITCH_MODEL,
      switchInferenceApi: SWITCH_INFERENCE_API,
      contracts: [
        "Docker is running and NVIDIA_INFERENCE_API_KEY is staged as the compatible endpoint credential",
        "install.sh --non-interactive onboards an OpenClaw sandbox",
        "nemoclaw inference set switches the running sandbox route",
        "OpenClaw gateway process stays running across the switch when its PID is observable",
        "OpenShell route points at the switched provider/model",
        "OpenClaw config and .config-hash reflect the switched inference API/model",
        "registry and onboard session record the switched provider/model",
        "sandbox inference.local returns PONG after the switch",
        "openclaw agent answers through the switched inference route",
      ],
    });

    expect(
      fs.existsSync(CLI_ENTRYPOINT),
      "run `npm run build:cli` before live repo CLI scenarios",
    ).toBe(true);

    const docker = await host.command("docker", ["info"], {
      artifactName: "prereq-docker-info-openclaw-inference-switch",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    if (docker.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") {
        throw new Error(
          `Docker is required for OpenClaw inference switch E2E: ${resultText(docker)}`,
        );
      }
      skip("Docker is required for OpenClaw inference switch E2E");
    }

    const hosted = requireHostedInferenceConfig(secrets);
    const apiKey = hosted.apiKey;

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-switch-home-"));
    let mockProvider: MockAnthropicProvider | undefined;
    cleanup.add(`destroy OpenClaw inference switch sandbox ${SANDBOX_NAME}`, async () => {
      await cleanupOpenClawInferenceSwitchState(host, sandbox, home, "cleanup");
      if (mockProvider) await mockProvider.close();
      fs.rmSync(home, { recursive: true, force: true });
    });

    await cleanupOpenClawInferenceSwitchState(host, sandbox, home, "pre-cleanup");

    const install = await host.command(
      "bash",
      ["install.sh", "--non-interactive", "--yes-i-accept-third-party-software"],
      {
        artifactName: "install-and-onboard-openclaw-inference-switch",
        cwd: REPO_ROOT,
        env: commandEnv(home, {
          ...hosted.env,
          NEMOCLAW_RECREATE_SANDBOX: "1",
        }),
        redactionValues: [apiKey],
        timeoutMs: INSTALL_TIMEOUT_MS,
      },
    );
    const installText = resultText(install);
    if (install.exitCode !== 0 && isExternalProviderValidationFailure(installText)) {
      await artifacts.writeJson("scenario-result.json", {
        id: "openclaw-inference-switch",
        status: "skipped",
        reason: "external-provider-validation-unavailable-before-inference-switch",
        installExitCode: install.exitCode,
      });
      skip("NVIDIA endpoint validation was unavailable/rate-limited during onboarding");
    }
    expect(install.exitCode, installText).toBe(0);

    if (SWITCH_PROVIDER === "compatible-anthropic-endpoint" && SWITCH_MOCK_ANTHROPIC === "1") {
      mockProvider = await startMockAnthropicProvider();
      await artifacts.writeJson("mock-anthropic-provider.json", {
        endpointUrl: mockProvider.endpointUrl,
      });
    }
    const switchEndpointUrl =
      SWITCH_PROVIDER === "compatible-endpoint"
        ? hosted.endpointUrl
        : await ensureCompatibleAnthropicSwitchProvider(host, home, mockProvider);

    const pidBefore = await openclawGatewayPid(sandbox, home);
    const switchResult = await runOpenClawInferenceSetWithRetry(
      host,
      home,
      [apiKey],
      switchEndpointUrl,
    );
    expect(switchResult.exitCode, resultText(switchResult)).toBe(0);

    const pidAfter = await openclawGatewayPid(sandbox, home);
    const gatewayPidStable = pidBefore && pidAfter ? pidBefore === pidAfter : null;
    if (gatewayPidStable !== null) {
      expect(
        gatewayPidStable,
        `OpenClaw gateway process changed (${pidBefore} -> ${pidAfter})`,
      ).toBe(true);
    }

    await assertOpenShellRoute(host, home);
    await assertOpenClawConfig(sandbox, home);
    await assertRegistryAndSession(home, { hostedEndpointUrl: hosted.endpointUrl, mockProvider });

    const inference = await checkSandboxInference(sandbox, home);
    if (inference !== "ok") {
      await artifacts.writeJson("scenario-result.json", {
        id: "openclaw-inference-switch",
        status: "skipped",
        reason: inference.skipped,
        routeAndConfigChecksPassed: true,
      });
      skip(inference.skipped);
    }

    const agentTurn = await checkOpenClawAgentTurn(host, home);
    if (agentTurn !== "ok") {
      await artifacts.writeJson("scenario-result.json", {
        id: "openclaw-inference-switch",
        status: "skipped",
        reason: agentTurn.skipped,
        routeConfigAndInferenceChecksPassed: true,
      });
      skip(agentTurn.skipped);
    }

    if (process.env.NEMOCLAW_E2E_KEEP_SANDBOX !== "1") {
      await cleanupOpenClawInferenceSwitchState(host, sandbox, home, "final");
      const registryPath = path.join(home, ".nemoclaw", "sandboxes.json");
      const registryText = fs.existsSync(registryPath) ? fs.readFileSync(registryPath, "utf8") : "";
      expect(registryText).not.toContain(`"${SANDBOX_NAME}"`);
    }

    await artifacts.writeJson("scenario-result.json", {
      id: "openclaw-inference-switch",
      status: "passed",
      assertions: {
        dockerRunning: docker.exitCode === 0,
        installCompleted: install.exitCode === 0,
        inferenceSetCompleted: switchResult.exitCode === 0,
        gatewayPidStable,
        routeChecked: true,
        configChecked: true,
        registryAndSessionChecked: true,
        inferenceLocalPong: true,
        openClawAgentPong: true,
      },
    });
  },
);
