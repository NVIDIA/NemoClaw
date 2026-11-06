// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Fixture and response helpers shared by the openclaw-inference-switch live
// target and fast e2e-support tests without gating on NEMOCLAW_RUN_LIVE_E2E=1.

import fs from "node:fs";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { CLI_ENTRYPOINT } from "../fixtures/paths.ts";
import type { RetryFailureClass } from "../../../tools/e2e/retry-evidence.mts";
import {
  startFakeOpenAiCompatibleServer,
  type FakeOpenAiCompatibleServerOptions,
} from "../fixtures/fake-openai-compatible.ts";

// PID/start time survives execve. Native RPC status includes the authenticated hello boot ID.
export async function readOpenClawBootId(
  sandbox: SandboxClient,
  sandboxName: string,
  options: { env: NodeJS.ProcessEnv; artifactName: string },
): Promise<string | null> {
  const result = await sandbox.exec(
    sandboxName,
    [
      "openclaw",
      "gateway",
      "status",
      "--port",
      "18789",
      "--require-rpc",
      "--json",
      "--timeout",
      "10000",
    ],
    { ...options, timeoutMs: 20_000 },
  );
  // Launcher diagnostics use stderr even when the authenticated RPC succeeds.
  if (result.exitCode !== 0 || result.timedOut || result.signal !== null) return null;
  try {
    const document = JSON.parse(result.stdout) as {
      rpc?: { ok?: unknown; kind?: unknown; server?: { bootId?: unknown } };
    } | null;
    const rpc = document?.rpc;
    const bootId = rpc?.server?.bootId;
    return rpc?.ok === true &&
      rpc.kind === "read" &&
      typeof bootId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(bootId)
      ? bootId
      : null;
  } catch {
    return null;
  }
}

export interface OpenClawPostSwitchInferenceAttempt {
  exitCode: number | null;
  httpStatus: string;
  malformed: boolean;
  output: string;
  productMatched: boolean;
}

export type OpenClawPostSwitchInferenceClassification =
  | { outcome: "passed" }
  | { outcome: "failed"; failureClass: RetryFailureClass };

export type ExhaustedPostSwitchEvidence =
  | { outcome: "failed"; message: string }
  | { outcome: "skipped"; reason: string };

export type UnavailableInitialProviderEvidence =
  | { outcome: "failed"; message: string }
  | { outcome: "skipped"; reason: string };

/** Required provider qualification cannot succeed by skipping failed onboarding validation. */
export function classifyUnavailableInitialProviderEvidence(input: {
  required: boolean;
  detail: string;
}): UnavailableInitialProviderEvidence {
  const detail = `External provider validation was unavailable during onboarding: ${input.detail}`;
  return input.required
    ? { outcome: "failed", message: `Required native provider evidence failed: ${detail}` }
    : { outcome: "skipped", reason: detail };
}

/** Required provider evidence fails closed after bounded transient retries. */
export function classifyExhaustedPostSwitchEvidence(input: {
  required: boolean;
  lastFailure: string;
}): ExhaustedPostSwitchEvidence {
  const detail = `Sandbox inference transient failure after switch; route/config checks already passed: ${input.lastFailure}`;
  return input.required
    ? { outcome: "failed", message: `Required native provider evidence failed: ${detail}` }
    : { outcome: "skipped", reason: detail };
}

export function classifyOpenClawPostSwitchInferenceAttempt(
  attempt: OpenClawPostSwitchInferenceAttempt,
): OpenClawPostSwitchInferenceClassification {
  if (attempt.productMatched) return { outcome: "passed" };
  if (attempt.malformed || /malformed|invalid (?:request|json)/iu.test(attempt.output)) {
    return { outcome: "failed", failureClass: "malformed-input" };
  }
  if (
    /authentication failed|unauthorized|HTTP 401\b|\b401\b|invalid (?:credential|api[_ -]?key)/iu.test(
      attempt.output,
    )
  ) {
    return { outcome: "failed", failureClass: "authentication" };
  }
  if (/authorization failed|forbidden|HTTP 403\b|\b403\b/iu.test(attempt.output)) {
    return { outcome: "failed", failureClass: "authorization" };
  }
  if (
    /denied by network policy|network policy denied|policy (?:update |validation )?failed/iu.test(
      attempt.output,
    )
  ) {
    return { outcome: "failed", failureClass: "policy-denial" };
  }
  const curlTransportExit =
    typeof attempt.exitCode === "number" && [6, 7, 28, 35, 52, 56].includes(attempt.exitCode);
  const transientTransport = curlTransportExit;
  const transientStatus =
    attempt.exitCode === 0 && /^(408|429|5[0-9]{2})$/u.test(attempt.httpStatus);
  return transientTransport || transientStatus
    ? { outcome: "failed", failureClass: "transient-external" }
    : { outcome: "failed", failureClass: "deterministic" };
}

export function agentReplyContainsToken(reply: string, expected: string): boolean {
  const normalizedReply = reply.replace(/\s+/gu, "").toUpperCase();
  const normalizedExpected = expected.replace(/\s+/gu, "").toUpperCase();
  return normalizedExpected.length > 0 && normalizedReply === normalizedExpected;
}

/** Record zero only when Anthropic tools are absent or an empty array. */
export function anthropicToolCount(tools: unknown): number | null {
  if (tools === undefined) return 0;
  return Array.isArray(tools) ? tools.length : null;
}

export interface OpenClawGatewayModelRunResult {
  model: string;
  provider: string;
  text: string;
  transport: "gateway";
}

/** Parse the stable JSON envelope emitted by `openclaw infer model run --gateway`. */
export function parseOpenClawGatewayModelRun(raw: string): OpenClawGatewayModelRunResult | null {
  let document: unknown;
  try {
    document = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) return null;
  const record = document as Record<string, unknown>;
  if (
    record.ok !== true ||
    record.capability !== "model.run" ||
    record.transport !== "gateway" ||
    typeof record.provider !== "string" ||
    typeof record.model !== "string" ||
    !Array.isArray(record.outputs)
  ) {
    return null;
  }
  const text = record.outputs
    .map((output) =>
      output &&
      typeof output === "object" &&
      typeof (output as { text?: unknown }).text === "string"
        ? (output as { text: string }).text
        : "",
    )
    .join("")
    .trim();
  if (!text) return null;
  return {
    model: record.model,
    provider: record.provider,
    text,
    transport: "gateway",
  };
}

// Baseline (mock-Anthropic) inference config the live target builds when
// NEMOCLAW_SWITCH_MOCK_ANTHROPIC=1 points OpenClaw at a local fake OpenAI-
// compatible server. Extracted so the fast e2e-support project can assert the
// exact env wiring (credential, model, endpoint, preferred API, provider)
// without gating on NEMOCLAW_RUN_LIVE_E2E=1.
export const MOCK_BASELINE_API_KEY = "openclaw-switch-baseline-credential";
export const MOCK_BASELINE_MODEL = "openclaw-switch-baseline-model";

export function startMockOpenClawBaselineProvider(
  progress: FakeOpenAiCompatibleServerOptions["progress"],
  publicHost = "host.openshell.internal",
  apiKey = MOCK_BASELINE_API_KEY,
) {
  return startFakeOpenAiCompatibleServer({
    apiKey,
    chatContent: "PONG",
    host: "0.0.0.0",
    model: MOCK_BASELINE_MODEL,
    publicHost,
    progress,
    requireAuth: true,
  });
}

export interface BaselineInferenceConfig {
  apiKey: string;
  endpointUrl: string;
  env: NodeJS.ProcessEnv;
  model: typeof MOCK_BASELINE_MODEL;
}

export function mockBaselineInference(endpointUrl: string): BaselineInferenceConfig {
  return {
    apiKey: MOCK_BASELINE_API_KEY,
    endpointUrl,
    model: MOCK_BASELINE_MODEL,
    env: {
      COMPATIBLE_API_KEY: MOCK_BASELINE_API_KEY,
      NEMOCLAW_COMPAT_MODEL: MOCK_BASELINE_MODEL,
      NEMOCLAW_ENDPOINT_URL: endpointUrl,
      NEMOCLAW_MODEL: MOCK_BASELINE_MODEL,
      NEMOCLAW_PREFERRED_API: "openai-completions",
      NEMOCLAW_PROVIDER: "custom",
    },
  };
}

/** Read the structured route through the same host CLI used by the live scenario. */
export async function getRouteOutput(
  host: HostCliClient,
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<ShellProbeResult> {
  return host.command("node", [CLI_ENTRYPOINT, "inference", "get", "--json"], {
    ...options,
    artifactName: "nemoclaw-inference-get-after-switch",
  });
}

/** Validate the native handle inside the sandbox before artifact redaction. */
export async function readOpenClawConfig(
  sandbox: SandboxClient,
  sandboxName: string,
  options: {
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    artifactName: string;
    nativeNvidia?: boolean;
    nativeCustomApi?: string;
    registeredProvider?: string;
    credentialEnv?: string;
  },
): Promise<ShellProbeResult> {
  return sandbox.exec(
    sandboxName,
    options.nativeNvidia || options.nativeCustomApi || options.registeredProvider
      ? [
          "node",
          "-e",
          [
            'const fs = require("node:fs");',
            'const config = JSON.parse(fs.readFileSync("/sandbox/.openclaw/openclaw.json", "utf8"));',
            `const provider = config.models?.providers?.[${JSON.stringify(options.registeredProvider ?? (options.nativeCustomApi === "anthropic-messages" ? "anthropic" : "inference"))}];`,
            // OpenShell retains scoped handles across same-provider revisions.
            // Check their form here; the caller also proves provider attachment
            // and authenticated inference through the actual OpenClaw gateway.
            // Keep both values inside the sandbox before artifact redaction.
            `const credentialEnv = ${JSON.stringify(options.credentialEnv ?? (options.nativeCustomApi ? (options.nativeCustomApi === "anthropic-messages" ? "COMPATIBLE_ANTHROPIC_API_KEY" : "COMPATIBLE_API_KEY") : "NVIDIA_INFERENCE_API_KEY"))};`,
            "const handle = process.env[credentialEnv];",
            'const scoped = new RegExp("^openshell:resolve:env:(?:v[0-9]{1,20}|s[a-f0-9]{64})_" + credentialEnv + "$");',
            'require("node:assert/strict").ok(typeof handle === "string" && scoped.test(handle), "native exec credential is not scoped");',
            'require("node:assert/strict").ok(typeof provider?.apiKey === "string" && scoped.test(provider.apiKey), "native config credential is not scoped");',
            "delete provider.apiKey;",
            "process.stdout.write(JSON.stringify(config));",
          ].join(" "),
        ]
      : ["cat", "/sandbox/.openclaw/openclaw.json"],
    { artifactName: options.artifactName, env: options.env, timeoutMs: options.timeoutMs },
  );
}

export function httpStatusFromResponse(response: string): string {
  return (
    response
      .split("\n")
      .filter((line) => line.startsWith("__NEMOCLAW_HTTP_STATUS__="))
      .at(-1)
      ?.replace("__NEMOCLAW_HTTP_STATUS__=", "")
      .trim() ?? ""
  );
}

export function httpBodyFromResponse(response: string): string {
  return response
    .split("\n")
    .filter((line) => !line.startsWith("__NEMOCLAW_HTTP_STATUS__="))
    .join("\n");
}

// Keep ownership records until the CLI teardown and its runtime absence check finish.
// Cache failure as well as success: cleanup registration must not repeat a failed destroy.
export function createOpenClawInferenceSwitchCleanup(input: {
  host: HostCliClient;
  verifyGatewayRemoved: () => Promise<void>;
  sandboxName: string;
  home: string;
  env: NodeJS.ProcessEnv;
  retain: boolean;
}): () => Promise<void> {
  let cleanup: Promise<void> | undefined;
  return () => {
    cleanup ??= input.retain
      ? Promise.resolve()
      : (async () => {
          await input.host.cleanupSandbox(input.sandboxName, {
            cleanupGateway: true,
            artifactName: "cleanup-inference-switch-sandbox-and-gateway",
            env: input.env,
            timeoutMs: 120_000,
          });
          await input.verifyGatewayRemoved();
          fs.rmSync(input.home, { recursive: true, force: true });
        })();
    return cleanup;
  };
}

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

export function parseChatContent(raw: string): string {
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

export function parseAnthropicContent(raw: string): string {
  const response = JSON.parse(raw) as AnthropicResponse;
  return (response.content ?? [])
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join(" ")
    .trim();
}
