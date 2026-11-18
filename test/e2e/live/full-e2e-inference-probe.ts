// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  normalizeNativeLocalProviderAttachment,
  NATIVE_LOCAL_CREDENTIAL_ENV,
} from "../../../src/lib/inference/native-local/contract.ts";
import { parseCliOpenShellProviderMetadata } from "../../../src/lib/adapters/openshell/provider-metadata-cli.ts";
import { hostedNativeProviderForAttachment } from "../../../src/lib/inference/native-provider/hosted-attachment.ts";
import { getSandboxInferenceConfig } from "../../../src/lib/inference/config.ts";
import type { SandboxEntry } from "../../../src/lib/state/registry/types.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import {
  PUBLIC_NVIDIA_SWITCH_ATTACHMENT_EVIDENCE,
  readPublicNvidiaSwitchAttachmentEvidence,
} from "./public-nvidia-switch-provider.ts";

import { runBoundedRetry, type RetryEvidence } from "../../../tools/e2e/retry-evidence.mts";

import { resolveMaxTokensField } from "../../../src/lib/inference/max-tokens-field.ts";
import { RETRIABLE_HTTP_PROBE_STATUSES } from "../../../src/lib/inference/probe/transient-http-policy.ts";
import { containsAnswer, containsToolCallStructure } from "../../helpers/e2e-answer-assertions.ts";

const ARITHMETIC_PROMPT = "What is 6 multiplied by 7? Reply with only the integer, no extra words.";

export const FULL_E2E_INFERENCE_REPLY_BUDGETS = [512, 1024] as const;
export const FULL_E2E_INFERENCE_CAPTURE_LIMIT_BYTES = 256 * 1024;
export const FULL_E2E_INFERENCE_EVIDENCE_LIMIT_BYTES = 32 * 1024;

const EVIDENCE_TEXT_LIMIT_BYTES = 4 * 1024;
const EVIDENCE_PARSE_ERROR_LIMIT_BYTES = 2 * 1024;
const EVIDENCE_MODEL_LIMIT_BYTES = 512;
const EVIDENCE_FINISH_REASON_LIMIT_BYTES = 128;
const TRUNCATION_SUFFIX = "...[truncated]";

const USAGE_TOTAL_FIELDS = ["prompt_tokens", "completion_tokens", "total_tokens"] as const;
const USAGE_DETAIL_FIELDS = [
  "audio_tokens",
  "cached_tokens",
  "reasoning_tokens",
  "accepted_prediction_tokens",
  "rejected_prediction_tokens",
] as const;
const USAGE_DETAIL_GROUPS = ["prompt_tokens_details", "completion_tokens_details"] as const;

export interface InferenceCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface FullE2eInferenceResponseEvidence {
  answer: string;
  content: string;
  finishReason: string | null;
  model: string | null;
  reasoningContent: string;
  usage: Record<string, unknown> | null;
}

export interface FullE2eInferenceAttempt<Result extends InferenceCommandResult> {
  answerMatched: boolean;
  attempt: number;
  maxTokens: number;
  parseError?: string;
  response?: FullE2eInferenceResponseEvidence;
  result: Result;
}

export type FullE2eInferenceOutcome =
  | "passed"
  | "command-failure"
  | "response-failure"
  | "semantic-mismatch";

export interface FullE2eInferenceProbeResult<Result extends InferenceCommandResult> {
  attempts: FullE2eInferenceAttempt<Result>[];
  outcome: FullE2eInferenceOutcome;
}

export interface FullE2eInferenceAttemptInput {
  artifactName: string;
  attempt: number;
  maxTokens: number;
  requestBody: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function limitUtf8(value: string, limitBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= limitBytes) return value;
  const contentLimit = limitBytes - Buffer.byteLength(TRUNCATION_SUFFIX, "utf8");
  let content = "";
  let contentBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (contentBytes + characterBytes > contentLimit) break;
    content += character;
    contentBytes += characterBytes;
  }
  return `${content}${TRUNCATION_SUFFIX}`;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function projectUsageDetails(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const details = Object.fromEntries(
    USAGE_DETAIL_FIELDS.flatMap((field) => {
      const projected = finiteNumber(value[field]);
      return projected === undefined ? [] : [[field, projected]];
    }),
  );
  return Object.keys(details).length > 0 ? details : undefined;
}

function projectUsage(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!value) return null;
  const projected: Record<string, unknown> = {};
  for (const field of USAGE_TOTAL_FIELDS) {
    const total = finiteNumber(value[field]);
    if (total !== undefined) projected[field] = total;
  }
  for (const field of USAGE_DETAIL_GROUPS) {
    const details = projectUsageDetails(value[field]);
    if (details) projected[field] = details;
  }
  return projected;
}

export function buildFullE2eInferenceRequest(model: string, maxTokens: number): string {
  const maxTokensField = resolveMaxTokensField(model);
  return JSON.stringify({
    model,
    messages: [{ role: "user", content: ARITHMETIC_PROMPT }],
    ...(maxTokensField === "max_tokens" ? { temperature: 0 } : {}),
    [maxTokensField]: maxTokens,
    stream: false,
  });
}

export function parseFullE2eInferenceResponse(body: string): FullE2eInferenceResponseEvidence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error(
      `inference.local returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (!isRecord(parsed)) throw new Error("inference.local response must be a JSON object");
  const choices = parsed.choices;
  if (!Array.isArray(choices) || !isRecord(choices[0])) {
    throw new Error("inference.local response must contain choices[0]");
  }
  const choice = choices[0];
  if (!isRecord(choice.message)) {
    throw new Error("inference.local response must contain choices[0].message");
  }
  if (containsToolCallStructure(parsed)) {
    throw new Error("inference.local response must not contain tool-call structure");
  }

  const content = optionalString(choice.message.content)?.trim() ?? "";
  const reasoningContent =
    (
      optionalString(choice.message.reasoning_content) ?? optionalString(choice.message.reasoning)
    )?.trim() ?? "";
  return {
    answer: content || reasoningContent,
    content,
    finishReason: optionalString(choice.finish_reason),
    model: optionalString(parsed.model),
    reasoningContent,
    usage: isRecord(parsed.usage) ? parsed.usage : null,
  };
}

export async function retainFullE2eInferenceAvailability(
  replyAttempt: number,
  evidence: RetryEvidence,
  writeArtifact: () => Promise<unknown>,
): Promise<void> {
  // Brev retains this log even if the guest artifact write fails.
  console.log("NEMOCLAW_INFERENCE_AVAILABILITY", JSON.stringify({ replyAttempt, ...evidence }));
  await writeArtifact();
}

/** Retry a confirmed unavailable HTTP service or no-response timeout on the stateless probe. */
export async function runFullE2eInferenceCommand<Result extends InferenceCommandResult>(options: {
  run: (attempt: number) => Promise<Result>;
  onEvidence: (evidence: RetryEvidence) => Promise<void> | void;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<Result> {
  const execution = await runBoundedRetry({
    operation: "full-e2e.inference-local.arithmetic",
    owner: "full-e2e",
    idempotence: "read-only",
    maxAttempts: 2,
    run: options.run,
    classify: (result) => {
      if (result?.exitCode === 0) return { outcome: "passed" };
      const httpStatus =
        result?.exitCode === 22 && result.stdout.trim() === ""
          ? /^curl: \(22\) The requested URL returned error: ([0-9]{3})$/.exec(
              result.stderr.trim(),
            )?.[1]
          : undefined;
      const unavailable =
        httpStatus !== undefined && RETRIABLE_HTTP_PROBE_STATUSES.has(Number(httpStatus));
      const timedOutWithoutResponse =
        result?.exitCode === 28 &&
        result.stdout.trim() === "" &&
        /^curl: \(28\) Operation timed out after \d+ milliseconds with 0 bytes received$/.test(
          result.stderr.trim(),
        );
      return {
        outcome: "failed",
        failureClass:
          unavailable || timedOutWithoutResponse ? "transient-external" : "deterministic",
      };
    },
    delayMs: 5_000,
    sleep: options.sleep,
    onEvidence: options.onEvidence,
  });
  // The callback returns a command result; runBoundedRetry throws if it rejects.
  return execution.value!;
}

export async function runFullE2eInferenceProbe<Result extends InferenceCommandResult>(
  model: string,
  execute: (input: FullE2eInferenceAttemptInput) => Promise<Result>,
): Promise<FullE2eInferenceProbeResult<Result>> {
  const attempts: FullE2eInferenceAttempt<Result>[] = [];

  for (const [index, maxTokens] of FULL_E2E_INFERENCE_REPLY_BUDGETS.entries()) {
    const attempt = index + 1;
    const result = await execute({
      artifactName: `phase-4-sandbox-inference-local-attempt-${String(attempt).padStart(2, "0")}`,
      attempt,
      maxTokens,
      requestBody: buildFullE2eInferenceRequest(model, maxTokens),
    });
    if (result.exitCode !== 0) {
      attempts.push({ answerMatched: false, attempt, maxTokens, result });
      return { attempts, outcome: "command-failure" };
    }

    let response: FullE2eInferenceResponseEvidence;
    try {
      response = parseFullE2eInferenceResponse(result.stdout);
    } catch (error) {
      attempts.push({
        answerMatched: false,
        attempt,
        maxTokens,
        parseError: error instanceof Error ? error.message : String(error),
        result,
      });
      return { attempts, outcome: "response-failure" };
    }

    if (!response.answer && response.finishReason !== "length") {
      attempts.push({
        answerMatched: false,
        attempt,
        maxTokens,
        parseError:
          "inference.local response did not contain assistant content or reasoning content",
        response,
        result,
      });
      return { attempts, outcome: "response-failure" };
    }

    const answerMatched = containsAnswer(response.answer, "42");
    attempts.push({ answerMatched, attempt, maxTokens, response, result });
    if (answerMatched) return { attempts, outcome: "passed" };
  }

  return { attempts, outcome: "semantic-mismatch" };
}

export function fullE2eInferenceProbeEvidence<Result extends InferenceCommandResult>(
  probe: FullE2eInferenceProbeResult<Result>,
): Record<string, unknown> {
  const evidence = {
    schemaVersion: "nemoclaw.full_e2e_inference.v1",
    outcome: probe.outcome,
    attempts: probe.attempts.map((attempt) => ({
      answerMatched: attempt.answerMatched,
      attempt: attempt.attempt,
      exitCode: attempt.result.exitCode,
      maxTokens: attempt.maxTokens,
      ...(attempt.parseError
        ? { parseError: limitUtf8(attempt.parseError, EVIDENCE_PARSE_ERROR_LIMIT_BYTES) }
        : {}),
      ...(attempt.response
        ? {
            response: {
              content: limitUtf8(attempt.response.content, EVIDENCE_TEXT_LIMIT_BYTES),
              finish_reason:
                attempt.response.finishReason === null
                  ? null
                  : limitUtf8(attempt.response.finishReason, EVIDENCE_FINISH_REASON_LIMIT_BYTES),
              model:
                attempt.response.model === null
                  ? null
                  : limitUtf8(attempt.response.model, EVIDENCE_MODEL_LIMIT_BYTES),
              reasoning_content: limitUtf8(
                attempt.response.reasoningContent,
                EVIDENCE_TEXT_LIMIT_BYTES,
              ),
              usage: projectUsage(attempt.response.usage),
            },
          }
        : {}),
    })),
  };
  const evidenceBytes = Buffer.byteLength(JSON.stringify(evidence), "utf8");
  if (evidenceBytes > FULL_E2E_INFERENCE_EVIDENCE_LIMIT_BYTES) {
    throw new Error(
      `full E2E inference evidence exceeded ${FULL_E2E_INFERENCE_EVIDENCE_LIMIT_BYTES} bytes after projection`,
    );
  }
  return evidence;
}

/** Preserve full E2E's live ownership check for the selected route family. */
export async function readFullE2eInferenceRoute(input: {
  sandbox: SandboxClient;
  sandboxName: string;
  entry: SandboxEntry | null;
  logicalProvider: string;
  model: string;
  timeoutMs?: number;
  env: NodeJS.ProcessEnv;
  redactionValues: string[];
}): Promise<{ ok: boolean; detail: string }> {
  const gateway = input.entry?.gatewayName || input.env.OPENSHELL_GATEWAY || "nemoclaw";
  const local = normalizeNativeLocalProviderAttachment(input.entry?.nativeLocalProviderAttachment);
  if (
    input.entry?.nativeLocalProviderAttachment &&
    (!local ||
      local.sandboxName !== input.sandboxName ||
      local.gatewayName !== gateway ||
      local.agent !== "openclaw" ||
      local.provider !== input.logicalProvider ||
      local.credentialEnv !== NATIVE_LOCAL_CREDENTIAL_ENV)
  )
    return { ok: false, detail: "Invalid local native ownership" };
  const hosted = input.entry?.nativeHostedProviderAttachment;
  const receipt = local ?? (hosted?.custom ? hosted : undefined);
  if (receipt) {
    const definition = local ?? (hosted && hostedNativeProviderForAttachment(hosted));
    if (!definition) return { ok: false, detail: "Invalid custom native ownership" };
    const options = {
      env: input.env,
      redactionValues: input.redactionValues,
      timeoutMs: input.timeoutMs ?? 60_000,
      captureLimitBytes: 16 * 1024,
    };
    const provider = await input.sandbox.openshell(
      ["provider", "get", "-g", gateway, receipt.providerName],
      { ...options, artifactName: "phase-3-native-custom-provider-metadata" },
    );
    const attachments = await input.sandbox.openshell(
      ["sandbox", "provider", "list", "-g", gateway, input.sandboxName],
      { ...options, artifactName: "phase-3-native-custom-provider-attachment" },
    );
    const metadata =
      provider.exitCode === 0 ? parseCliOpenShellProviderMetadata(provider.stdout) : null;
    const route = getSandboxInferenceConfig(
      input.model,
      input.logicalProvider,
      local ? (local.api ?? "openai-completions") : hosted?.custom?.api,
      true,
      receipt.endpointUrl,
      "openclaw",
    );
    // Inspect the selected agent's real configuration inside the sandbox.
    // Keep credential references out of retained command output.
    const agent = await input.sandbox.exec(
      input.sandboxName,
      [
        "node",
        "-e",
        [
          'const config = JSON.parse(require("node:fs").readFileSync("/sandbox/.openclaw/openclaw.json", "utf8"));',
          'const assert = require("node:assert/strict");',
          "const expected = JSON.parse(process.argv[1]);",
          "const provider = config.models?.providers?.[expected.providerKey];",
          'assert.equal(config.agents?.defaults?.model?.primary, expected.primaryModelRef, "selected model mismatch");',
          'assert.equal(provider?.baseUrl, expected.endpoint, "selected endpoint mismatch");',
          'assert.equal(provider?.api, expected.api, "selected API mismatch");',
          'assert.ok(provider?.models?.some(model => model.id === expected.model), "selected model is absent");',
          "const handle = process.env[expected.credentialEnv];",
          'assert.ok(new RegExp("^openshell:resolve:env:(?:v[0-9]{1,20}|s[a-f0-9]{64})_" + expected.credentialEnv + "$").test(handle ?? "") && provider?.apiKey === handle, "selected credential reference mismatch");',
          'process.stdout.write("selected agent route verified");',
        ].join(" "),
        JSON.stringify({
          providerKey: route.providerKey,
          primaryModelRef: route.primaryModelRef,
          endpoint: route.inferenceBaseUrl,
          api: route.inferenceApi,
          model: input.model,
          credentialEnv: definition.credentialEnv,
        }),
      ],
      { ...options, artifactName: "phase-3-native-custom-agent-route" },
    );
    const ok =
      metadata?.name === receipt.providerName &&
      metadata.type === receipt.profileId &&
      metadata.revision?.id === receipt.providerId &&
      metadata.configKeys.length === 0 &&
      metadata.credentialKeys.length === 1 &&
      metadata.credentialKeys[0] === definition.credentialEnv &&
      attachments.exitCode === 0 &&
      attachments.stdout.split(/\s+/u).includes(receipt.providerName) &&
      agent.exitCode === 0 &&
      agent.stdout === "selected agent route verified";
    return {
      ok,
      detail: `${local ? "Local" : "Custom"} native provider ownership, attachment and selected agent route: ${ok ? "verified" : "mismatch"}`,
    };
  }
  const native = await readPublicNvidiaSwitchAttachmentEvidence({
    artifactName: "phase-3-native-nvidia-provider-attachment",
    env: input.env,
    logicalProvider: input.logicalProvider,
    receipt: input.entry?.nativeNvidiaProviderAttachment,
    sandbox: input.sandbox,
    sandboxName: input.sandboxName,
  });
  if (native !== null)
    return { ok: native === PUBLIC_NVIDIA_SWITCH_ATTACHMENT_EVIDENCE, detail: native };
  const route = await input.sandbox.openshell(["inference", "get"], {
    artifactName: "phase-3-openshell-inference-get",
    env: input.env,
    timeoutMs: input.timeoutMs ?? 60_000,
  });
  return { ok: route.exitCode === 0 && route.stdout.includes(input.model), detail: route.stdout };
}
