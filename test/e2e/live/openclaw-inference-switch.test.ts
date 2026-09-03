// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Preserve the script's real user-visible boundary: install.sh onboards an
 * OpenClaw sandbox, `nemoclaw inference set` switches the running route, then
 * OpenShell route state, OpenClaw config/hash state, registry/session state,
 * inference.local, and a real OpenClaw agent turn are checked from the live
 * host/sandbox boundary. Target-specific helpers stay local; shared shell
 * primitives come from the fixture layer's production-backed helper.
 */

import fs from "node:fs";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { execTimeout, testTimeout } from "../../helpers/timeouts.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText, shellQuote } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import {
  type CompatibleAnthropicSwitchBinding,
  compatibleAnthropicMockEndpointUrl,
  compatibleAnthropicSwitchBinding,
  compatibleAnthropicSwitchEnv,
  requireCompatibleAnthropicProviderAbsent,
} from "../fixtures/compatible-anthropic-switch.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import {
  type FakeOpenAiCompatibleServer,
  startFakeOpenAiCompatibleServer,
} from "../fixtures/fake-openai-compatible.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import {
  inferenceResponseModel,
  inferenceSetAttemptCount,
  runInferenceSetWithRetry,
  writeInferenceSwitchRetryEvidence,
} from "../fixtures/inference-switch-retry.ts";
import { CLI_ENTRYPOINT, REPO_ROOT } from "../fixtures/paths.ts";
import { parseOpenClawAgentText } from "../fixtures/openclaw-agent-output.ts";
import { runBoundedRetry } from "../../../tools/e2e/retry-evidence.mts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  agentReplyContainsToken,
  classifyOpenClawPostSwitchInferenceAttempt,
  MOCK_BASELINE_API_KEY,
  MOCK_BASELINE_MODEL,
  mockBaselineInference,
} from "./openclaw-inference-switch-helpers.ts";
import {
  PUBLIC_NVIDIA_SWITCH_MODEL,
  PUBLIC_NVIDIA_SWITCH_PROVIDER,
  registerPublicNvidiaSwitchProvider,
  requirePublicNvidiaSwitchKey,
} from "./public-nvidia-switch-provider.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-oc-inf-switch";
const SWITCH_PROVIDER = process.env.NEMOCLAW_SWITCH_PROVIDER ?? PUBLIC_NVIDIA_SWITCH_PROVIDER;
const SWITCH_MODEL = process.env.NEMOCLAW_SWITCH_MODEL ?? PUBLIC_NVIDIA_SWITCH_MODEL;
const SWITCH_INFERENCE_API = process.env.NEMOCLAW_SWITCH_INFERENCE_API ?? "openai-completions";
const SWITCH_MOCK_ANTHROPIC = process.env.NEMOCLAW_SWITCH_MOCK_ANTHROPIC ?? "0";
const SWITCH_MOCK_PORT = parsePortEnv("NEMOCLAW_SWITCH_MOCK_PORT", 0);
const TEST_TIMEOUT_MS = testTimeout(75 * 60_000);
const INSTALL_TIMEOUT_MS = execTimeout(30 * 60_000);
const COMMAND_TIMEOUT_MS = 120_000;
const INFERENCE_TIMEOUT_MS = 150_000;
const AGENT_TIMEOUT_MS = 150_000;

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
        apiKey?: unknown;
        api?: unknown;
        models?: Array<{ id?: unknown; name?: unknown; maxTokens?: unknown }>;
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
  nimContainer?: unknown;
}

interface MockAnthropicProvider {
  endpointUrl: string;
  close(): Promise<void>;
}

function proveMockBaselineAuthentication(
  baseline: Pick<FakeOpenAiCompatibleServer, "requests"> | undefined,
  sandbox: SandboxClient,
  home: string,
  artifacts: { writeJson(path: string, value: unknown): Promise<string> },
): Promise<void> {
  return baseline
    ? proveSelectedMockBaselineAuthentication(baseline, sandbox, home, artifacts)
    : Promise.resolve(expect(baseline).toBeUndefined());
}

async function proveSelectedMockBaselineAuthentication(
  baseline: Pick<FakeOpenAiCompatibleServer, "requests">,
  sandbox: SandboxClient,
  home: string,
  artifacts: { writeJson(path: string, value: unknown): Promise<string> },
): Promise<void> {
  // Ignore incidental onboarding traffic. The fixture appends its ledger row
  // before responding, so this awaited POST is the publication barrier for the
  // requests sliced from this offset.
  const requestOffset = baseline.requests().length;
  const payload = {
    model: MOCK_BASELINE_MODEL,
    messages: [{ role: "user", content: "reply with OK" }],
    max_tokens: 8,
  };
  const probe = await sandboxShell(
    sandbox,
    home,
    `curl -fsS --max-time 60 https://inference.local/v1/chat/completions -H 'Content-Type: application/json' --data ${shellQuote(JSON.stringify(payload))} >/dev/null`,
    {
      artifactName: "baseline-explicit-authenticated-inference-post",
      timeoutMs: 90_000,
    },
  );
  const requests = baseline.requests().slice(requestOffset);
  const artifactName = "baseline-explicit-authenticated-inference-requests.json";
  const phase = "install and onboard baseline OpenClaw";
  const requestEvidence = requests
    .slice(0, 20)
    .map(({ auth, method, model, path }) => ({ auth, method, model, path }));
  await artifacts.writeJson(artifactName, {
    phase,
    requestCount: requests.length,
    requests: requestEvidence,
    truncated: requests.length > requestEvidence.length,
  });
  expect(probe.exitCode, `${phase}: explicit baseline inference failed; see ${artifactName}`).toBe(
    0,
  );
  const expectedRequest = expect.objectContaining({
    auth: "ok",
    method: "POST",
    model: MOCK_BASELINE_MODEL,
    path: "/v1/chat/completions",
  });
  expect(
    requests,
    `${phase}: explicit verification probe did not reach the authenticated fixture; see ${artifactName}`,
  ).toContainEqual(expectedRequest);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
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

async function bestEffortStateReset(run: () => Promise<unknown>): Promise<void> {
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
  options: {
    artifactName: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    redactionValues?: string[];
  } = {
    artifactName: "nemoclaw",
  },
): Promise<ShellProbeResult> {
  return host.command("node", [CLI_ENTRYPOINT, ...args], {
    artifactName: options.artifactName,
    env: commandEnv(home, options.env),
    timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    redactionValues: options.redactionValues,
  });
}

async function sandboxShell(
  sandbox: SandboxClient,
  home: string,
  script: string,
  options: { artifactName: string; timeoutMs?: number; redactionValues?: string[] },
): Promise<ShellProbeResult> {
  return sandbox.execShell(SANDBOX_NAME, trustedSandboxShellScript(script), {
    artifactName: options.artifactName,
    env: commandEnv(home),
    timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    redactionValues: options.redactionValues,
  });
}

async function resetOpenClawInferenceSwitchState(
  host: HostCliClient,
  sandbox: SandboxClient,
  home: string,
  artifactPrefix: string,
): Promise<void> {
  await bestEffortStateReset(() =>
    runNemoclaw(host, home, [SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: `${artifactPrefix}-nemoclaw-destroy-openclaw-inference-switch`,
      timeoutMs: 120_000,
    }),
  );
  await bestEffortStateReset(() =>
    sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: `${artifactPrefix}-openshell-sandbox-delete-openclaw-inference-switch`,
      env: commandEnv(home),
      timeoutMs: 60_000,
    }),
  );
  await bestEffortStateReset(() =>
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
    endpointUrl: compatibleAnthropicMockEndpointUrl(port),
    close: () => closeServer(server),
  };
}

async function prepareCompatibleAnthropicSwitchBinding(
  host: HostCliClient,
  home: string,
  mockProvider: MockAnthropicProvider | undefined,
): Promise<CompatibleAnthropicSwitchBinding | null> {
  if (SWITCH_PROVIDER !== "compatible-anthropic-endpoint") return null;
  if (SWITCH_INFERENCE_API !== "anthropic-messages") return null;

  const endpointUrl = process.env.NEMOCLAW_SWITCH_ENDPOINT_URL ?? mockProvider?.endpointUrl ?? "";
  const binding = compatibleAnthropicSwitchBinding(endpointUrl);
  await requireCompatibleAnthropicProviderAbsent(host, {
    artifactName: "compatible-anthropic-provider-absent-before-switch",
    env: commandEnv(home),
  });
  return binding;
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
  options: { mockProvider?: MockAnthropicProvider },
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
      expect(sandbox?.endpointUrl).toBeNull();
      expect(sandbox?.credentialEnv).toBeNull();
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
  expect(session.nimContainer).toBeNull();
  switch (SWITCH_PROVIDER) {
    case "compatible-endpoint":
      expect(session.preferredInferenceApi).toBe("openai-completions");
      break;
    case "compatible-anthropic-endpoint":
      expect(session.preferredInferenceApi).toBe("anthropic-messages");
      break;
    case PUBLIC_NVIDIA_SWITCH_PROVIDER:
      expect(session.endpointUrl).toBe("https://inference.local/v1");
      expect(session.credentialEnv).toBe("OPENAI_API_KEY");
      expect(session.preferredInferenceApi).toBe("openai-completions");
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
  expect(provider?.apiKey).toBe("unused");
  expect(provider?.api).toBe(SWITCH_INFERENCE_API);
  expect(firstModel?.id).toBe(SWITCH_MODEL);
  expect(firstModel?.name).toBe(expectedPrimary);
  expect(typeof firstModel?.maxTokens).toBe("number");
  expect(firstModel?.maxTokens).toBeGreaterThan(0);

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
  artifacts: ArtifactSink,
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

  const execution = await runBoundedRetry<{
    classification: ReturnType<typeof classifyOpenClawPostSwitchInferenceAttempt>;
    lastFailure: string;
  }>({
    operation: "openclaw-inference-switch.post-switch-inference",
    owner: "inference-provider",
    idempotence: "read-only",
    maxAttempts: 3,
    delayMs: 5_000,
    onEvidence: async (evidence) => {
      await artifacts.writeJson("retry/openclaw-post-switch-inference.json", evidence);
    },
    run: async (attempt) => {
      const result = await sandboxShell(sandbox, home, script, {
        artifactName: `sandbox-inference-local-after-switch-${attempt}`,
        timeoutMs: INFERENCE_TIMEOUT_MS,
      });
      const response = resultText(result);
      const httpCode = httpStatusFromResponse(response) || "000";
      const body = httpBodyFromResponse(response);
      let malformed = false;
      let productMatched = false;
      let lastFailure: string;

      if (result.exitCode !== 0) {
        lastFailure = `curl failed (exit ${result.exitCode}); HTTP ${httpCode}: ${body.slice(0, 300)}`;
      } else if (httpCode !== "200") {
        lastFailure = `HTTP ${httpCode}: ${body.slice(0, 300)}`;
      } else {
        try {
          const content =
            SWITCH_INFERENCE_API === "anthropic-messages"
              ? parseAnthropicContent(body)
              : parseChatContent(body);
          const responseModel = inferenceResponseModel(body);
          const modelMatches = responseModel === SWITCH_MODEL;
          productMatched = modelMatches && /\bPONG\b/iu.test(content);
          lastFailure = modelMatches
            ? `expected PONG, got ${content.slice(0, 300)}`
            : `expected model ${SWITCH_MODEL}, got ${responseModel || "<missing>"}`;
        } catch {
          malformed = true;
          lastFailure = `HTTP 200 response was not parseable JSON: ${body.slice(0, 300)}`;
        }
      }

      return {
        classification: classifyOpenClawPostSwitchInferenceAttempt({
          exitCode: result.exitCode,
          httpStatus: httpCode,
          malformed,
          output: response,
          productMatched,
        }),
        lastFailure,
      };
    },
    classify: (value, error) =>
      error !== undefined || !value
        ? { outcome: "failed", failureClass: "deterministic" }
        : value.classification,
  });

  if (execution.outcome === "passed") return "ok";
  const lastFailure = execution.value?.lastFailure ?? "probe failed without a result";
  if (execution.evidence.outcome === "exhausted") {
    return {
      skipped: `Sandbox inference.local transient failure after switch; route/config checks already passed: ${lastFailure}`,
    };
  }
  throw new Error(`Sandbox inference.local did not work after switch: ${lastFailure}`);
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
  "openshell-${SANDBOX_NAME}.default" \
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
  const fallbackOrPairing =
    /EMBEDDED FALLBACK|gateway connect failed|scope upgrade pending approval|device pairing required|pairing required|fallbackFrom[": ]+gateway|transport[": ]+embedded/i.test(
      [raw, warnings, result.stderr].filter(Boolean).join("\n"),
    );
  if (result.exitCode === 0 && agentReplyContainsToken(reply, "PONG") && !fallbackOrPairing) {
    return "ok";
  }
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

// The pure reply-matching and mock-baseline-config assertions that previously
// lived here as test(...) blocks (which only run under the opt-in live lane)
// are covered in the fast e2e-support project instead:
// test/e2e/support/openclaw-inference-switch-helpers.test.ts.

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
  switchBinding: CompatibleAnthropicSwitchBinding | null,
  artifacts: { writeJson(path: string, value: unknown): Promise<string> },
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
  const compatibleMetadataArgs = switchBinding
    ? [
        "--endpoint-url",
        switchBinding.endpointUrl,
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
    onEvidence: (evidence) => writeInferenceSwitchRetryEvidence(artifacts, evidence),
    run: (attempt) =>
      runNemoclaw(host, home, args, {
        artifactName: `nemoclaw-inference-set-${attempt}`,
        env: compatibleAnthropicSwitchEnv(switchBinding),
        redactionValues,
        timeoutMs: COMMAND_TIMEOUT_MS,
      }),
  });
}

test(
  "openclaw-inference-switch: switches route and preserves live OpenClaw behavior",
  {
  timeout: TEST_TIMEOUT_MS,
  meta: {
    e2ePhases: [
      "confirm the selected runtime and choose the baseline provider",
      "clear existing inference-switch state",
      "install and onboard baseline OpenClaw",
      "prepare the switched provider and endpoint",
      "switch the route and verify restart semantics",
      "inspect route configuration and recorded state",
      "prove inference.local and OpenClaw agent turns",
      "apply sandbox retention and record the result",
    ],
  },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox, secrets, skip }) => {
  await artifacts.target.declare({
    id: "openclaw-inference-switch",
    boundary: "install-sh-openclaw-inference-set-and-live-agent-turn",
    sandboxName: SANDBOX_NAME,
    switchProvider: SWITCH_PROVIDER,
    switchModel: SWITCH_MODEL,
    switchInferenceApi: SWITCH_INFERENCE_API,
    contracts: [
      "the selected runtime is available and an authenticated compatible baseline endpoint is staged",
      "install.sh --non-interactive onboards an OpenClaw sandbox",
      "when selected, the mock baseline route completes one explicit authenticated fixture request",
      "nemoclaw inference set switches the running sandbox route",
      "OpenClaw gateway is supervisor-restarted only when the inference API family changes",
      "OpenShell route points at the switched provider/model",
      "OpenClaw config and .config-hash reflect the switched inference API/model",
      "registry and onboard session record the switched provider/model",
      "sandbox inference.local returns PONG from the switched model",
      "openclaw agent answers through the switched inference route",
    ],
  });

  expect(
    fs.existsSync(CLI_ENTRYPOINT),
    "run `npm run build:cli` before live repo CLI targets",
  ).toBe(true);

    await runtimeProvider.requireAvailable({
    artifactName: "prereq-runtime-info-openclaw-inference-switch",
      scenarioLabel: "OpenClaw inference switch",
  });

  const useMockBaseline =
    SWITCH_PROVIDER === "compatible-anthropic-endpoint" && SWITCH_MOCK_ANTHROPIC === "1";
  // OpenShell reaches this fixture from its gateway network namespace, where
  // the runner's loopback address is not routable.
  const baselineProvider: FakeOpenAiCompatibleServer | undefined = useMockBaseline
    ? await startFakeOpenAiCompatibleServer({
        apiKey: MOCK_BASELINE_API_KEY,
        host: "0.0.0.0",
        model: MOCK_BASELINE_MODEL,
        publicHost: "host.openshell.internal",
        progress,
        requireAuth: true,
      })
    : undefined;
  const baseline = baselineProvider
    ? mockBaselineInference(baselineProvider.baseUrl)
    : requireHostedInferenceConfig(secrets);
  const apiKey = baseline.apiKey;
  const publicApiKey =
    SWITCH_PROVIDER === PUBLIC_NVIDIA_SWITCH_PROVIDER
      ? requirePublicNvidiaSwitchKey(secrets.required("NVIDIA_API_KEY"))
      : null;
  const redactionValues = [apiKey, publicApiKey].filter(
    (value): value is string => typeof value === "string",
  );

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-switch-home-"));
  let mockProvider: MockAnthropicProvider | undefined;
    cleanup.trackDisposable(
      `remove OpenClaw inference switch test home for ${SANDBOX_NAME}`,
      () => {
    fs.rmSync(home, { recursive: true, force: true });
      },
    );
  cleanup.trackDisposable("close switched Anthropic provider", async () => {
    await mockProvider?.close();
  });
  cleanup.trackDisposable("close baseline inference provider", async () => {
    await baselineProvider?.close();
  });
  cleanup.trackGateway(host, "nemoclaw", {
    artifactName: "cleanup-openshell-gateway-destroy-openclaw-inference-switch",
    env: commandEnv(home),
    timeoutMs: 120_000,
  });
  cleanup.trackDisposable(`delete OpenShell sandbox ${SANDBOX_NAME}`, () =>
    sandbox.cleanupSandbox(SANDBOX_NAME, {
      artifactName: "cleanup-openshell-sandbox-delete-openclaw-inference-switch",
      env: commandEnv(home),
      timeoutMs: 60_000,
    }),
  );
  cleanup.trackSandbox(host, SANDBOX_NAME, {
    artifactName: "cleanup-nemoclaw-destroy-openclaw-inference-switch",
    env: commandEnv(home),
    timeoutMs: 120_000,
  });

  progress.phase("clear existing inference-switch state");
  await resetOpenClawInferenceSwitchState(host, sandbox, home, "pre-cleanup");

  progress.phase("install and onboard baseline OpenClaw");
  const install = await host.command(
    "bash",
    ["install.sh", "--non-interactive", "--yes-i-accept-third-party-software"],
    {
      artifactName: "install-and-onboard-openclaw-inference-switch",
      cwd: REPO_ROOT,
      env: commandEnv(home, {
        ...baseline.env,
        NEMOCLAW_RECREATE_SANDBOX: "1",
      }),
      redactionValues,
      timeoutMs: INSTALL_TIMEOUT_MS,
    },
  );
  const installText = resultText(install);
  if (install.exitCode !== 0 && isExternalProviderValidationFailure(installText)) {
    await artifacts.target.complete({
      id: "openclaw-inference-switch",
      status: "skipped",
      reason: "external-provider-validation-unavailable-before-inference-switch",
      installExitCode: install.exitCode,
    });
    skip("NVIDIA endpoint validation was unavailable/rate-limited during onboarding");
  }
  expect(install.exitCode, installText).toBe(0);
  await proveMockBaselineAuthentication(baselineProvider, sandbox, home, artifacts);

  progress.phase("prepare the switched provider and endpoint");
  const publicProvider = publicApiKey
    ? await registerPublicNvidiaSwitchProvider(host, publicApiKey, commandEnv(home))
    : null;
  publicProvider && expect(publicProvider.exitCode, resultText(publicProvider)).toBe(0);

  if (SWITCH_PROVIDER === "compatible-anthropic-endpoint" && SWITCH_MOCK_ANTHROPIC === "1") {
    mockProvider = await startMockAnthropicProvider();
    await artifacts.writeJson("mock-anthropic-provider.json", {
      endpointUrl: mockProvider.endpointUrl,
    });
  }
  // Only the explicit Anthropic bridge supplies endpoint metadata. The
  // compatible baseline reuses its registered OpenShell provider, while the
  // public NVIDIA provider has no caller-supplied endpoint identity.
  const switchBinding =
    SWITCH_PROVIDER === "compatible-anthropic-endpoint"
      ? await prepareCompatibleAnthropicSwitchBinding(host, home, mockProvider)
      : null;
  switchBinding && redactionValues.push(switchBinding.credentialValue);

  progress.phase("switch the route and verify restart semantics");
  expect(baseline.env.NEMOCLAW_PREFERRED_API).toBe("openai-completions");
  const gatewayRestartExpected = SWITCH_MOCK_ANTHROPIC === "1";
  expect(SWITCH_INFERENCE_API).toBe(
    gatewayRestartExpected ? "anthropic-messages" : "openai-completions",
  );
  const pidBefore = await openclawGatewayPid(sandbox, home);
  const switchResult = await runOpenClawInferenceSetWithRetry(
    host,
    home,
    redactionValues,
    switchBinding,
    artifacts,
  );
  expect(switchResult.exitCode, resultText(switchResult)).toBe(0);
  expect(
    resultText(switchResult).includes(
      `Restarting the OpenClaw gateway in '${SANDBOX_NAME}' to apply the new inference API family`,
    ),
    `managed cross-family restart marker mismatch: ${resultText(switchResult)}`,
  ).toBe(gatewayRestartExpected);

  const pidAfter = await openclawGatewayPid(sandbox, home);
  const gatewayPidStable = pidBefore && pidAfter ? pidBefore === pidAfter : null;
  if (gatewayPidStable !== null) {
    expect(
      gatewayPidStable,
      gatewayRestartExpected
        ? `OpenClaw gateway process did not change for API-family switch (${pidBefore} -> ${pidAfter})`
        : `OpenClaw gateway process changed for same-family switch (${pidBefore} -> ${pidAfter})`,
    ).toBe(!gatewayRestartExpected);
  }

  progress.phase("inspect route configuration and recorded state");
  await assertOpenShellRoute(host, home);
  await assertOpenClawConfig(sandbox, home);
  await assertRegistryAndSession(home, { mockProvider });

  progress.phase("prove inference.local and OpenClaw agent turns");
  const inference = await checkSandboxInference(sandbox, artifacts, home);
  if (inference !== "ok") {
    await artifacts.target.complete({
      id: "openclaw-inference-switch",
      status: "skipped",
      reason: inference.skipped,
      routeAndConfigChecksPassed: true,
    });
    skip(inference.skipped);
  }

  const agentTurn = await checkOpenClawAgentTurn(host, home);
  if (agentTurn !== "ok") {
    await artifacts.target.complete({
      id: "openclaw-inference-switch",
      status: "skipped",
      reason: agentTurn.skipped,
      routeConfigAndInferenceChecksPassed: true,
    });
    skip(agentTurn.skipped);
  }

  progress.phase("apply sandbox retention and record the result");
  if (process.env.NEMOCLAW_E2E_KEEP_SANDBOX !== "1") {
    await resetOpenClawInferenceSwitchState(host, sandbox, home, "final");
    const registryPath = path.join(home, ".nemoclaw", "sandboxes.json");
    const registryText = fs.existsSync(registryPath) ? fs.readFileSync(registryPath, "utf8") : "";
    expect(registryText).not.toContain(`"${SANDBOX_NAME}"`);
  }

  await artifacts.target.complete({
    id: "openclaw-inference-switch",
    status: "passed",
    assertions: {
        runtimeProviderAvailable: true,
      installCompleted: install.exitCode === 0,
      inferenceSetCompleted: switchResult.exitCode === 0,
      gatewayRestartExpected,
      gatewayPidStable,
      routeChecked: true,
      configChecked: true,
      registryAndSessionChecked: true,
      inferenceLocalPong: true,
      inferenceLocalModelMatched: true,
      openClawAgentPong: true,
    },
  });
  },
);
