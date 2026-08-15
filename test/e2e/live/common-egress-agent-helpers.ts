// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Pure parsing/classification helpers shared by the common-egress-agent live
// E2E target and its PR-collected unit tests. Extracting them lets the fast
// e2e-support project verify the OpenClaw JSON framing, Hermes response parsing,
// expected-token matching, and pre-contract provider-validation skip
// classification without gating on NEMOCLAW_RUN_LIVE_E2E=1.

import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  runBoundedRetry,
  type BoundedRetryResult,
  type RetryEvidence,
  type RetryFailureClass,
} from "../fixtures/retry-policy.ts";
import { isTransientProviderValidationFailure } from "./network-policy-transient-provider.ts";

export const COMMON_EGRESS_TEST_TIMEOUT_MS = 40 * 60_000;

interface AgentJsonDoc {
  payloads?: Array<{ text?: unknown }>;
  result?: { payloads?: Array<{ text?: unknown }> };
}

interface ChatCompletionLike {
  choices?: Array<{
    message?: {
      content?: unknown;
      reasoning_content?: unknown;
    };
    text?: unknown;
  }>;
}

export interface CommonEgressProviderValidationSkip {
  http429ProviderValidationFailure: boolean;
  matches: boolean;
  sanitizedEndpointValidationFailure: boolean;
  transientProviderValidationFailure: boolean;
}

export interface AgentAssertionAttempt {
  failureClass?: RetryFailureClass;
  passed: boolean;
  recoveryRequired?: boolean;
}

interface OpenClawAgentAssertionResult {
  exitCode: number | null;
  expected: string;
  reply: string;
  response: string;
}

interface HermesAgentAssertionResult extends OpenClawAgentAssertionResult {
  httpStatus: string;
}

interface AgentAssertionRetryOptions {
  attempts: number;
  delayMs: (attempt: number) => number;
  onEvidence: (evidence: RetryEvidence) => Promise<void> | void;
  run: (attempt: number) => Promise<AgentAssertionAttempt>;
  sleep?: (milliseconds: number) => Promise<void>;
}

export function runHermesAgentAssertionRetry(
  options: AgentAssertionRetryOptions,
): Promise<BoundedRetryResult<AgentAssertionAttempt>> {
  return runBoundedRetry({
    operation: "common-egress.hermes-agent",
    owner: "hermes-agent",
    idempotence: "read-only",
    maxAttempts: options.attempts,
    delayMs: options.delayMs,
    onEvidence: options.onEvidence,
    run: options.run,
    sleep: options.sleep,
    classify: (value, error) => {
      if (error !== undefined) return { outcome: "failed", failureClass: "deterministic" };
      if (value?.passed) return { outcome: "passed" };
      return { outcome: "failed", failureClass: value?.failureClass ?? "deterministic" };
    },
  });
}

export function runOpenClawAgentAssertionRetry(
  options: AgentAssertionRetryOptions & {
    recover: (attempt: AgentAssertionAttempt, attemptNumber: number) => Promise<boolean>;
  },
): Promise<BoundedRetryResult<AgentAssertionAttempt>> {
  return runBoundedRetry({
    operation: "common-egress.openclaw-agent",
    owner: "openclaw-agent",
    idempotence: "reconciled-mutation",
    maxAttempts: options.attempts,
    delayMs: options.delayMs,
    onEvidence: options.onEvidence,
    run: options.run,
    reconcile: async (attempt, _error, attemptNumber) => {
      if (!attempt?.recoveryRequired) return false;
      try {
        return await options.recover(attempt, attemptNumber);
      } catch {
        return false;
      }
    },
    sleep: options.sleep,
    classify: (value, error) => {
      if (error !== undefined) return { outcome: "failed", failureClass: "deterministic" };
      if (value?.passed) return { outcome: "passed" };
      return { outcome: "failed", failureClass: value?.failureClass ?? "deterministic" };
    },
  });
}

export function text(result: Pick<ShellProbeResult, "stdout" | "stderr">): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function parseAgentJsonDocs(raw: string): AgentJsonDoc[] {
  try {
    const parsed = JSON.parse(raw) as AgentJsonDoc | AgentJsonDoc[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Invalid state: `openclaw agent --json` has emitted both single JSON
    // documents and log-prefixed streams across versions. Source boundary:
    // OpenClaw CLI stdout framing inside the sandbox, outside this NemoClaw
    // migration. Source-fix constraint: keep this test local and legacy-script
    // compatible instead of rewriting shared fixtures or patching OpenClaw from
    // a migration PR. Removal condition: supported OpenClaw versions guarantee
    // a strict single JSON document with payload text on stdout.
  }

  const docs: AgentJsonDoc[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== "{") continue;
    for (let end = index + 1; end <= raw.length; end += 1) {
      try {
        const parsed = JSON.parse(raw.slice(index, end)) as AgentJsonDoc | AgentJsonDoc[];
        docs.push(...(Array.isArray(parsed) ? parsed : [parsed]));
        index = end - 1;
        break;
      } catch {
        // Keep extending the candidate slice until it becomes valid JSON.
      }
    }
  }
  return docs;
}

export function parseOpenClawAgentText(raw: string): string {
  return parseAgentJsonDocs(raw)
    .flatMap((doc) => doc.payloads ?? doc.result?.payloads ?? [])
    .map((payload) => payload.text)
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .trim();
}

export function parseChatContent(raw: string): string {
  const doc = JSON.parse(raw) as ChatCompletionLike;
  const choice = doc.choices?.[0];
  const content = choice?.message?.content ?? choice?.message?.reasoning_content ?? choice?.text;
  return typeof content === "string" ? content.trim() : "";
}

function compactAgentReply(value: string): string {
  return value.replace(/\s+/gu, "");
}

const AUTHENTICATION_AGENT_FAILURE_RE =
  /authentication failed|unauthorized|HTTP 401\b|\b401\b|invalid (?:credential|api[_ -]?key)/iu;
const AUTHORIZATION_AGENT_FAILURE_RE = /authorization failed|forbidden|HTTP 403\b|\b403\b/iu;
const POLICY_AGENT_FAILURE_RE =
  /SsrFBlockedError|Blocked hostname|denied by network policy|network policy denied|policy (?:update |validation )?failed/iu;
const MALFORMED_AGENT_FAILURE_RE = /malformed|invalid request/iu;
const TERMINAL_PROVIDER_VALIDATION_RE =
  /invalid.*(api[_ -]?key|credential|configuration|request|json)|authentication failed|authorization failed|unauthorized|forbidden|HTTP 40[13]\b|\b40[13]\b|denied by network policy|network policy denied|policy .*failed|routing .*failed|route .*failed|proxy .*failed|hop-by-hop|header stripping|malformed/iu;
const TRANSIENT_AGENT_FAILURE_RE =
  /ECONNREFUSED|EAI_AGAIN|ECONNRESET|ETIMEDOUT|gateway unavailable|network connection error|DNS error|fetch failed|LLM request timed out|FailoverError|inference service unavailable|rawError=503/iu;

function isOpenClawPolicyBlock(output: string): boolean {
  return POLICY_AGENT_FAILURE_RE.test(output);
}

function isOpenClawScopeUpgradePending(output: string): boolean {
  return /scope upgrade pending approval|pairing required: device is asking for more scopes/i.test(
    output,
  );
}

function isOpenClawTransientAgentError(output: string): boolean {
  return (
    !AUTHENTICATION_AGENT_FAILURE_RE.test(output) &&
    !AUTHORIZATION_AGENT_FAILURE_RE.test(output) &&
    !POLICY_AGENT_FAILURE_RE.test(output) &&
    !MALFORMED_AGENT_FAILURE_RE.test(output) &&
    TRANSIENT_AGENT_FAILURE_RE.test(output)
  );
}

export function agentReplyContainsToken(reply: string, expected: string): boolean {
  const compactExpected = compactAgentReply(expected);
  return compactExpected.length > 0 && compactAgentReply(reply).includes(compactExpected);
}

export function classifyOpenClawAgentAssertion(
  result: OpenClawAgentAssertionResult,
): AgentAssertionAttempt {
  if (result.exitCode === 0 && agentReplyContainsToken(result.reply, result.expected)) {
    return { passed: true };
  }
  if (isOpenClawPolicyBlock(result.response)) {
    return { passed: false, failureClass: "policy-denial" };
  }
  if (AUTHENTICATION_AGENT_FAILURE_RE.test(result.response)) {
    return { passed: false, failureClass: "authentication" };
  }
  if (AUTHORIZATION_AGENT_FAILURE_RE.test(result.response)) {
    return { passed: false, failureClass: "authorization" };
  }
  if (MALFORMED_AGENT_FAILURE_RE.test(result.response)) {
    return { passed: false, failureClass: "malformed-input" };
  }
  const recoveryRequired = isOpenClawScopeUpgradePending(result.response);
  return {
    passed: false,
    failureClass:
      recoveryRequired || (result.exitCode !== 0 && isOpenClawTransientAgentError(result.response))
        ? "transient-external"
        : "deterministic",
    recoveryRequired,
  };
}

export function classifyHermesAgentAssertion(
  result: HermesAgentAssertionResult,
): AgentAssertionAttempt {
  if (
    result.exitCode === 0 &&
    result.httpStatus === "200" &&
    agentReplyContainsToken(result.reply, result.expected)
  ) {
    return { passed: true };
  }
  if (result.httpStatus === "401") {
    return { passed: false, failureClass: "authentication" };
  }
  if (result.httpStatus === "403") {
    return { passed: false, failureClass: "authorization" };
  }
  if (AUTHENTICATION_AGENT_FAILURE_RE.test(result.response)) {
    return { passed: false, failureClass: "authentication" };
  }
  if (AUTHORIZATION_AGENT_FAILURE_RE.test(result.response)) {
    return { passed: false, failureClass: "authorization" };
  }
  if (POLICY_AGENT_FAILURE_RE.test(result.response)) {
    return { passed: false, failureClass: "policy-denial" };
  }
  if (MALFORMED_AGENT_FAILURE_RE.test(result.response)) {
    return { passed: false, failureClass: "malformed-input" };
  }
  return {
    passed: false,
    failureClass: isHermesTransientAgentFailure(result.httpStatus, result.response)
      ? "transient-external"
      : "deterministic",
  };
}

/** Recognize transport/provider failures without retrying a successful product response. */
export function isHermesTransientAgentFailure(httpStatus: string, output: string): boolean {
  if (
    httpStatus === "200" ||
    /^(401|403)$/u.test(httpStatus) ||
    AUTHENTICATION_AGENT_FAILURE_RE.test(output) ||
    AUTHORIZATION_AGENT_FAILURE_RE.test(output) ||
    POLICY_AGENT_FAILURE_RE.test(output) ||
    MALFORMED_AGENT_FAILURE_RE.test(output)
  ) {
    return false;
  }
  if (/^(408|429|5[0-9]{2})$/u.test(httpStatus)) return true;
  const hasNoResponseStatus = httpStatus === "" || httpStatus === "000";
  return hasNoResponseStatus && TRANSIENT_AGENT_FAILURE_RE.test(output);
}

export function classifyPreContractProviderValidationSkip(
  result: Pick<ShellProbeResult, "stdout" | "stderr">,
): CommonEgressProviderValidationSkip {
  const output = text(result);
  const providerValidation =
    /endpoint validation failed|failed to verify inference endpoint|Chat Completions API validation/i.test(
      output,
    );
  const terminalProviderValidationFailure = TERMINAL_PROVIDER_VALIDATION_RE.test(output);
  const transientProviderValidationFailure =
    !terminalProviderValidationFailure && isTransientProviderValidationFailure(result);
  const http429ProviderValidationFailure =
    providerValidation &&
    !terminalProviderValidationFailure &&
    /HTTP\s*429|\b429\b|rate[- ]?limit|too many requests/i.test(output);
  const sanitizedEndpointValidationFailure =
    providerValidation &&
    !terminalProviderValidationFailure &&
    /Validation details were omitted to avoid exposing credentials/i.test(output) &&
    process.env.GITHUB_ACTIONS === "true";

  return {
    http429ProviderValidationFailure,
    matches:
      transientProviderValidationFailure ||
      http429ProviderValidationFailure ||
      sanitizedEndpointValidationFailure,
    sanitizedEndpointValidationFailure,
    transientProviderValidationFailure,
  };
}
