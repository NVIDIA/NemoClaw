// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Fixture and response helpers shared by the openclaw-inference-switch live
// target and fast e2e-support tests without gating on NEMOCLAW_RUN_LIVE_E2E=1.

import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { CLI_ENTRYPOINT } from "../fixtures/paths.ts";
import type { RetryFailureClass } from "../../../tools/e2e/retry-evidence.mts";
import {
  startFakeOpenAiCompatibleServer,
  type FakeOpenAiCompatibleServerOptions,
} from "../fixtures/fake-openai-compatible.ts";

export interface OpenClawPostSwitchInferenceAttempt {
  exitCode: number | null;
  httpStatus: string;
  malformed: boolean;
  output: string;
  productMatched: boolean;
}

export interface OpenClawGatewayIdentity {
  bootId: string;
}

export function parseOpenClawGatewayIdentity(raw: string): OpenClawGatewayIdentity | null {
  try {
    const status = JSON.parse(raw) as {
      rpc?: { ok?: unknown; server?: { bootId?: unknown } };
    } | null;
    const bootId = status?.rpc?.server?.bootId;
    return status?.rpc?.ok === true &&
      typeof bootId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(bootId)
      ? { bootId }
      : null;
  } catch {
    return null;
  }
}

export function openClawGatewayRestarted(
  before: OpenClawGatewayIdentity | null,
  after: OpenClawGatewayIdentity | null,
): boolean {
  // Native container restarts replace the gateway boot within the same OS process.
  return before !== null && after !== null && before.bootId !== after.bootId;
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
) {
  return startFakeOpenAiCompatibleServer({
    apiKey: MOCK_BASELINE_API_KEY,
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
  },
): Promise<ShellProbeResult> {
  return sandbox.exec(
    sandboxName,
    options.nativeNvidia || options.nativeCustomApi
      ? [
          "node",
          "-e",
          [
            'const fs = require("node:fs");',
            'const config = JSON.parse(fs.readFileSync("/sandbox/.openclaw/openclaw.json", "utf8"));',
            `const provider = config.models?.providers?.${options.nativeCustomApi === "anthropic-messages" ? "anthropic" : "inference"};`,
            // A fresh exec receives the newly attached provider handle. Keep
            // both values inside the sandbox because ShellProbe redacts the
            // credential-shaped config field before returning stdout.
            `const credentialEnv = ${JSON.stringify(options.nativeCustomApi ? (options.nativeCustomApi === "anthropic-messages" ? "COMPATIBLE_ANTHROPIC_API_KEY" : "COMPATIBLE_API_KEY") : "NVIDIA_INFERENCE_API_KEY")};`,
            "const handle = process.env[credentialEnv];",
            'require("node:assert/strict").ok(new RegExp("^openshell:resolve:env:(?:v[0-9]{1,20}|s[a-f0-9]{64})_" + credentialEnv + "$").test(handle ?? "") && provider?.apiKey === handle, "native credential reference mismatch");',
            "delete provider.apiKey;",
            "process.stdout.write(JSON.stringify(config));",
          ].join(" "),
        ]
      : ["cat", "/sandbox/.openclaw/openclaw.json"],
    { artifactName: options.artifactName, env: options.env, timeoutMs: options.timeoutMs },
  );
}
