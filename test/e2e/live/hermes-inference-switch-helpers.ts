// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { resolveAgentInferenceApi } from "../../../src/lib/inference/config.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import { expect } from "../fixtures/e2e-test.ts";
import type { FakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { DEFAULT_HOSTED_INFERENCE_MODEL } from "../fixtures/hosted-inference.ts";
import {
  closeServer,
  writeJsonResponse as jsonResponse,
  writeSseEvents,
} from "../fixtures/http-protocol.ts";
import {
  inferenceResponseModel,
  inferenceSetAttemptCount,
  runInferenceSetWithRetry,
} from "../fixtures/inference-switch-retry.ts";
import { CLI_ENTRYPOINT, REPO_ROOT } from "../fixtures/paths.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { stripAnsi } from "./json-envelope.ts";
import { isTransientProviderValidationFailure } from "./network-policy-transient-provider.ts";
import {
  PUBLIC_NVIDIA_SWITCH_MODEL,
  PUBLIC_NVIDIA_SWITCH_PROVIDER,
} from "./public-nvidia-switch-provider.ts";

export { REPO_ROOT };

export const CLI = CLI_ENTRYPOINT;
export const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-hermes-inference-switch";
validateSandboxName(SANDBOX_NAME);
const USE_COMPATIBLE_HOSTED = process.env.NEMOCLAW_E2E_USE_HOSTED_INFERENCE === "1";
export const SWITCH_PROVIDER =
  process.env.NEMOCLAW_SWITCH_PROVIDER ?? PUBLIC_NVIDIA_SWITCH_PROVIDER;
export const SWITCH_MODEL = process.env.NEMOCLAW_SWITCH_MODEL ?? PUBLIC_NVIDIA_SWITCH_MODEL;
export const SWITCH_API = process.env.NEMOCLAW_SWITCH_INFERENCE_API ?? "openai-completions";
export const RUNTIME_SWITCH_API =
  resolveAgentInferenceApi("hermes", SWITCH_PROVIDER, SWITCH_API) ?? SWITCH_API;
const SWITCH_MOCK_PORT = Number.parseInt(process.env.NEMOCLAW_SWITCH_MOCK_PORT ?? "0", 10);
const INSTALL_ATTEMPTS = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true" ? 3 : 1;

interface MockCompatibleAnthropicProvider {
  endpointUrl: string;
  close(): Promise<void>;
}

export function compatibleAnthropicMetadataArgs(endpointUrl: string | null): string[] {
  return endpointUrl
    ? ["--endpoint-url", endpointUrl, "--credential-env", "COMPATIBLE_ANTHROPIC_API_KEY"]
    : [];
}

export function mockAnthropicEndpointUrl(
  port: number,
  runtimeEnv: NodeJS.ProcessEnv = process.env,
): string {
  const host = runtimeEnv.NEMOCLAW_SWITCH_MOCK_HOST ?? "host.openshell.internal";
  return `http://${host}:${port}`;
}

export function openAiSurfaceEndpointUrl(endpointUrl: string): string {
  const trimmed = endpointUrl.replace(/\/+$/u, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

export function mockAnthropicSwitchEnabled(runtimeEnv: NodeJS.ProcessEnv = process.env): boolean {
  return (
    (runtimeEnv.NEMOCLAW_SWITCH_PROVIDER ?? SWITCH_PROVIDER) === "compatible-anthropic-endpoint" &&
    (runtimeEnv.NEMOCLAW_SWITCH_INFERENCE_API ?? SWITCH_API) === "anthropic-messages" &&
    runtimeEnv.NEMOCLAW_SWITCH_MOCK_ANTHROPIC === "1"
  );
}

export function expectAuthenticatedBaselineRequest(
  baseline: Pick<FakeOpenAiCompatibleServer, "requests"> | undefined,
  model: string,
): void {
  if (!baseline) return;
  expect(baseline.requests()).toContainEqual(
    expect.objectContaining({
      auth: "ok",
      model,
      path: "/v1/chat/completions",
    }),
  );
}

export function hostedInstallModel(runtimeEnv: NodeJS.ProcessEnv = process.env): string {
  return (
    runtimeEnv.NEMOCLAW_MODEL ?? runtimeEnv.NEMOCLAW_COMPAT_MODEL ?? DEFAULT_HOSTED_INFERENCE_MODEL
  );
}

export function openshellGatewayName(runtimeEnv: NodeJS.ProcessEnv = process.env): string {
  return runtimeEnv.OPENSHELL_GATEWAY ?? "nemoclaw";
}

export function env(apiKey?: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_AGENT: "hermes",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: openshellGatewayName(),
  };
  apiKey && Object.assign(out, { NVIDIA_INFERENCE_API_KEY: apiKey });
  USE_COMPATIBLE_HOSTED &&
    apiKey &&
    Object.assign(out, {
      COMPATIBLE_API_KEY: apiKey,
      NEMOCLAW_MODEL: hostedInstallModel(),
      NEMOCLAW_COMPAT_MODEL: hostedInstallModel(),
      NEMOCLAW_ENDPOINT_URL:
        process.env.NEMOCLAW_ENDPOINT_URL ?? "https://inference-api.nvidia.com/v1",
      NEMOCLAW_PREFERRED_API: process.env.NEMOCLAW_PREFERRED_API ?? "openai-completions",
      NEMOCLAW_PROVIDER: "custom",
    });
  return { ...out, ...extra };
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

export function parseInferenceRoute(text: string): { provider: string; model: string } {
  const plain = stripAnsi(text);
  const provider = plain.match(/^\s*Provider:\s*(.*?)\s*$/mu)?.[1]?.trim() ?? "";
  const model = plain.match(/^\s*Model:\s*(.*?)\s*$/mu)?.[1]?.trim() ?? "";
  return { provider, model };
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

export async function runHermesPongWithRetry(options: {
  attempts?: number;
  delay?: (milliseconds: number) => Promise<void>;
  expectedModel: string;
  run: (attempt: number) => Promise<ShellProbeResult>;
}): Promise<ShellProbeResult> {
  const attempts = options.attempts ?? 3;
  const delay =
    options.delay ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let last: ShellProbeResult | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await options.run(attempt);
    let pong = false;
    if (last.exitCode === 0) {
      try {
        pong =
          inferenceResponseModel(last.stdout) === options.expectedModel &&
          /PONG/iu.test(chatContent(last.stdout));
      } catch {}
    }
    if (pong || attempt === attempts) return last;
    await delay(5_000);
  }
  throw new Error("Hermes live probe retry loop completed without running an attempt.");
}

export async function runHermesCliPongWithRetry(options: {
  attempts?: number;
  delay?: (milliseconds: number) => Promise<void>;
  run: (attempt: number) => Promise<ShellProbeResult>;
}): Promise<ShellProbeResult> {
  const attempts = options.attempts ?? 3;
  const delay =
    options.delay ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let last: ShellProbeResult | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await options.run(attempt);
    if ((last.exitCode === 0 && /\bPONG\b/iu.test(last.stdout)) || attempt === attempts)
      return last;
    await delay(5_000);
  }
  throw new Error("Hermes CLI retry loop completed without running an attempt.");
}

export async function cleanupHermesSwitch(
  host: HostCliClient,
  sandbox: SandboxClient,
): Promise<void> {
  await bestEffort(() =>
    host.command("node", [CLI, SANDBOX_NAME, "destroy", "--yes", "--cleanup-gateway"], {
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

function sseResponse(res: http.ServerResponse, events: Array<[string, unknown]>): void {
  writeSseEvents(res, events);
}

function openAiSseResponse(res: http.ServerResponse, chunks: unknown[]): void {
  writeSseEvents(
    res,
    chunks.map((chunk) => [undefined, chunk] as const),
    true,
  );
}

async function startMockAnthropicProvider(): Promise<MockCompatibleAnthropicProvider> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://mock.local");
    if (req.method === "GET" && url.pathname === "/health")
      return jsonResponse(res, 200, { ok: true });
    if (
      req.method === "GET" &&
      ["/v1/models", "/v1/models/mock-anthropic-model"].includes(url.pathname)
    ) {
      return jsonResponse(res, 200, { data: [{ id: "mock-anthropic-model" }] });
    }
    const isAnthropicMessages = url.pathname === "/v1/messages";
    const isOpenAiChatCompletions = url.pathname === "/v1/chat/completions";
    if (req.method !== "POST" || (!isAnthropicMessages && !isOpenAiChatCompletions)) {
      return jsonResponse(res, 404, { error: "not found", path: url.pathname });
    }
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const payload = JSON.parse(raw || "{}") as { model?: unknown; stream?: unknown };
      const model = typeof payload.model === "string" ? payload.model : "mock-anthropic-model";
      if (isOpenAiChatCompletions) {
        if (payload.stream === true) {
          return openAiSseResponse(res, [
            {
              id: "chatcmpl_mock",
              object: "chat.completion.chunk",
              created: 0,
              model,
              choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
            },
            {
              id: "chatcmpl_mock",
              object: "chat.completion.chunk",
              created: 0,
              model,
              choices: [{ index: 0, delta: { content: "PONG" }, finish_reason: null }],
            },
            {
              id: "chatcmpl_mock",
              object: "chat.completion.chunk",
              created: 0,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            },
          ]);
        }
        return jsonResponse(res, 200, {
          id: "chatcmpl_mock",
          object: "chat.completion",
          created: 0,
          model,
          choices: [
            { index: 0, message: { role: "assistant", content: "PONG" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      if (payload.stream === true) {
        return sseResponse(res, [
          [
            "message_start",
            {
              type: "message_start",
              message: {
                id: "msg_mock",
                type: "message",
                role: "assistant",
                model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            },
          ],
          [
            "content_block_start",
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
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
      }
      return jsonResponse(res, 200, {
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
  return {
    endpointUrl: mockAnthropicEndpointUrl((address as AddressInfo).port),
    close: () => closeServer(server),
  };
}

export async function ensureCompatibleAnthropicSwitchProvider(
  host: HostCliClient,
  cleanup: { add(name: string, run: () => Promise<void> | void): void },
): Promise<string | null> {
  if (SWITCH_PROVIDER !== "compatible-anthropic-endpoint" || SWITCH_API !== "anthropic-messages")
    return null;
  const mock = mockAnthropicSwitchEnabled() ? await startMockAnthropicProvider() : undefined;
  mock && cleanup.add("close compatible Anthropic switch mock", () => mock.close());
  const endpointUrl = process.env.NEMOCLAW_SWITCH_ENDPOINT_URL ?? mock?.endpointUrl ?? "";
  const compatibleKey = process.env.COMPATIBLE_ANTHROPIC_API_KEY ?? "test-compatible-anthropic-key";
  expect(
    endpointUrl,
    "NEMOCLAW_SWITCH_ENDPOINT_URL is required for compatible Anthropic inference switches",
  ).not.toBe("");
  expect(
    compatibleKey,
    "COMPATIBLE_ANTHROPIC_API_KEY is required for compatible Anthropic inference switches",
  ).not.toBe("");
  const providerScript = [
    "set -euo pipefail",
    "if openshell provider get -g nemoclaw compatible-anthropic-endpoint >/dev/null 2>&1; then",
    "  openshell provider delete -g nemoclaw compatible-anthropic-endpoint",
    "fi",
    'openshell provider create -g nemoclaw --name compatible-anthropic-endpoint --type openai --credential COMPATIBLE_ANTHROPIC_API_KEY --config "OPENAI_BASE_URL=${SWITCH_OPENAI_ENDPOINT_URL}"',
  ].join("\n");
  const result = await host.command("bash", ["-lc", providerScript], {
    artifactName: "register-compatible-anthropic-switch-provider",
    env: env(undefined, {
      COMPATIBLE_ANTHROPIC_API_KEY: compatibleKey,
      SWITCH_OPENAI_ENDPOINT_URL: openAiSurfaceEndpointUrl(endpointUrl),
    }),
    redactionValues: [compatibleKey],
    timeoutMs: 120_000,
  });
  expect(result.exitCode).toBe(0);
  return endpointUrl;
}

export async function installHermes(
  host: HostCliClient,
  apiKey: string,
  installEnv: NodeJS.ProcessEnv = {},
): Promise<ShellProbeResult> {
  let install: ShellProbeResult | undefined;
  for (let attempt = 1; attempt <= INSTALL_ATTEMPTS; attempt += 1) {
    install = await host.command(
      "bash",
      ["install.sh", "--non-interactive", "--fresh", "--yes-i-accept-third-party-software"],
      {
        artifactName: attempt === 1 ? "install-hermes" : `install-hermes-attempt-${attempt}`,
        cwd: REPO_ROOT,
        env: env(apiKey, installEnv),
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

export async function runHermesInferenceSetWithRetry(
  host: HostCliClient,
  redactionValues: string[],
  compatibleMetadataArgs: string[],
  options: { attempts?: number; delay?: (milliseconds: number) => Promise<void> } = {},
): Promise<ShellProbeResult> {
  const args = [
    CLI,
    "inference",
    "set",
    "--provider",
    SWITCH_PROVIDER,
    "--model",
    SWITCH_MODEL,
    ...compatibleMetadataArgs,
  ];
  return runInferenceSetWithRetry({
    attempts:
      options.attempts ?? inferenceSetAttemptCount(process.env.NEMOCLAW_SWITCH_SET_ATTEMPTS),
    delay: options.delay,
    run: (attempt, verify) =>
      host.command("node", verify ? args : [...args, "--no-verify"], {
        artifactName: verify
          ? `hermes-inference-set-${attempt}`
          : "hermes-inference-set-no-verify-after-transient-failures",
        env: env(),
        redactionValues,
        timeoutMs: 180_000,
      }),
  });
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
  return RUNTIME_SWITCH_API === "anthropic-messages"
    ? "https://inference.local"
    : "https://inference.local/v1";
}

export function inferenceLocalMaxTokens(api: string = RUNTIME_SWITCH_API): number {
  return api === "anthropic-messages" ? 32 : 100;
}

export function expectedApiMode(): string | undefined {
  return new Map<string, string>([
    ["anthropic-messages", "anthropic_messages"],
    ["openai-responses", "codex_responses"],
  ]).get(RUNTIME_SWITCH_API);
}

// This live lane runs on ubuntu-latest and intentionally uses GNU grep's
// POSIX ERE character classes; support tests pin the accepted scalar shapes.
export const API_KEY_SHAPE_PATTERN = `^[[:space:]]*api_key:[[:space:]]*("sk-[^"[:space:]]+"|'sk-[^'[:space:]]+'|sk-[^"'[:space:]]+)[[:space:]]*$`;

export function apiKeyShapeCommand(): string[] {
  return ["grep", "-Eq", API_KEY_SHAPE_PATTERN, "/sandbox/.hermes/config.yaml"];
}

export async function apiKeyShape(sandbox: SandboxClient): Promise<ShellProbeResult> {
  return await sandbox.exec(SANDBOX_NAME, apiKeyShapeCommand(), {
    artifactName: "hermes-config-api-key-shape",
    env: env(),
    timeoutMs: 30_000,
  });
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
  return RUNTIME_SWITCH_API === "anthropic-messages"
    ? `curl -sS --max-time 90 https://inference.local/v1/messages -H 'Content-Type: application/json' -H 'anthropic-version: 2023-06-01' -d '${quotePayload(payload)}'`
    : `curl -sS --max-time 90 https://inference.local/v1/chat/completions -H 'Content-Type: application/json' -d '${quotePayload(payload)}'`;
}

export function hermesApiCommand(payload: string): string {
  return `set -a; [ ! -f /sandbox/.hermes/.env ] || . /sandbox/.hermes/.env; set +a; curl -sS --max-time 120 http://localhost:8642/v1/chat/completions -H 'Content-Type: application/json' -H "Authorization: Bearer \${API_SERVER_KEY:-}" -d '${quotePayload(payload)}'`;
}
