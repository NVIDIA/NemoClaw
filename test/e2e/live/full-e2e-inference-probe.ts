// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveMaxTokensField } from "../../../src/lib/inference/max-tokens-field.ts";
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
