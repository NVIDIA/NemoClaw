// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live Vitest migration for test/e2e/test-messaging-compatible-endpoint.sh.
 *
 * This stays intentionally direct: the legacy contract is the real
 * Docker/OpenShell/nemoclaw boundary with a local OpenAI-compatible endpoint
 * mock, Telegram messaging config, sandbox inference.local routing, and an
 * OpenClaw agent turn through the compatible endpoint proxy path.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { describe, it } from "vitest";

import type { HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  cleanupMessagingState,
  commandEnv,
  parseOpenClawAgentText,
  stopGatewayRuntime,
} from "./messaging-compatible-endpoint-helpers.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const CLI_DIST_ENTRYPOINT = path.join(REPO_ROOT, "dist", "nemoclaw.js");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-msg-compat";
const COMPAT_MODEL = process.env.NEMOCLAW_COMPAT_MODEL ?? "mock/deepseek-compatible";
const COMPATIBLE_KEY = process.env.NEMOCLAW_COMPAT_MOCK_API_KEY ?? "fake-compatible-key-e2e";
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "test-fake-telegram-token-e2e";
const TELEGRAM_IDS = process.env.TELEGRAM_ALLOWED_IDS ?? "123456789";
const MOCK_PORT = Number(process.env.NEMOCLAW_COMPAT_MOCK_PORT ?? "18089");
const ONBOARD_TIMEOUT_MS = 25 * 60_000;
const TEST_TIMEOUT_MS = 45 * 60_000;
const liveTest = shouldRunLiveE2EScenarios() ? test : test.skip;

validateSandboxName(SANDBOX_NAME);

const HOP_BY_HOP_HEADERS = new Set([
  "proxy-authorization",
  "proxy-connection",
  "proxy-authenticate",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const COMPAT_AGENT_REPLY = "COMPAT_MOCK_ROUTE_5098_OK";
const COMPAT_AGENT_PROMPT =
  "Call the configured model and report the compatible endpoint route token.";

function nodeEvalArg(source: string): string {
  const encoded = Buffer.from(source, "utf8").toString("base64");
  return `eval(Buffer.from(${JSON.stringify(encoded)}, "base64").toString("utf8"))`;
}

interface MockRequestLog {
  method: string;
  path: string;
  auth: "ok" | "missing";
  model?: unknown;
  stream?: unknown;
  hopHeaders: string[];
}

interface CompatibleMock {
  readonly requests: MockRequestLog[];
  readonly hopHeaderLogs: string[][];
  readonly localBaseUrl: string;
  close(): Promise<void>;
}

type ProcessResult = { exitCode?: number | null; stdout: string; stderr: string };

function resultText(result: ProcessResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactionValues(): string[] {
  return [COMPATIBLE_KEY, TELEGRAM_TOKEN, process.env.GITHUB_TOKEN].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function jsonResponse(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sseResponse(res: http.ServerResponse, body: string): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
  });
}

function parseJsonBody(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function startCompatibleMock(
  port: number,
  model: string,
  apiKey: string,
): Promise<CompatibleMock> {
  const requests: MockRequestLog[] = [];
  const hopHeaderLogs: string[][] = [];
  const server = http.createServer(async (req, res) => {
    const requestPath = new URL(req.url ?? "/", "http://compatible.mock").pathname;
    const auth = req.headers.authorization === `Bearer ${apiKey}` ? "ok" : "missing";
    const hopHeaders = Object.keys(req.headers).filter((name) =>
      HOP_BY_HOP_HEADERS.has(name.toLowerCase()),
    );

    if (req.method === "GET" && ["/v1/models", "/models"].includes(requestPath)) {
      requests.push({ method: "GET", path: requestPath, auth, hopHeaders: [] });
      if (auth !== "ok") {
        jsonResponse(res, 401, { error: { message: "missing bearer credential" } });
        return;
      }
      jsonResponse(res, 200, {
        object: "list",
        data: [{ id: model, object: "model" }],
      });
      return;
    }

    if (req.method !== "POST") {
      requests.push({ method: req.method ?? "GET", path: requestPath, auth, hopHeaders });
      jsonResponse(res, 404, { error: { message: "not found" } });
      return;
    }

    const payload = parseJsonBody(await readRequestBody(req));

    if (["/v1/responses", "/responses"].includes(requestPath)) {
      requests.push({
        method: "POST",
        path: requestPath,
        auth,
        model: payload.model,
        stream: payload.stream,
        hopHeaders,
      });
      if (auth !== "ok") {
        jsonResponse(res, 401, { error: { message: "missing bearer credential" } });
        return;
      }
      if (payload.stream) {
        sseResponse(
          res,
          [
            "event: response.output_text.delta",
            'data: {"delta":"OK"}',
            "",
            "event: response.completed",
            "data: {}",
            "",
          ].join("\n"),
        );
        return;
      }
      jsonResponse(res, 200, {
        id: "resp-mock",
        object: "response",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: COMPAT_AGENT_REPLY }],
          },
        ],
      });
      return;
    }

    if (["/v1/chat/completions", "/chat/completions"].includes(requestPath)) {
      requests.push({
        method: "POST",
        path: requestPath,
        auth,
        model: payload.model,
        stream: payload.stream,
        hopHeaders,
      });
      hopHeaderLogs.push(hopHeaders);
      if (auth !== "ok") {
        jsonResponse(res, 401, { error: { message: "missing bearer credential" } });
        return;
      }
      if (payload.stream) {
        const chunk = JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: COMPAT_AGENT_REPLY },
              finish_reason: null,
            },
          ],
        });
        const done = JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        });
        sseResponse(res, `data: ${chunk}\n\ndata: ${done}\n\ndata: [DONE]\n\n`);
        return;
      }
      jsonResponse(res, 200, {
        id: "chatcmpl-mock",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: COMPAT_AGENT_REPLY },
            finish_reason: "stop",
          },
        ],
      });
      return;
    }

    requests.push({
      method: "POST",
      path: requestPath,
      auth,
      model: payload.model,
      stream: payload.stream,
      hopHeaders,
    });
    jsonResponse(res, 404, { error: { message: "not found" } });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("compatible endpoint mock did not bind to a TCP port");
  }
  const boundPort = (address as AddressInfo).port;
  const mock = {
    requests,
    hopHeaderLogs,
    localBaseUrl: `http://127.0.0.1:${boundPort}/v1`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };

  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const response = await fetch(`${mock.localBaseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (response.ok) return mock;
    } catch {
      // Keep polling until the server accepts connections.
    }
    await sleep(1_000);
  }

  await mock.close();
  throw new Error("compatible endpoint mock failed to answer /v1/models");
}

async function hostAddressForSandbox(host: HostCliClient): Promise<string> {
  const probe = await host.command(
    "bash",
    [
      "-lc",
      [
        'ip_addr="$(ip route get 1.1.1.1 2>/dev/null | awk \'{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}\')"',
        'if [ -n "$ip_addr" ]; then echo "$ip_addr"; exit 0; fi',
        "ip_addr=\"$(hostname -I 2>/dev/null | awk '{print $1}')\"",
        'if [ -n "$ip_addr" ]; then echo "$ip_addr"; exit 0; fi',
        'if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then',
        "  for iface in en0 en1 bridge100; do",
        '    ip_addr="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"',
        '    if [ -n "$ip_addr" ]; then echo "$ip_addr"; exit 0; fi',
        "  done",
        "  ip_addr=\"$(ifconfig 2>/dev/null | awk '/inet / && $2 !~ /^127\\./ {print $2; exit}')\"",
        '  if [ -n "$ip_addr" ]; then echo "$ip_addr"; exit 0; fi',
        "fi",
        "echo 127.0.0.1",
      ].join("\n"),
    ],
    {
      artifactName: "host-ip-for-compatible-endpoint",
      env: commandEnv(),
      timeoutMs: 30_000,
    },
  );
  return probe.stdout.trim().split(/\s+/)[0] || "127.0.0.1";
}

async function sourceCliAvailable(host: HostCliClient): Promise<boolean> {
  if (!fs.existsSync(CLI_DIST_ENTRYPOINT)) return false;
  const result = await host.command(
    "bash",
    ["-lc", "command -v node >/dev/null 2>&1 && command -v openshell >/dev/null 2>&1"],
    {
      artifactName: "source-cli-availability",
      env: commandEnv(),
      timeoutMs: 30_000,
    },
  );
  return result.exitCode === 0;
}

function onboardEnv(endpointUrl: string): NodeJS.ProcessEnv {
  return commandEnv({
    COMPATIBLE_API_KEY: COMPATIBLE_KEY,
    DISCORD_BOT_TOKEN: undefined,
    NEMOCLAW_ENDPOINT_URL: endpointUrl,
    NEMOCLAW_MODEL: COMPAT_MODEL,
    NEMOCLAW_POLICY_MODE: "custom",
    NEMOCLAW_POLICY_PRESETS: "telegram",
    NEMOCLAW_PREFERRED_API: "openai-completions",
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    NEMOCLAW_SKIP_TELEGRAM_REACHABILITY: "1",
    SLACK_APP_TOKEN: undefined,
    SLACK_BOT_TOKEN: undefined,
    TELEGRAM_ALLOWED_IDS: TELEGRAM_IDS,
    TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN,
  });
}

async function runCompatibleOnboard(
  host: HostCliClient,
  endpointUrl: string,
): Promise<{ result: ShellProbeResult; runner: string }> {
  const env = onboardEnv(endpointUrl);
  const useSourceCli = await sourceCliAvailable(host);
  const runOnce = async (
    attempt: number,
  ): Promise<{ result: ShellProbeResult; runner: string }> => {
    if (useSourceCli) {
      await cleanupMessagingState(host, SANDBOX_NAME);
      const result = await host.command(
        "node",
        [
          CLI_ENTRYPOINT,
          "onboard",
          "--fresh",
          "--non-interactive",
          "--yes",
          "--yes-i-accept-third-party-software",
        ],
        {
          artifactName:
            attempt === 1
              ? "onboard-compatible-endpoint-source-cli"
              : `onboard-compatible-endpoint-source-cli-retry-${attempt}`,
          env,
          redactionValues: redactionValues(),
          timeoutMs: ONBOARD_TIMEOUT_MS,
        },
      );
      return { result, runner: attempt === 1 ? "source CLI onboard" : "source CLI onboard retry" };
    }

    const result = await host.command(
      "bash",
      ["install.sh", "--non-interactive", "--yes-i-accept-third-party-software", "--fresh"],
      {
        artifactName:
          attempt === 1
            ? "onboard-compatible-endpoint-install-sh"
            : `onboard-compatible-endpoint-install-sh-retry-${attempt}`,
        cwd: REPO_ROOT,
        env,
        redactionValues: redactionValues(),
        timeoutMs: ONBOARD_TIMEOUT_MS,
      },
    );
    return { result, runner: attempt === 1 ? "install.sh" : "install.sh retry" };
  };

  const first = await runOnce(1);
  if (
    first.result.exitCode === 0 ||
    !/Connection refused|transport error|tcp connect error|client error \(Connect\)/i.test(
      resultText(first.result),
    )
  ) {
    return first;
  }

  await stopGatewayRuntime(host, "onboard-compatible-endpoint-retry-gateway-cleanup");
  await sleep(5_000);
  return runOnce(2);
}

function openAiContent(raw: string): string {
  const parsed = JSON.parse(raw) as {
    choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
  };
  return (parsed.choices ?? [])
    .map((choice) => {
      if (typeof choice.message?.content === "string") return choice.message.content;
      if (typeof choice.text === "string") return choice.text;
      return "";
    })
    .join("\n");
}

async function assertOpenClawConfigShape(sandbox: SandboxClient): Promise<void> {
  const script = String.raw`
const fs = require("node:fs");
const model = process.argv[1];
const cfg = JSON.parse(fs.readFileSync("/sandbox/.openclaw/openclaw.json", "utf8"));
const providers = cfg.models?.providers ?? {};
const errors = [];
if (Object.hasOwn(providers, "deepinfra")) errors.push("direct deepinfra provider is present");
const providerKeys = Object.keys(providers).sort();
if (JSON.stringify(providerKeys) !== JSON.stringify(["inference"])) {
  errors.push("provider keys are " + JSON.stringify(providerKeys));
}
const inference = providers.inference;
if (!inference || typeof inference !== "object") {
  errors.push("models.providers.inference is missing");
} else {
  if (inference.baseUrl !== "https://inference.local/v1") {
    errors.push("inference baseUrl is " + JSON.stringify(inference.baseUrl));
  }
  if (inference.apiKey !== "unused") {
    errors.push("inference apiKey is not the non-secret placeholder");
  }
}
const primary = cfg.agents?.defaults?.model?.primary;
if (primary !== "inference/" + model) errors.push("primary model is " + JSON.stringify(primary));
if (!cfg.channels?.telegram) errors.push("telegram channel config missing");
console.log(JSON.stringify({
  provider_keys: providerKeys,
  inference_base: inference?.baseUrl,
  inference_api_key: inference?.apiKey,
  primary,
  telegram_present: Boolean(cfg.channels?.telegram),
  errors,
}));
process.exit(errors.length ? 1 : 0);
`;
  const result = await sandbox.exec(
    SANDBOX_NAME,
    ["node", "-e", nodeEvalArg(script), COMPAT_MODEL],
    {
      artifactName: "openclaw-config-compatible-endpoint",
      env: commandEnv(),
      timeoutMs: 60_000,
    },
  );
  expect(result.exitCode, resultText(result)).toBe(0);
}

async function assertGatewayReady(sandbox: SandboxClient): Promise<void> {
  const script = String.raw`
const net = require("node:net");
let done = false;
const sock = net.connect(18789, "127.0.0.1");
function finish(line, code) {
  if (done) return;
  done = true;
  console.log(line);
  sock.destroy();
  process.exit(code);
}
sock.on("connect", () => finish("OPEN", 0));
sock.on("error", (err) => finish("ERROR " + err.message, 1));
sock.setTimeout(1000, () => finish("TIMEOUT", 1));
`;
  let last: ShellProbeResult | undefined;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    last = await sandbox.exec(SANDBOX_NAME, ["node", "-e", nodeEvalArg(script)], {
      artifactName: `gateway-ready-compatible-endpoint-${attempt}`,
      env: commandEnv(),
      timeoutMs: 5_000,
    });
    if (last.exitCode === 0 && last.stdout.includes("OPEN")) return;
    await sleep(1_000);
  }
  throw new Error(
    `gateway did not open port 18789: ${last ? resultText(last).slice(0, 300) : "no probe"}`,
  );
}

async function assertSandboxInference(sandbox: SandboxClient): Promise<void> {
  const payload = JSON.stringify({
    model: COMPAT_MODEL,
    messages: [
      { role: "user", content: "Return the compatible endpoint route verification value." },
    ],
    max_tokens: 32,
  });
  const response = await sandbox.exec(
    SANDBOX_NAME,
    [
      "curl",
      "-sS",
      "--max-time",
      "60",
      "https://inference.local/v1/chat/completions",
      "-H",
      "Content-Type: application/json",
      "--data-raw",
      payload,
    ],
    {
      artifactName: "sandbox-inference-local-compatible-chat",
      env: commandEnv(),
      timeoutMs: 90_000,
    },
  );
  expect(response.exitCode, resultText(response)).toBe(0);
  expect(openAiContent(response.stdout), response.stdout.slice(0, 500)).toContain(
    COMPAT_AGENT_REPLY,
  );
}

async function assertOpenClawAgentTurn(
  sandbox: SandboxClient,
  compatibleMock: CompatibleMock,
): Promise<void> {
  const hopCountBefore = compatibleMock.hopHeaderLogs.length;
  const sessionId = `e2e-compat-agent-${Date.now()}-${randomUUID()}`;
  const agent = await sandbox.exec(
    SANDBOX_NAME,
    [
      "openclaw",
      "agent",
      "--agent",
      "main",
      "--json",
      "--session-id",
      sessionId,
      "-m",
      COMPAT_AGENT_PROMPT,
    ],
    {
      artifactName: "openclaw-agent-compatible-endpoint",
      env: commandEnv(),
      timeoutMs: 120_000,
    },
  );
  const text = resultText(agent);
  expect(
    /SsrFBlockedError|Blocked hostname|transport error|ECONNREFUSED|EAI_AGAIN|gateway unavailable|network connection error/i.test(
      text,
    ),
    text.slice(0, 500),
  ).toBe(false);
  expect(agent.exitCode, text.slice(0, 500)).toBe(0);
  expect(parseOpenClawAgentText(agent.stdout), text.slice(0, 500)).toContain(COMPAT_AGENT_REPLY);

  const newHopHeaderLogs = compatibleMock.hopHeaderLogs.slice(hopCountBefore);
  expect(
    newHopHeaderLogs.length,
    "Mock logged no proxy_hop_headers line for the agent turn; agent did not reach /v1/chat/completions",
  ).toBeGreaterThan(0);
  const leaked = newHopHeaderLogs.flat().filter((name) => name.length > 0);
  expect(leaked, `Proxy hop headers leaked to upstream: ${leaked.join(",")}`).toEqual([]);
}

describe("messaging-compatible-endpoint live test local classifiers", () => {
  it("does not satisfy the agent reply assertion with echoed prompt text", () => {
    expect(COMPAT_AGENT_PROMPT).not.toContain(COMPAT_AGENT_REPLY);
    expect(
      parseOpenClawAgentText(JSON.stringify({ result: { content: COMPAT_AGENT_PROMPT } })),
    ).not.toContain(COMPAT_AGENT_REPLY);
    expect(
      parseOpenClawAgentText(JSON.stringify({ result: { content: COMPAT_AGENT_REPLY } })),
    ).toContain(COMPAT_AGENT_REPLY);
  });
});

liveTest(
  "messaging compatible endpoint routes Telegram-enabled OpenClaw through inference.local",
  { timeout: TEST_TIMEOUT_MS },
  async ({ artifacts, cleanup, host, sandbox, skip }) => {
    const docker = await host.command("docker", ["info"], {
      artifactName: "prereq-docker-info-messaging-compatible-endpoint",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    if (docker.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") {
        throw new Error(
          `Docker is required for messaging compatible endpoint E2E: ${resultText(docker)}`,
        );
      }
      skip("Docker is required for messaging compatible endpoint E2E");
    }

    await artifacts.writeJson("scenario.json", {
      id: "messaging-compatible-endpoint",
      runner: "vitest",
      boundary: "direct-cli-onboard-openshell-compatible-endpoint",
      legacySource: "test/e2e/test-messaging-compatible-endpoint.sh",
      legacyRetirement: {
        shellDeletion: "deferred to #5098 Phase 11 cleanup",
        nightlyShellWiring: "deferred to #5098 Phase 11 cleanup",
      },
      refs: ["#2766", "#2572", "#5098"],
      contract: [
        "local OpenAI-compatible mock endpoint starts and is reachable",
        "custom provider + Telegram onboard completes",
        "onboard runs the compatible endpoint sandbox smoke check",
        "gateway registers compatible-endpoint provider",
        "openclaw.json uses managed inference.local provider and Telegram config",
        "gateway stays up after Telegram provider initialization",
        "sandbox inference.local chat completion reaches the mock with auth",
        "OpenClaw agent turn completes through the compatible endpoint",
        "http-proxy-fix.js strips RFC 7230 hop-by-hop proxy headers",
      ],
    });

    cleanup.add(`destroy messaging compatible endpoint state ${SANDBOX_NAME}`, () =>
      cleanupMessagingState(host, SANDBOX_NAME),
    );
    await cleanupMessagingState(host, SANDBOX_NAME);

    const compatibleMock = await startCompatibleMock(MOCK_PORT, COMPAT_MODEL, COMPATIBLE_KEY);
    cleanup.add("stop compatible endpoint mock", async () => {
      await artifacts.writeJson("compatible-endpoint-mock-requests.json", compatibleMock.requests);
      await compatibleMock.close();
    });

    const hostAddress = await hostAddressForSandbox(host);
    const endpointUrl = `http://${hostAddress}:${new URL(compatibleMock.localBaseUrl).port}/v1`;
    const hostReachability = await host.command(
      "curl",
      ["-sf", "-H", `Authorization: Bearer ${COMPATIBLE_KEY}`, `${endpointUrl}/models`],
      {
        artifactName: "compatible-endpoint-host-reachability",
        env: commandEnv(),
        redactionValues: redactionValues(),
        timeoutMs: 30_000,
      },
    );
    expect(hostReachability.exitCode, resultText(hostReachability)).toBe(0);

    const { result: onboard, runner } = await runCompatibleOnboard(host, endpointUrl);
    expect(onboard.exitCode, resultText(onboard)).toBe(0);
    expect(resultText(onboard)).toContain("Compatible endpoint responds through inference.local");

    const provider = await host.command("openshell", ["provider", "get", "compatible-endpoint"], {
      artifactName: "openshell-provider-get-compatible-endpoint",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(provider.exitCode, resultText(provider)).toBe(0);

    await assertOpenClawConfigShape(sandbox);
    await assertGatewayReady(sandbox);
    await assertSandboxInference(sandbox);
    await assertOpenClawAgentTurn(sandbox, compatibleMock);

    expect(
      compatibleMock.requests.some(
        (request) => request.path === "/v1/chat/completions" && request.auth === "ok",
      ),
      "compatible mock did not record authenticated /v1/chat/completions traffic",
    ).toBe(true);

    const telegramRoundTripSecretsAvailable = Boolean(
      process.env.TELEGRAM_BOT_TOKEN_REAL &&
        process.env.TELEGRAM_CHAT_ID_E2E &&
        process.env.COMPATIBLE_API_KEY &&
        process.env.NEMOCLAW_ENDPOINT_URL &&
        process.env.NEMOCLAW_COMPAT_MODEL,
    );
    await artifacts.writeJson("telegram-live-round-trip.json", {
      status: "skipped",
      reason: telegramRoundTripSecretsAvailable
        ? "Live Telegram reply requires an inbound user-message driver; hermetic route passed"
        : "Live Telegram-compatible round trip secrets not fully set",
    });

    await artifacts.writeJson("scenario-result.json", {
      id: "messaging-compatible-endpoint",
      runner,
      endpointUrl,
      legacyRetirement: {
        shellDeletion: "deferred to #5098 Phase 11 cleanup",
        nightlyShellWiring: "deferred to #5098 Phase 11 cleanup",
      },
      assertions: {
        dockerRunning: docker.exitCode === 0,
        mockReachable: hostReachability.exitCode === 0,
        onboardCompleted: onboard.exitCode === 0,
        providerRegistered: provider.exitCode === 0,
        authenticatedChatTraffic: compatibleMock.requests.some(
          (request) => request.path === "/v1/chat/completions" && request.auth === "ok",
        ),
        proxyHopHeadersStripped: compatibleMock.hopHeaderLogs.every(
          (headers) => headers.length === 0,
        ),
      },
    });
  },
);
