// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Hosted switching and native local routing share the OpenClaw live contract.

import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { NVIDIA_HOSTED_NATIVE_ENDPOINT } from "../../../src/lib/inference/native-nvidia/index.ts";
import { nativeHostedAuthHeaderScript } from "../../../src/lib/inference/native-provider/contract.ts";
import { NATIVE_NVIDIA_AUTH_HEADER_SCRIPT } from "../../../src/lib/inference/native-nvidia/contract.ts";
import { execTimeout, testTimeout } from "../../helpers/timeouts.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import type { TestProgress } from "../fixtures/progress.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText, shellQuote } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  sandboxAccessEnv,
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import {
  type CompatibleAnthropicSwitchBinding,
  compatibleAnthropicSwitchBinding,
  compatibleAnthropicMockEndpointUrl,
  compatibleAnthropicSwitchEnv,
  requireCompatibleAnthropicProviderAbsent,
} from "../fixtures/compatible-anthropic-switch.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import {
  startFakeOpenAiCompatibleServer,
  type FakeOpenAiCompatibleServer,
} from "../fixtures/fake-openai-compatible.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import { selectedE2eManagedImageReference } from "../fixtures/managed-image-receipt.ts";
import {
  inferenceResponseModel,
  inferenceSetAttemptCount,
  runInferenceSetWithRetry,
  writeInferenceSwitchRetryEvidence,
} from "../fixtures/inference-switch-retry.ts";
import { CLI_ENTRYPOINT } from "../fixtures/paths.ts";
import { approveOpenClawAdminScope } from "./openclaw-admin-scope.ts";
import { resolveVerifiedCloudflaredBinary } from "./cloudflared-prerequisite.ts";
import { startPublicMcpHttpsTunnel } from "./mcp-bridge-servers.ts";
import {
  createMockAnthropicProviderServer,
  type MockAnthropicRequest,
} from "./openclaw-anthropic-provider.ts";
import { runBoundedRetry } from "../../../tools/e2e/retry-evidence.mts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  getRouteOutput,
  OPENCLAW_GATEWAY_PID_PROBE,
  openClawGatewayRestarted,
  readOpenClawConfig,
  agentReplyContainsToken,
  classifyExhaustedPostSwitchEvidence,
  classifyOpenClawPostSwitchInferenceAttempt,
  classifyUnavailableInitialProviderEvidence,
  mockBaselineInference,
  parseOpenClawGatewayModelRun,
  startMockOpenClawBaselineProvider,
} from "./openclaw-inference-switch-helpers.ts";
import {
  acceptedSwitchResponseModels,
  PUBLIC_NVIDIA_SWITCH_ATTACHMENT_EVIDENCE,
  PUBLIC_NVIDIA_SWITCH_MODEL,
  PUBLIC_NVIDIA_SWITCH_PROVIDER,
  readPublicNvidiaSwitchAttachmentEvidence,
  requirePublicNvidiaSwitchKey,
} from "./public-nvidia-switch-provider.ts";

import {
  ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS,
  ONBOARD_SINGLE_FINAL_HANDOFF_TEST_TIMEOUT_MS,
  OPENCLAW_NATIVE_LOCAL_TEST_TIMEOUT_MS,
} from "../../../tools/e2e/onboard-timeout-contract.mts";
import {
  onboardNativeOpenClaw,
  requestNativeOpenClaw,
} from "../fixtures/inference-routing-openclaw-native.ts";
import {
  nativeLocalUlaOnlyResolution,
  isWslDockerIpv6TestHost,
  nativeLocalIpv6ResolutionCommand,
  nativeLocalIpv6DeniedCommand,
} from "../fixtures/native-local-ipv6-evidence.ts";
import { nativeLocalChatCommand } from "../fixtures/native-local-chat.ts";
import { assertAgentExecutionSucceeded } from "./gpu-e2e-helpers.ts";
import { hostedCredentialScanCommand } from "./inference-routing-credential-scan.ts";
import {
  cleanupSandbox,
  expectOnboardSuccess,
  inferenceSandboxName,
  onboardSandbox,
} from "./inference-routing-helpers.ts";

process.env.NEMOCLAW_CLI_BIN ??= CLI_ENTRYPOINT;

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-oc-inf-switch";
const SWITCH_PROVIDER = process.env.NEMOCLAW_SWITCH_PROVIDER ?? PUBLIC_NVIDIA_SWITCH_PROVIDER;
const SWITCH_MODEL = process.env.NEMOCLAW_SWITCH_MODEL ?? PUBLIC_NVIDIA_SWITCH_MODEL;
const SWITCH_INFERENCE_API = process.env.NEMOCLAW_SWITCH_INFERENCE_API ?? "openai-completions";
const SWITCH_MOCK_ANTHROPIC = process.env.NEMOCLAW_SWITCH_MOCK_ANTHROPIC ?? "0";
const SWITCH_NATIVE_CUSTOM = process.env.NEMOCLAW_SWITCH_NATIVE_CUSTOM === "1";
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

interface SandboxRegistry {
  sandboxes?: Record<
    string,
    {
      nativeNvidiaProviderAttachment?: unknown;
    }
  >;
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

function writeCustomOpenClawDockerfile(home: string): string {
  const environment = commandEnv(home);
  const baseImage = selectedE2eManagedImageReference({
    environment,
    expectedAgent: "openclaw",
  });

  const buildContext = path.join(home, "custom-openclaw-image");
  const dockerfilePath = path.join(buildContext, "Dockerfile");
  fs.mkdirSync(buildContext, { recursive: true });
  const bakeRoute = [
    'const fs = require("node:fs");',
    'const configPath = "/sandbox/.openclaw/openclaw.json";',
    'const config = JSON.parse(fs.readFileSync(configPath, "utf8"));',
    "config.agents ??= {}; config.agents.defaults ??= {}; config.agents.defaults.model ??= {};",
    'config.agents.defaults.model.primary = "inference/baked-wrong-model";',
    "config.models ??= {}; config.models.providers ??= {};",
    'config.models.providers.inference = { baseUrl: "https://baked.invalid/v1", apiKey: "unused", api: "openai-completions", models: [{ id: "baked-wrong-model", name: "inference/baked-wrong-model", contextWindow: 8192, maxTokens: 128 }] };',
    "fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\\n`);",
  ].join(" ");
  fs.writeFileSync(
    dockerfilePath,
    [
      `FROM ${baseImage}`,
      "ARG NEMOCLAW_MESSAGING_PLAN_B64=",
      "ARG NEMOCLAW_TOOL_DISCLOSURE=progressive",
      "ENV NEMOCLAW_TOOL_DISCLOSURE=${NEMOCLAW_TOOL_DISCLOSURE}",
      `RUN node -e ${shellQuote(bakeRoute)}`,
      "",
    ].join("\n"),
  );
  return dockerfilePath;
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
    host.cleanupGatewayRegistration("nemoclaw", {
      artifactName: `${artifactPrefix}-openshell-gateway-destroy-openclaw-inference-switch`,
      env: commandEnv(home),
      timeoutMs: 120_000,
    }),
  );
}

interface MockAnthropicProvider {
  endpointUrl: string;
  requests(): readonly MockAnthropicRequest[];
  close(): Promise<void>;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function startMockAnthropicProvider(options: {
  cleanup: CleanupRegistry;
  progress: TestProgress;
  cloudflaredBin?: string;
  nativeCustom: boolean;
  port: number;
}): Promise<MockAnthropicProvider> {
  const { credentialValue } = compatibleAnthropicSwitchBinding(
    compatibleAnthropicMockEndpointUrl(options.port),
  );
  const { server, requests } = createMockAnthropicProviderServer({
    nativeCustom: options.nativeCustom,
    credentialValue,
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.nativeCustom ? "127.0.0.1" : "0.0.0.0", () => {
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
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => (closePromise ??= closeServer(server));
  options.cleanup.trackDisposable("close mock Anthropic inference provider", close);
  let endpointUrl = compatibleAnthropicMockEndpointUrl(port);
  if (options.nativeCustom) {
    endpointUrl = (
      await startPublicMcpHttpsTunnel({
        cleanup: options.cleanup,
        progress: options.progress,
        cloudflaredBin: options.cloudflaredBin,
        label: "Anthropic switch inference",
        server: { port, close },
        originProtocol: "http",
        readinessPath: "/health",
        readinessStatus: 200,
      })
    ).origin;
  }
  return {
    endpointUrl,
    requests: () => requests,
    close,
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

async function openclawGatewayPid(
  sandbox: SandboxClient,
  home: string,
  observation: "before" | "after",
): Promise<string> {
  const result = await sandboxShell(sandbox, home, OPENCLAW_GATEWAY_PID_PROBE, {
    artifactName: `openclaw-gateway-pid-${observation}`,
    timeoutMs: 30_000,
  });
  return result.stdout.trim();
}

async function verifyNativeNvidiaAttachmentAfterSwitch(
  home: string,
  sandbox: SandboxClient,
): Promise<void> {
  switch (SWITCH_PROVIDER) {
    case PUBLIC_NVIDIA_SWITCH_PROVIDER: {
      const registryPath = path.join(home, ".nemoclaw", "sandboxes.json");
      const registry = JSON.parse(fs.readFileSync(registryPath, "utf8")) as SandboxRegistry;
      expect(
        await readPublicNvidiaSwitchAttachmentEvidence({
          artifactName: "native-nvidia-provider-attachment-after-switch",
          env: commandEnv(home),
          logicalProvider: SWITCH_PROVIDER,
          receipt: registry.sandboxes?.[SANDBOX_NAME]?.nativeNvidiaProviderAttachment,
          sandbox,
          sandboxName: SANDBOX_NAME,
        }),
      ).toBe(PUBLIC_NVIDIA_SWITCH_ATTACHMENT_EVIDENCE);
    }
  }
}

// Source tests own serialized config and registry/session field values. This
// live owner retains the actual configuration read and real gateway requests.
async function recordOpenClawConfig(
  sandbox: SandboxClient,
  home: string,
  expected: {
    model: string;
    inferenceApi: string;
    artifactName: string;
    nativeNvidia?: boolean;
    nativeCustomEndpoint?: string;
  },
): Promise<void> {
  const configResult = await readOpenClawConfig(sandbox, SANDBOX_NAME, {
    nativeNvidia: expected.nativeNvidia,
    nativeCustomApi: expected.nativeCustomEndpoint ? expected.inferenceApi : undefined,
    artifactName: expected.artifactName,
    env: commandEnv(home),
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  expect(configResult.exitCode, resultText(configResult)).toBe(0);
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
  nativeCustomEndpoint?: string,
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
  const curlCommand = nativeCustomEndpoint
    ? `curl -sS -o "$tmp" -w '%{http_code}' --max-time 90 ${shellQuote(`${nativeCustomEndpoint}/v1/messages`)} -H 'Content-Type: application/json' -H 'anthropic-version: 2023-06-01' -H "$AUTH_HEADER" --data-binary @/tmp/nemoclaw-switch-payload.json`
    : SWITCH_PROVIDER === PUBLIC_NVIDIA_SWITCH_PROVIDER
      ? `curl -sS -o "$tmp" -w '%{http_code}' --max-time 90 ${NVIDIA_HOSTED_NATIVE_ENDPOINT}/chat/completions -H 'Content-Type: application/json' -H "$AUTH_HEADER" --data-binary @/tmp/nemoclaw-switch-payload.json`
      : SWITCH_INFERENCE_API === "anthropic-messages"
        ? `curl -sS -o "$tmp" -w '%{http_code}' --max-time 90 https://inference.local/v1/messages -H 'Content-Type: application/json' -H 'anthropic-version: 2023-06-01' --data-binary @/tmp/nemoclaw-switch-payload.json`
        : `curl -sS -o "$tmp" -w '%{http_code}' --max-time 90 https://inference.local/v1/chat/completions -H 'Content-Type: application/json' --data-binary @/tmp/nemoclaw-switch-payload.json`;
  const script = [
    "set -u",
    ...(nativeCustomEndpoint
      ? [
          nativeHostedAuthHeaderScript({
            credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
            api: "anthropic-messages",
          }),
        ]
      : SWITCH_PROVIDER === PUBLIC_NVIDIA_SWITCH_PROVIDER
        ? [NATIVE_NVIDIA_AUTH_HEADER_SCRIPT]
        : []),
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
        artifactName: `sandbox-inference-after-switch-${attempt}`,
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
          const modelMatches = acceptedSwitchResponseModels(SWITCH_MODEL).includes(responseModel);
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
    const exhausted = classifyExhaustedPostSwitchEvidence({
      required: SWITCH_PROVIDER === PUBLIC_NVIDIA_SWITCH_PROVIDER,
      lastFailure,
    });
    return exhausted.outcome === "failed"
      ? Promise.reject(new Error(exhausted.message))
      : { skipped: exhausted.reason };
  }
  throw new Error(`Sandbox inference did not work after switch: ${lastFailure}`);
}

async function checkOpenClawGatewayInference(
  host: HostCliClient,
  home: string,
  artifacts: ArtifactSink,
  expected: {
    model: string;
    inferenceApi: string;
    artifactName: string;
    phase: string;
  },
  mockProvider: MockAnthropicProvider | undefined,
  baselineProvider?: Pick<FakeOpenAiCompatibleServer, "requests">,
): Promise<"ok" | { skipped: string }> {
  const requestOffset = mockProvider?.requests().length ?? 0;
  const baselineRequestOffset = baselineProvider?.requests().length ?? 0;
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
  "openclaw infer model run --gateway --json --prompt 'Reply with exactly one word: PONG'" \
  2>"$stderr_file"
rc=$?
set -e
printf '\n__NEMOCLAW_AGENT_STDERR__\n'
cat "$stderr_file" 2>/dev/null || true
exit "$rc"
`;
  const result = await host.command("bash", ["-lc", script], {
    artifactName: expected.artifactName,
    env: commandEnv(home, { SANDBOX_NAME }),
    timeoutMs: AGENT_TIMEOUT_MS,
  });
  const mockRequests = mockProvider?.requests().slice(requestOffset) ?? [];
  const baselineRequests = baselineProvider?.requests().slice(baselineRequestOffset) ?? [];
  const requestArtifact = "mock-anthropic-openclaw-gateway-requests.json";
  const baselineRequestArtifact = `${expected.artifactName}-baseline-requests.json`;
  await (mockProvider
    ? artifacts.writeJson(requestArtifact, {
        phase: expected.phase,
        requestCount: mockRequests.length,
        requests: mockRequests.slice(0, 20),
        truncated: mockRequests.length > 20,
      })
    : Promise.resolve());
  await (baselineProvider
    ? artifacts.writeJson(baselineRequestArtifact, {
        phase: expected.phase,
        requestCount: baselineRequests.length,
        requests: baselineRequests.slice(0, 20),
        truncated: baselineRequests.length > 20,
      })
    : Promise.resolve());
  const [raw = "", warnings = ""] = result.stdout.split("\n__NEMOCLAW_AGENT_STDERR__\n", 2);
  const modelRun = parseOpenClawGatewayModelRun(raw);
  const reply = modelRun?.text ?? "";
  const fallbackOrPairing =
    /EMBEDDED FALLBACK|gateway connect failed|scope upgrade pending approval|device pairing required|pairing required|fallbackFrom[": ]+gateway|transport[": ]+embedded/i.test(
      [raw, warnings, result.stderr].filter(Boolean).join("\n"),
    );
  const mockRequestMatched =
    !mockProvider ||
    (mockRequests.length > 0 &&
      mockRequests.every(
        (request) =>
          request.method === "POST" &&
          request.path === "/v1/messages" &&
          request.model === expected.model &&
          request.stream &&
          request.toolCount === 0,
      ));
  const baselineRequestMatched =
    !baselineProvider ||
    baselineRequests.some(
      (request) =>
        request.auth === "ok" &&
        request.method === "POST" &&
        request.path === "/v1/chat/completions" &&
        request.model === expected.model,
    );
  const expectedOpenClawProvider =
    expected.inferenceApi === "anthropic-messages" ? "anthropic" : "inference";
  if (
    result.exitCode === 0 &&
    modelRun?.provider === expectedOpenClawProvider &&
    modelRun.model === expected.model &&
    agentReplyContainsToken(reply, "PONG") &&
    !fallbackOrPairing &&
    mockRequestMatched &&
    baselineRequestMatched
  ) {
    return "ok";
  }
  throw new Error(
    [
      `OpenClaw gateway inference failed during ${expected.phase} (exit ${result.exitCode})`,
      `reply=${reply.slice(0, 200)}`,
      `raw=${raw.slice(0, 200)}`,
      `stderr=${[warnings, result.stderr].filter(Boolean).join("\n").slice(0, 200)}`,
      mockProvider && !mockRequestMatched
        ? `request evidence mismatch; see ${requestArtifact}`
        : "",
      baselineProvider && !baselineRequestMatched
        ? `authenticated baseline request evidence mismatch; see ${baselineRequestArtifact}`
        : "",
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
  publicNvidiaApiKey: string | null,
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
        env: {
          ...compatibleAnthropicSwitchEnv(switchBinding),
          ...(publicNvidiaApiKey ? { NVIDIA_INFERENCE_API_KEY: publicNvidiaApiKey } : {}),
        },
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
        "onboard baseline OpenClaw",
        "prove the selected route after onboarding",
        "prove the selected route after gateway restart",
        "prove the selected route after rebuild",
        "prepare the switched provider and endpoint",
        "switch the route and verify restart semantics",
        "inspect route configuration and recorded state",
        "prove sandbox and OpenClaw gateway inference",
        "apply sandbox retention and record the result",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox, secrets, skip }) => {
    await artifacts.target.declare({
      id: "openclaw-inference-switch",
      boundary: "install-sh-openclaw-inference-set-and-live-gateway-model-run",
      sandboxName: SANDBOX_NAME,
      switchProvider: SWITCH_PROVIDER,
      switchModel: SWITCH_MODEL,
      switchInferenceApi: SWITCH_INFERENCE_API,
      contracts: [
        "the selected runtime is available and an authenticated compatible baseline endpoint is staged",
        runtimeProvider.id === "podman"
          ? "stock onboard selects the OpenClaw image from the selected managed-image cohort without a Dockerfile build"
          : "nemoclaw onboard --non-interactive --from onboards an OpenClaw sandbox from a custom Dockerfile",
        "fresh onboarding initializes the primary route with the selected model; the Docker fixture replaces a deliberately incorrect baked route",
        "the selected route completes real OpenClaw gateway inference before and after both lifecycle operations",
        "when staged, the authenticated baseline fixture receives each selected-model OpenClaw gateway request",
        "nemoclaw inference set switches the running sandbox route",
        "OpenClaw gateway is supervisor-restarted after every changed inference configuration",
        "NemoClaw reports the switched provider/model",
        "sandbox inference returns PONG from the switched model",
        "OpenClaw gateway model inference answers through the switched route without agent tools",
      ],
    });

    await runtimeProvider.requireAvailable({
      artifactName: "prereq-runtime-info-openclaw-inference-switch",
      scenarioLabel: "OpenClaw inference switch",
    });

    const publicApiKey =
      SWITCH_PROVIDER === PUBLIC_NVIDIA_SWITCH_PROVIDER
        ? requirePublicNvidiaSwitchKey(secrets.required("NVIDIA_API_KEY"))
        : null;
    const useMockBaseline =
      SWITCH_PROVIDER === PUBLIC_NVIDIA_SWITCH_PROVIDER ||
      (SWITCH_PROVIDER === "compatible-anthropic-endpoint" && SWITCH_MOCK_ANTHROPIC === "1");
    const baselineProvider: FakeOpenAiCompatibleServer | undefined = useMockBaseline
      ? await startMockOpenClawBaselineProvider(progress)
      : undefined;
    cleanup.trackDisposable("close baseline inference provider", async () => {
      try {
        await artifacts.writeJson(
          "baseline-inference-requests.json",
          baselineProvider?.requests() ?? [],
        );
      } finally {
        await baselineProvider?.close();
      }
    });
    const cloudflaredBin = SWITCH_NATIVE_CUSTOM
      ? await resolveVerifiedCloudflaredBinary(cleanup, host)
      : undefined;
    // Hosted endpoint qualification must cross a network boundary. The runner's
    // primary address refers to the guest itself in a rootless Pasta namespace.
    const baselineTunnel =
      cloudflaredBin && baselineProvider
        ? await startPublicMcpHttpsTunnel({
            cloudflaredBin,
            cleanup,
            label: "OpenClaw switch baseline",
            progress,
            server: {
              port: Number(new URL(baselineProvider.baseUrl).port),
              close: () => baselineProvider.close(),
            },
            originProtocol: "http",
            readinessPath: "/v1/models",
            readinessStatus: 200,
          })
        : undefined;
    const baseline = baselineProvider
      ? mockBaselineInference(
          baselineTunnel ? `${baselineTunnel.origin}/v1` : baselineProvider.baseUrl,
        )
      : requireHostedInferenceConfig({
          required: (name) => publicApiKey ?? secrets.required(name),
        });
    const apiKey = baseline.apiKey;
    const redactionValues = [apiKey, publicApiKey].filter(
      (value): value is string => typeof value === "string",
    );

    // Gateway destruction requires trusted ancestors; a private directory under
    // world-writable /tmp cannot supply that ownership authority.
    const home = fs.mkdtempSync(
      path.join(fs.realpathSync(os.homedir()), ".nemoclaw-openclaw-switch-home-"),
    );
    let mockProvider: MockAnthropicProvider | undefined;
    cleanup.trackDisposable(
      `remove OpenClaw inference switch test home for ${SANDBOX_NAME}`,
      () => {
        fs.rmSync(home, { recursive: true, force: true });
      },
    );
    const imageArgs =
      runtimeProvider.id === "podman" ? [] : ["--from", writeCustomOpenClawDockerfile(home)];
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

    progress.phase("onboard baseline OpenClaw");
    const onboard = await host.nemoclaw(["onboard", "--non-interactive", "--yes", ...imageArgs], {
      artifactName: "onboard-custom-image-openclaw-inference-switch",
      env: commandEnv(home, {
        ...baseline.env,
        NEMOCLAW_RECREATE_SANDBOX: "1",
      }),
      redactionValues,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    const onboardText = resultText(onboard);
    const providerValidationUnavailable =
      onboard.exitCode !== 0 && isExternalProviderValidationFailure(onboardText);
    const unavailable = classifyUnavailableInitialProviderEvidence({
      required: SWITCH_PROVIDER === PUBLIC_NVIDIA_SWITCH_PROVIDER,
      detail: onboardText,
    });
    if (providerValidationUnavailable && unavailable.outcome === "skipped") {
      await artifacts.target.complete({
        id: "openclaw-inference-switch",
        status: "skipped",
        reason: "external-provider-validation-unavailable-before-inference-switch",
        onboardExitCode: onboard.exitCode,
      });
      skip(unavailable.reason);
    }
    expect(onboard.exitCode, onboardText).toBe(0);

    await approveOpenClawAdminScope(
      host,
      sandbox,
      SANDBOX_NAME,
      commandEnv(home),
      redactionValues,
      false,
    );
    const verifyInitialRoute = async (artifactSuffix: string): Promise<void> => {
      await recordOpenClawConfig(sandbox, home, {
        model: baseline.model,
        inferenceApi: "openai-completions",
        artifactName: `read-openclaw-initial-route-${artifactSuffix}`,
        nativeCustomEndpoint: baselineTunnel ? baseline.endpointUrl : undefined,
      });
      await checkOpenClawGatewayInference(
        host,
        home,
        artifacts,
        {
          model: baseline.model,
          inferenceApi: "openai-completions",
          artifactName: `openclaw-gateway-inference-initial-route-${artifactSuffix}`,
          phase: `prove initial route ${artifactSuffix}`,
        },
        undefined,
        baselineProvider,
      );
    };
    const requireLifecycleSuccess = (result: ShellProbeResult): void => {
      expect(result.exitCode, resultText(result)).toBe(0);
    };

    progress.phase("prove the selected route after onboarding");
    await verifyInitialRoute("after-onboard");

    progress.phase("prove the selected route after gateway restart");
    const restart = await host.nemoclaw([SANDBOX_NAME, "gateway", "restart"], {
      artifactName: "restart-openclaw-initial-custom-route",
      env: commandEnv(home),
      redactionValues: redactionValues,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    requireLifecycleSuccess(restart);
    await verifyInitialRoute("after-restart");

    progress.phase("prove the selected route after rebuild");
    const rebuild = await host.nemoclaw([SANDBOX_NAME, "rebuild", "--yes", "--verbose"], {
      artifactName: "rebuild-openclaw-initial-custom-route",
      env: commandEnv(home),
      redactionValues: redactionValues,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    requireLifecycleSuccess(rebuild);
    await verifyInitialRoute("after-rebuild");

    progress.phase("prepare the switched provider and endpoint");
    if (SWITCH_PROVIDER === "compatible-anthropic-endpoint" && SWITCH_MOCK_ANTHROPIC === "1") {
      mockProvider = await startMockAnthropicProvider({
        cleanup,
        progress,
        cloudflaredBin,
        nativeCustom: SWITCH_NATIVE_CUSTOM,
        port: SWITCH_MOCK_PORT,
      });
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
    await approveOpenClawAdminScope(
      host,
      sandbox,
      SANDBOX_NAME,
      commandEnv(home),
      redactionValues,
      false,
    );
    const pidBefore = await openclawGatewayPid(sandbox, home, "before");
    const switchResult = await runOpenClawInferenceSetWithRetry(
      host,
      home,
      redactionValues,
      switchBinding,
      publicApiKey,
      artifacts,
    );
    expect(switchResult.exitCode, resultText(switchResult)).toBe(0);

    const pidAfter = await openclawGatewayPid(sandbox, home, "after");
    const gatewayPidStable = pidBefore === pidAfter;
    expect(
      openClawGatewayRestarted(pidBefore, pidAfter),
      `OpenClaw gateway requires distinct valid process IDs after the config switch (${pidBefore || "missing"} -> ${pidAfter || "missing"})`,
    ).toBe(true);

    progress.phase("inspect route configuration and recorded state");
    const route = await getRouteOutput(host, {
      env: commandEnv(home),
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    expect(route.exitCode, resultText(route)).toBe(0);
    const routeState = JSON.parse(route.stdout) as { provider?: unknown; model?: unknown };
    expect(routeState.provider).toBe(SWITCH_PROVIDER);
    expect(routeState.model).toBe(SWITCH_MODEL);
    await recordOpenClawConfig(sandbox, home, {
      model: SWITCH_MODEL,
      inferenceApi: SWITCH_INFERENCE_API,
      artifactName: "read-openclaw-config-after-inference-switch",
      nativeNvidia: SWITCH_PROVIDER === PUBLIC_NVIDIA_SWITCH_PROVIDER,
      nativeCustomEndpoint: SWITCH_NATIVE_CUSTOM ? switchBinding!.endpointUrl : undefined,
    });
    await verifyNativeNvidiaAttachmentAfterSwitch(home, sandbox);

    progress.phase("prove sandbox and OpenClaw gateway inference");
    const inference = await checkSandboxInference(
      sandbox,
      artifacts,
      home,
      SWITCH_NATIVE_CUSTOM ? switchBinding!.endpointUrl : undefined,
    );
    if (inference !== "ok") {
      await artifacts.target.complete({
        id: "openclaw-inference-switch",
        status: "skipped",
        reason: inference.skipped,
        routeAndConfigChecksPassed: true,
      });
      skip(inference.skipped);
    }

    const gatewayInference = await checkOpenClawGatewayInference(
      host,
      home,
      artifacts,
      {
        model: SWITCH_MODEL,
        inferenceApi: SWITCH_INFERENCE_API,
        artifactName: "openclaw-gateway-inference-after-switch",
        phase: "prove sandbox and OpenClaw gateway inference",
      },
      mockProvider,
    );
    if (gatewayInference !== "ok") {
      await artifacts.target.complete({
        id: "openclaw-inference-switch",
        status: "skipped",
        reason: gatewayInference.skipped,
        routeConfigAndInferenceChecksPassed: true,
      });
      skip(gatewayInference.skipped);
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
        baselineOnboardingCompleted: onboard.exitCode === 0,
        baselineInitialRouteSelected: true,
        baselineRouteSurvivedGatewayRestart: true,
        baselineRouteSurvivedRebuild: true,
        baselineGatewayReachedFixture: baselineProvider ? true : null,
        inferenceSetCompleted: switchResult.exitCode === 0,
        gatewayRestartExpected: true,
        gatewayPidStable,
        routeChecked: true,
        inferenceLocalPong: true,
        inferenceLocalModelMatched: true,
        openClawGatewayInferencePong: true,
      },
    });
  },
);

test(
  "TC-INF-17 OpenClaw uses authenticated native local inference after rebuild and restart (#12975)",
  {
    timeout: OPENCLAW_NATIVE_LOCAL_TEST_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "confirm live inference prerequisites",
        "onboard native OpenClaw owner",
        "rebuild native OpenClaw owner",
        "restart native OpenClaw owner",
        "onboard shared-route sibling",
        "record shared route before model switch",
        "switch native OpenClaw model",
        "verify shared route unchanged",
        "request inference through OpenClaw",
        "check credential isolation",
        "verify owner reachability",
        "verify sibling denial",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox }) => {
    progress.phase("onboard native OpenClaw owner");
    const selected = await onboardNativeOpenClaw(true, {
      artifacts,
      cleanup,
      host,
      progress,
      runtimeProvider,
      sandbox,
    });
    const { owner, model, switchedModel, apiKey, fake, onboard, attachment } = selected;
    expectOnboardSuccess(onboard, `${owner} onboard`);
    progress.phase("rebuild native OpenClaw owner");
    const rebuild = await host.nemoclaw([owner, "rebuild", "--yes", "--verbose"], {
      artifactName: `${owner}-rebuild`,
      env: { ...buildAvailabilityProbeEnv(), NEMOCLAW_LLAMACPP_LOCAL_TOKEN: apiKey },
      redactionValues: [apiKey],
      timeoutMs: 20 * 60_000,
    });
    expect(rebuild.exitCode, resultText(rebuild)).toBe(0);
    progress.phase("restart native OpenClaw owner");
    const stop = await host.nemoclaw([owner, "stop"], {
      artifactName: `${owner}-stop`,
      env: sandboxAccessEnv(),
      timeoutMs: 120_000,
    });
    expect(stop.exitCode, resultText(stop)).toBe(0);
    const start = await host.nemoclaw([owner, "start"], {
      artifactName: `${owner}-start`,
      env: sandboxAccessEnv(),
      timeoutMs: 120_000,
    });
    expect(start.exitCode, resultText(start)).toBe(0);
    progress.phase("onboard shared-route sibling");
    const sibling = inferenceSandboxName("e2e-oc-peer");
    const peerEndpoint = await startFakeOpenAiCompatibleServer({
      apiKey,
      model,
      host: "0.0.0.0",
      publicHost: "host.openshell.internal",
      requireAuth: true,
      progress,
    });
    cleanup.add(`close ${sibling} endpoint`, () => peerEndpoint.close());
    cleanup.add(`remove ${sibling}`, () =>
      cleanupSandbox(host, sandbox, sibling, { strict: true }),
    );
    await cleanupSandbox(host, sandbox, sibling);
    const peer = await onboardSandbox(
      artifacts,
      sibling,
      {
        NEMOCLAW_AGENT: "openclaw",
        NEMOCLAW_PROVIDER: "custom",
        NEMOCLAW_MODEL: model,
        NEMOCLAW_ENDPOINT_URL: peerEndpoint.baseUrl,
        NEMOCLAW_PREFERRED_API: "openai-completions",
        COMPATIBLE_API_KEY: apiKey,
      },
      [apiKey],
      `${sibling}-onboard`,
      progress,
      ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS,
    );
    expectOnboardSuccess(peer, `${sibling} onboard`);
    progress.phase("record shared route before model switch");
    const sharedBefore = await sandbox.openshell(["inference", "get", "-g", "nemoclaw"], {
      artifactName: `${owner}-shared-route-before-switch`,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    expect(sharedBefore.exitCode, resultText(sharedBefore)).toBe(0);
    progress.phase("switch native OpenClaw model");
    const switched = await host.nemoclaw(
      ["inference", "set", "--provider", "llama-cpp", "--model", switchedModel, "--sandbox", owner],
      {
        artifactName: `${owner}-model-switch`,
        env: { ...buildAvailabilityProbeEnv(), NEMOCLAW_LLAMACPP_LOCAL_TOKEN: apiKey },
        redactionValues: [apiKey],
        timeoutMs: 5 * 60_000,
      },
    );
    expect(switched.exitCode, resultText(switched)).toBe(0);
    progress.phase("verify shared route unchanged");
    const sharedAfter = await sandbox.openshell(["inference", "get", "-g", "nemoclaw"], {
      artifactName: `${owner}-shared-route-after-switch`,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    expect(sharedAfter.exitCode).toBe(sharedBefore.exitCode);
    expect(sharedAfter.stdout).toBe(sharedBefore.stdout);
    progress.phase("request inference through OpenClaw");
    const { turn, requests } = await requestNativeOpenClaw(
      owner,
      apiKey,
      fake,
      host,
      switchedModel,
    );
    expect(turn.exitCode, resultText(turn)).toBe(0);
    assertAgentExecutionSucceeded(turn.stdout, "inference", switchedModel);
    expect(
      requests.some((request) => request.path === "/v1/chat/completions" && request.auth === "ok"),
    ).toBe(true);
    progress.phase("check credential isolation");
    const scan = await sandbox.exec(owner, hostedCredentialScanCommand(apiKey), {
      artifactName: `${owner}-credential-scan`,
      env: sandboxAccessEnv(),
      timeoutMs: 60_000,
      redactionValues: [apiKey],
    });
    expect(scan.exitCode, resultText(scan)).toBe(0);
    expect(JSON.parse(scan.stdout)).toMatchObject({
      environmentClean: true,
      processesClean: true,
      sampledFilesClean: true,
      canaryDetected: true,
    });
    progress.phase("verify owner reachability");
    const beforeOwnerProbe = fake.requests().length;
    const ownerProbe = await sandbox.exec(
      owner,
      [
        "curl",
        "--fail",
        "--max-time",
        "15",
        "--header",
        `Authorization: Bearer ${apiKey}`,
        `${attachment!.endpointUrl}/models`,
      ],
      {
        artifactName: `${owner}-owner-reachability`,
        env: sandboxAccessEnv(),
        timeoutMs: 30_000,
        redactionValues: [apiKey],
      },
    );
    expect(ownerProbe.exitCode, resultText(ownerProbe)).toBe(0);
    expect(
      fake
        .requests()
        .slice(beforeOwnerProbe)
        .some((request) => request.path.endsWith("/models") && request.auth === "ok"),
    ).toBe(true);
    progress.phase("verify sibling denial");
    const beforeDenied = fake.requests().length;
    const denied = await sandbox.exec(
      sibling,
      [
        "curl",
        "--fail",
        "--max-time",
        "15",
        "--header",
        `Authorization: Bearer ${apiKey}`,
        `${attachment!.endpointUrl}/models`,
      ],
      {
        artifactName: `${sibling}-owner-denial`,
        env: sandboxAccessEnv(),
        timeoutMs: 30_000,
        redactionValues: [apiKey],
      },
    );
    expect(denied.exitCode).not.toBe(0);
    expect(fake.requests()).toHaveLength(beforeDenied);
  },
);

test(
  "TC-INF-18 OpenClaw uses a credentialless native local vLLM endpoint (#12975)",
  {
    timeout: ONBOARD_SINGLE_FINAL_HANDOFF_TEST_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "confirm live inference prerequisites",
        "onboard native OpenClaw owner",
        "request inference through OpenClaw",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox }) => {
    progress.phase("onboard native OpenClaw owner");
    const { owner, apiKey, fake, onboard } = await onboardNativeOpenClaw(false, {
      artifacts,
      cleanup,
      host,
      progress,
      runtimeProvider,
      sandbox,
    });
    expectOnboardSuccess(onboard, `${owner} onboard`);
    progress.phase("request inference through OpenClaw");
    const { turn, requests } = await requestNativeOpenClaw(owner, apiKey, fake, host);
    expect(turn.exitCode, resultText(turn)).toBe(0);
    assertAgentExecutionSucceeded(turn.stdout, "inference", "nemoclaw-openclaw-native-local");
    expect(
      requests.some(
        (request) =>
          request.path === "/v1/chat/completions" &&
          request.auth === "ok" &&
          request.authorizationSent === true,
      ),
    ).toBe(true);
    expect(requests.every((request) => request.auth === "ok")).toBe(true);
  },
);

test.skipIf(!isWslDockerIpv6TestHost())(
  "TC-INF-19 OpenClaw admits a WSL2 IPv6 host bridge and denies other IPv6 destinations (#13544)",
  {
    timeout: ONBOARD_SINGLE_FINAL_HANDOFF_TEST_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "confirm live inference prerequisites",
        "onboard native OpenClaw owner",
        "verify IPv6 policy boundary",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox }) => {
    progress.phase("onboard native OpenClaw owner");
    const context = { artifacts, cleanup, host, progress, runtimeProvider, sandbox };
    const selected = await onboardNativeOpenClaw(true, context, "::");
    const { owner, apiKey, fake, onboard, attachment } = selected;
    const options = { env: sandboxAccessEnv(), timeoutMs: 150_000, redactionValues: [apiKey] };
    expectOnboardSuccess(onboard, `${owner} IPv6 onboard`);
    progress.phase("verify IPv6 policy boundary");
    const resolution = await sandbox.exec(owner, nativeLocalIpv6ResolutionCommand(), {
      artifactName: `${owner}-ipv6-resolution`,
      env: sandboxAccessEnv(),
      timeoutMs: 30_000,
    });
    expect(resolution.exitCode, resultText(resolution)).toBe(0);
    expect(nativeLocalUlaOnlyResolution(resolution.stdout), resolution.stdout).toBe(true);
    const offset = fake.requests().length;
    const body = JSON.stringify({
      model: "nemoclaw-openclaw-native-local",
      messages: [{ role: "user", content: "PONG" }],
      max_tokens: 8,
    });
    const reply = await sandbox.execShell(
      owner,
      trustedSandboxShellScript(nativeLocalChatCommand(attachment!.endpointUrl, body, "-fsS")),
      { ...options, artifactName: `${owner}-ipv6-chat` },
    );
    expect(reply.exitCode, resultText(reply)).toBe(0);
    const requests = fake.requests().slice(offset);
    expect(requests.some((r) => r.path === "/v1/chat/completions" && r.auth === "ok")).toBe(true);
    const [publicIpv6, linkLocal, loopback] = await Promise.all(
      ["2001:4860:4860::8888", "fe80::1", "::1"].map((address) =>
        sandbox.exec(owner, nativeLocalIpv6DeniedCommand(address, body), {
          artifactName: `${owner}-ipv6-deny-${address.replaceAll(":", "-")}`,
          env: sandboxAccessEnv(),
          timeoutMs: 30_000,
        }),
      ),
    );
    const policyDenied = /"error"\s*:\s*"policy_denied"[\s\S]*\n403$/;
    expect(publicIpv6.stdout, resultText(publicIpv6)).toMatch(policyDenied);
    expect(linkLocal.stdout, resultText(linkLocal)).toMatch(policyDenied);
    expect(loopback.stdout, resultText(loopback)).toMatch(policyDenied);
  },
);
