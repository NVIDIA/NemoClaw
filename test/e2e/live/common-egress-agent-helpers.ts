// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Pure parsing/classification helpers shared by the common-egress-agent live
// E2E target and its PR-collected unit tests. Extracting them lets the fast
// e2e-support project verify the OpenClaw JSON framing, Hermes response parsing,
// expected-token matching, and pre-contract provider-validation skip
// classification without gating on NEMOCLAW_RUN_LIVE_E2E=1.

import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
export { parseOpenClawAgentText } from "../fixtures/openclaw-agent-output.ts";
import {
  runBoundedRetry,
  type BoundedRetryResult,
  type RetryEvidence,
  type RetryFailureClass,
} from "../fixtures/retry-policy.ts";
import { isTransientProviderValidationFailure } from "./network-policy-transient-provider.ts";

export const COMMON_EGRESS_TEST_TIMEOUT_MS = 40 * 60_000;

interface ChatCompletionLike {
  choices?: Array<{
    message?: {
      content?: unknown;
      reasoning_content?: unknown;
    };
    text?: unknown;
  }>;
}

export interface OpenClawToolTarget {
  hostname: string;
  protocol: "http:" | "https:";
}

export interface OpenClawToolRecord {
  name: string;
  target?: OpenClawToolTarget;
}

export interface OpenClawWebFetchResultEvidence {
  expectedContentMatches: boolean;
  expectedUrlMatches: boolean;
  httpSuccess: boolean;
  maxCharsWithinLimit: boolean;
  paired: boolean;
  resultSuccess: boolean;
  target?: OpenClawToolTarget;
}

export interface OpenClawPublicFetchExpectation {
  content: string;
  url: string;
}

export interface OpenClawToolEvidence {
  schemaVersion: 1;
  controlTargetViolations: number;
  errors: string[];
  finalStatuses: string[];
  projectedTargetEvidence: boolean;
  providerMentions: string[];
  toolCalls: OpenClawToolRecord[];
  toolExecutions: OpenClawToolRecord[];
  toolResults: OpenClawToolRecord[];
  unexpectedWebFetchCalls: number;
  unexpectedWebFetchExecutions: number;
  unexpectedWebFetchResults: number;
  webFetchResults: OpenClawWebFetchResultEvidence[];
}

export interface PersonalPublicFetchToolEvidenceAssessment {
  controlTargetViolations: number;
  forbiddenProviderMentions: string[];
  forbiddenToolNames: string[];
  matches: boolean;
  projectedTargetEvidence: boolean;
  publicHttpsTargets: OpenClawToolTarget[];
  qualifyingWebFetchResults: number;
  unexpectedWebFetchCalls: number;
  unexpectedWebFetchExecutions: number;
  unexpectedWebFetchResults: number;
  webFetchCalls: number;
  webFetchExecutions: number;
}

export interface PersonalPublicFetchToolEvidenceArtifact {
  schemaVersion: 1;
  controlTargetViolations: number;
  errorCount: number;
  finalStatusCount: number;
  finalSuccess: boolean;
  forbiddenProviderMentionCount: number;
  forbiddenToolCount: number;
  matches: boolean;
  projectedTargetEvidence: boolean;
  publicHttpsTargets: OpenClawToolTarget[];
  qualifyingWebFetchResults: number;
  unexpectedWebFetchCalls: number;
  unexpectedWebFetchExecutions: number;
  unexpectedWebFetchResults: number;
  webFetchCalls: number;
  webFetchExecutions: number;
  webFetchResultCounts: {
    expectedContentMatches: number;
    expectedUrlMatches: number;
    httpSuccess: number;
    maxCharsWithinLimit: number;
    paired: number;
    publicHttpsTarget: number;
    resultSuccess: number;
    total: number;
  };
  webFetchResultsWithinMaxChars: number;
}

export interface OpenClawToolEvidenceReductionFailureArtifact {
  schemaVersion: 1;
  failureClass: "command-failed" | "output-invalid";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export interface OpenClawAgentFailureArtifact {
  schemaVersion: 1;
  attempt: number;
  diagnosticSummary:
    | "command-exited-nonzero"
    | "command-signaled"
    | "command-timed-out"
    | "expected-reply-missing";
  exitCode: number | null;
  failureClass: RetryFailureClass;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
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

export interface OpenClawAgentAttemptEvidenceOptions {
  classification: AgentAssertionAttempt;
  label: string;
  recordToolEvidenceReductionFailure: (
    evidence: OpenClawToolEvidenceReductionFailureArtifact,
  ) => Promise<void>;
  recordToolEvidence: (evidence: OpenClawToolEvidence) => Promise<void>;
  reduceToolEvidence: () => Promise<
    Pick<ShellProbeResult, "exitCode" | "stdout"> &
      Partial<Pick<ShellProbeResult, "signal" | "timedOut">>
  >;
  reply: string;
  toolEvidenceValidator?: (evidence: OpenClawToolEvidence) => boolean;
}

export interface OpenClawAgentAttemptEvidenceResult {
  attempt: AgentAssertionAttempt;
  evidence?: { reply: string; toolEvidence?: OpenClawToolEvidence };
  failure?: string;
}

export function projectOpenClawAgentFailureArtifact(
  attempt: number,
  classification: AgentAssertionAttempt,
  result: Pick<ShellProbeResult, "exitCode" | "signal" | "stderr" | "stdout" | "timedOut">,
): OpenClawAgentFailureArtifact {
  const diagnosticSummary = result.timedOut
    ? "command-timed-out"
    : result.signal
      ? "command-signaled"
      : result.exitCode !== 0
        ? "command-exited-nonzero"
        : "expected-reply-missing";
  return {
    schemaVersion: 1,
    attempt,
    diagnosticSummary,
    exitCode: result.exitCode,
    failureClass: classification.failureClass ?? "deterministic",
    signal: result.signal,
    timedOut: result.timedOut,
  };
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

/**
 * Reduce OpenClaw session and trajectory JSONL to bounded proof that one
 * successful paired web_fetch result supports the expected public fetch.
 * Fetched content and complete URLs remain inside the sandbox. The function
 * is self-contained because the live test serializes it instead of copying
 * full traces into host artifacts.
 */
export function reduceOpenClawToolEvidence(
  sessionJsonLines: string,
  trajectoryJsonLines: string,
  expectedFetch: OpenClawPublicFetchExpectation | null = null,
): OpenClawToolEvidence {
  const MAX_ERRORS = 32;
  const MAX_RECORDS = 64;
  const errors: string[] = [];
  const addError = (message: string): void => {
    if (errors.length < MAX_ERRORS && !errors.includes(message)) errors.push(message);
  };
  const parseJsonLines = (raw: string, label: string): unknown[] => {
    const documents: unknown[] = [];
    for (const [index, line] of raw.split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      try {
        documents.push(JSON.parse(line));
      } catch {
        addError(`${label} line ${index + 1} is not JSON`);
      }
    }
    return documents;
  };
  const asRecord = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const normalizedName = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    return normalized && normalized.length <= 128 ? normalized : null;
  };
  const normalizedId = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const normalized = value.trim();
    return normalized && normalized.length <= 256 ? normalized : null;
  };
  const directUrlFrom = (value: unknown): string | null => {
    const record = asRecord(value);
    return typeof value === "string"
      ? (value.match(/https?:\/\/[^\s'"<>]+/iu)?.[0] ?? null)
      : ([record?.url, record?.href, record?.uri].find(
          (candidate): candidate is string => typeof candidate === "string",
        ) ?? null);
  };
  const maxCharsWithinLimitFrom = (value: unknown): boolean => {
    const record = asRecord(value);
    const candidate = record?.maxChars ?? record?.max_chars;
    return (
      typeof candidate === "number" &&
      Number.isInteger(candidate) &&
      candidate >= 1 &&
      candidate <= 8_000
    );
  };
  const isAllowedWebFetchControlTarget = (value: unknown): boolean => {
    const record = asRecord(value);
    const identifier = normalizedName(record?.id);
    return identifier === "web_fetch" || identifier === "openclaw:core:web_fetch";
  };
  const sanitizeToolCallIdPart = (value: string): string =>
    value
      .trim()
      .replace(/[^A-Za-z0-9_.:-]+/gu, "_")
      .slice(0, 120) || "call";
  const normalizedUrl = (value: unknown): string | null => {
    if (typeof value !== "string" || value.length > 4096) return null;
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      parsed.hash = "";
      return parsed.href;
    } catch {
      return null;
    }
  };
  const targetFrom = (value: unknown): OpenClawToolTarget | undefined => {
    const direct = directUrlFrom(value);
    if (!direct) return undefined;
    try {
      const parsed = new URL(direct);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
      return {
        hostname: parsed.hostname.toLowerCase(),
        protocol: parsed.protocol,
      };
    } catch {
      addError("tool target is not a valid HTTP URL");
      return undefined;
    }
  };
  const providerMentions = new Set<string>();
  const collectProviderMentions = (value: unknown, depth = 0): void => {
    if (depth > 3) return;
    if (Array.isArray(value)) {
      for (const candidate of value) collectProviderMentions(candidate, depth + 1);
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    for (const [key, candidate] of Object.entries(record)) {
      if (
        typeof candidate === "string" &&
        /^(?:provider|searchProvider|search_provider|engine)$/u.test(key) &&
        candidate.trim()
      ) {
        if (providerMentions.size < MAX_RECORDS) {
          providerMentions.add(candidate.trim().toLowerCase().slice(0, 128));
        } else {
          addError("provider mention limit exceeded");
        }
      } else if (candidate !== null && typeof candidate === "object") {
        collectProviderMentions(candidate, depth + 1);
      }
    }
  };
  const recordTool = (
    collection: OpenClawToolRecord[],
    value: unknown,
    targetSource: unknown,
  ): void => {
    if (collection.length >= MAX_RECORDS) {
      addError("tool record limit exceeded");
      return;
    }
    const record = asRecord(value);
    const name = normalizedName(record?.name ?? record?.toolName ?? record?.tool_name);
    if (!name) {
      addError("tool record has no bounded name");
      return;
    }
    const target = targetFrom(targetSource);
    collection.push(target ? { name, target } : { name });
    collectProviderMentions(value);
    collectProviderMentions(targetSource);
  };
  const resultPayloadFrom = (message: Record<string, unknown>): Record<string, unknown> | null => {
    const details = asRecord(message.details);
    if (
      details &&
      details.persistedDetailsTruncated !== true &&
      typeof details.url === "string" &&
      typeof details.text === "string"
    ) {
      return details;
    }
    if (!Array.isArray(message.content)) return null;
    for (const blockValue of message.content) {
      const block = asRecord(blockValue);
      if (block?.type !== "text" || typeof block.text !== "string") continue;
      try {
        const parsed = asRecord(JSON.parse(block.text));
        if (parsed) return parsed;
      } catch {
        // Persisted tool text may be truncated. It cannot qualify as proof.
      }
    }
    return null;
  };
  const expectedUrl = normalizedUrl(expectedFetch?.url);
  const expectedContent =
    typeof expectedFetch?.content === "string" &&
    expectedFetch.content.length > 0 &&
    expectedFetch.content.length <= 1_000
      ? expectedFetch.content
      : null;
  const trajectoryDocuments = parseJsonLines(trajectoryJsonLines, "trajectory");
  const projectedMessages: unknown[] = [];
  for (const document of trajectoryDocuments) {
    const root = asRecord(document);
    if (root?.type !== "model.completed") continue;
    const data = asRecord(root.data);
    if (!Array.isArray(data?.messagesSnapshot)) continue;
    projectedMessages.splice(0, projectedMessages.length, ...data.messagesSnapshot);
  }

  const toolCalls: OpenClawToolRecord[] = [];
  const sessionDocuments = parseJsonLines(sessionJsonLines, "session");
  const allowedWrapperIdParts = new Set<string>();
  const controlTargetViolationIds = new Set<string>();
  const sessionCallIds = new Set<string>();
  const sessionToolNames = new Set<string>();
  const unexpectedWebFetchCallIds = new Set<string>();
  let anonymousSessionCallIndex = 0;
  for (const document of sessionDocuments) {
    const root = asRecord(document);
    const message = asRecord(root?.message ?? document);
    collectProviderMentions(message);
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const blockValue of message.content) {
      const block = asRecord(blockValue);
      if (block?.type !== "toolCall") continue;
      const id = normalizedId(block.id ?? block.toolCallId ?? block.tool_call_id);
      const name = normalizedName(block.name ?? block.toolName ?? block.tool_name);
      const argumentsValue = block.arguments ?? block.input ?? block.args;
      if (name) {
        if (sessionToolNames.size < MAX_RECORDS || sessionToolNames.has(name)) {
          sessionToolNames.add(name);
        } else {
          addError("session tool name limit exceeded");
        }
      }
      if (name === "web_fetch" && normalizedUrl(directUrlFrom(argumentsValue)) !== expectedUrl) {
        unexpectedWebFetchCallIds.add(id ?? `session:${anonymousSessionCallIndex}`);
        anonymousSessionCallIndex += 1;
      }
      if (!id) {
        if (name === "tool_call" || name === "tool_describe") {
          addError("control tool call has no bounded id");
        }
        continue;
      }
      sessionCallIds.add(id);
      const allowedControlTarget = isAllowedWebFetchControlTarget(argumentsValue);
      if ((name === "tool_call" || name === "tool_describe") && !allowedControlTarget) {
        controlTargetViolationIds.add(id);
      }
      if (name === "tool_call" && allowedControlTarget) {
        allowedWrapperIdParts.add(sanitizeToolCallIdPart(id));
      }
    }
  }
  const projectedTargetCallIds = new Set<string>();
  for (const document of projectedMessages) {
    const root = asRecord(document);
    const message = asRecord(root?.message ?? document);
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const blockValue of message.content) {
      const block = asRecord(blockValue);
      const id = normalizedId(block?.id ?? block?.toolCallId ?? block?.tool_call_id);
      const name = normalizedName(block?.name ?? block?.toolName ?? block?.tool_name);
      if (block?.type !== "toolCall" || name !== "web_fetch" || !id || sessionCallIds.has(id)) {
        continue;
      }
      const associated = [...allowedWrapperIdParts].some((wrapperIdPart) => {
        const prefix = `tool_search_code:${wrapperIdPart}:web_fetch:`;
        return id.startsWith(prefix) && /^[1-9][0-9]*$/u.test(id.slice(prefix.length));
      });
      if (associated) projectedTargetCallIds.add(id);
    }
  }
  // Progressive Tool Search persists the model-visible control calls in the
  // session, then projects each invoked target tool into the final trajectory
  // snapshot. Prefer the complete projection whenever present so result
  // content remains available before session persistence truncates it. Only a
  // paired web_fetch target whose generated ID binds to an allowed native
  // wrapper grants the control-tool exemption; direct-disclosure sessions
  // remain web_fetch-only.
  const proofMessages = projectedMessages.length > 0 ? projectedMessages : sessionDocuments;
  const callsById = new Map<
    string,
    {
      maxCharsWithinLimit: boolean;
      name: string;
      requestedUrl: string | null;
      target?: OpenClawToolTarget;
    }
  >();
  for (const document of proofMessages) {
    const root = asRecord(document);
    const message = asRecord(root?.message ?? document);
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const blockValue of message.content) {
      const block = asRecord(blockValue);
      if (block?.type !== "toolCall") continue;
      const argumentsValue = block.arguments ?? block.input ?? block.args;
      recordTool(toolCalls, block, argumentsValue);
      const id = normalizedId(block.id ?? block.toolCallId ?? block.tool_call_id);
      const name = normalizedName(block.name ?? block.toolName ?? block.tool_name);
      if (!name) continue;
      if (!id) {
        addError("tool call has no bounded id");
        continue;
      }
      if (
        (name === "tool_call" || name === "tool_describe") &&
        !isAllowedWebFetchControlTarget(argumentsValue)
      ) {
        controlTargetViolationIds.add(id);
      }
      if (callsById.size >= MAX_RECORDS) {
        addError("tool call id limit exceeded");
        continue;
      }
      if (callsById.has(id)) {
        addError("duplicate bounded tool call id");
        continue;
      }
      const directUrl = directUrlFrom(argumentsValue);
      const target = targetFrom(argumentsValue);
      const requestedUrl = normalizedUrl(directUrl);
      if (name === "web_fetch" && requestedUrl !== expectedUrl) {
        unexpectedWebFetchCallIds.add(id);
      }
      callsById.set(id, {
        maxCharsWithinLimit: maxCharsWithinLimitFrom(argumentsValue),
        name,
        requestedUrl,
        ...(target ? { target } : {}),
      });
    }
  }
  for (const name of sessionToolNames) {
    if (toolCalls.some((record) => record.name === name)) continue;
    if (toolCalls.length >= MAX_RECORDS) {
      addError("tool record limit exceeded");
      break;
    }
    toolCalls.push({ name });
  }

  const pairedProjectedTargetCallIds = new Set<string>();
  const toolResults: OpenClawToolRecord[] = [];
  const webFetchResults: OpenClawWebFetchResultEvidence[] = [];
  for (const document of proofMessages) {
    const root = asRecord(document);
    const message = asRecord(root?.message ?? document);
    if (message?.role !== "toolResult") continue;
    recordTool(toolResults, message, message.details);
    const callId = normalizedId(message.toolCallId ?? message.tool_call_id);
    const resultName = normalizedName(message.toolName ?? message.tool_name ?? message.name);
    const call = callId ? callsById.get(callId) : undefined;
    if (resultName !== "web_fetch" && call?.name !== "web_fetch") continue;
    const payload = resultPayloadFrom(message);
    collectProviderMentions(payload);
    const boundedPayloadText =
      typeof payload?.text === "string" ? payload.text.slice(0, 20_000) : "";
    const status = payload?.status;
    const paired = call?.name === "web_fetch" && resultName === "web_fetch";
    if (paired && callId && projectedTargetCallIds.has(callId)) {
      pairedProjectedTargetCallIds.add(callId);
    }
    const httpSuccess =
      typeof status === "number" && Number.isInteger(status) && status >= 200 && status < 300;
    if (webFetchResults.length >= MAX_RECORDS) {
      addError("web fetch result limit exceeded");
      continue;
    }
    webFetchResults.push({
      expectedContentMatches:
        expectedContent !== null && boundedPayloadText.includes(expectedContent),
      expectedUrlMatches:
        expectedUrl !== null &&
        call?.requestedUrl === expectedUrl &&
        normalizedUrl(payload?.url) === expectedUrl &&
        normalizedUrl(payload?.finalUrl) === expectedUrl,
      httpSuccess,
      maxCharsWithinLimit: call?.maxCharsWithinLimit === true,
      paired,
      resultSuccess: paired && message.isError !== true && payload !== null && httpSuccess,
      ...(call?.target ? { target: call.target } : {}),
    });
  }
  const projectedTargetEvidence = pairedProjectedTargetCallIds.size > 0;
  const unexpectedWebFetchResults = webFetchResults.filter(
    ({ expectedUrlMatches }) => !expectedUrlMatches,
  ).length;

  const finalStatuses = new Set<string>();
  const toolExecutions: OpenClawToolRecord[] = [];
  let unexpectedWebFetchExecutions = 0;
  for (const document of trajectoryDocuments) {
    const root = asRecord(document);
    if (root?.type !== "trace.artifacts") continue;
    const data = asRecord(root.data);
    if (typeof data?.finalStatus === "string" && data.finalStatus.trim()) {
      if (finalStatuses.size < MAX_RECORDS) {
        finalStatuses.add(data.finalStatus.trim().toLowerCase().slice(0, 128));
      } else {
        addError("final status limit exceeded");
      }
    }
    if (!Array.isArray(data?.toolMetas)) continue;
    for (const metaValue of data.toolMetas) {
      const meta = asRecord(metaValue);
      const targetSource = meta?.meta ?? meta;
      const name = normalizedName(meta?.name ?? meta?.toolName ?? meta?.tool_name);
      if (name === "web_fetch" && normalizedUrl(directUrlFrom(targetSource)) !== expectedUrl) {
        unexpectedWebFetchExecutions += 1;
      }
      recordTool(toolExecutions, meta, targetSource);
    }
  }

  return {
    schemaVersion: 1,
    controlTargetViolations: controlTargetViolationIds.size,
    errors,
    finalStatuses: [...finalStatuses].sort(),
    projectedTargetEvidence,
    providerMentions: [...providerMentions].sort(),
    toolCalls,
    toolExecutions,
    toolResults,
    unexpectedWebFetchCalls: unexpectedWebFetchCallIds.size,
    unexpectedWebFetchExecutions,
    unexpectedWebFetchResults,
    webFetchResults,
  };
}

export const OPENCLAW_TOOL_EVIDENCE_MARKER = "__NEMOCLAW_TOOL_EVIDENCE__=";

export function buildOpenClawToolEvidenceReducerScript(
  expectedFetch: OpenClawPublicFetchExpectation | null = null,
): string {
  return [
    '"use strict"',
    'const fs = require("node:fs")',
    `const reduce = ${reduceOpenClawToolEvidence.toString()}`,
    `const expectedFetch = ${JSON.stringify(expectedFetch)}`,
    "const [sessionPath, trajectoryPath] = process.argv.slice(1)",
    "const readErrors = []",
    'const read = (filePath, label) => { try { return fs.readFileSync(filePath, "utf8"); } catch (error) { readErrors.push(label + " read failed: " + String(error && error.code || "unknown")); return ""; } }',
    'const evidence = reduce(read(sessionPath, "session"), read(trajectoryPath, "trajectory"), expectedFetch)',
    "evidence.errors.unshift(...readErrors)",
    `process.stdout.write(${JSON.stringify(OPENCLAW_TOOL_EVIDENCE_MARKER)} + JSON.stringify(evidence) + "\\n")`,
  ].join("; ");
}

export function parseOpenClawToolEvidence(raw: string): OpenClawToolEvidence {
  const line = raw
    .split(/\r?\n/u)
    .filter((candidate) => candidate.startsWith(OPENCLAW_TOOL_EVIDENCE_MARKER))
    .at(-1);
  if (!line) throw new Error("OpenClaw reduced tool evidence marker is missing");
  const parsed = JSON.parse(
    line.slice(OPENCLAW_TOOL_EVIDENCE_MARKER.length),
  ) as Partial<OpenClawToolEvidence>;
  if (
    parsed.schemaVersion !== 1 ||
    !Number.isInteger(parsed.controlTargetViolations) ||
    !Array.isArray(parsed.errors) ||
    !Array.isArray(parsed.finalStatuses) ||
    typeof parsed.projectedTargetEvidence !== "boolean" ||
    !Array.isArray(parsed.providerMentions) ||
    !Array.isArray(parsed.toolCalls) ||
    !Array.isArray(parsed.toolExecutions) ||
    !Array.isArray(parsed.toolResults) ||
    !Number.isInteger(parsed.unexpectedWebFetchCalls) ||
    !Number.isInteger(parsed.unexpectedWebFetchExecutions) ||
    !Number.isInteger(parsed.unexpectedWebFetchResults) ||
    !Array.isArray(parsed.webFetchResults)
  ) {
    throw new Error("OpenClaw reduced tool evidence has an invalid schema");
  }
  return parsed as OpenClawToolEvidence;
}

function isPublicHttpsTarget(target: OpenClawToolTarget | undefined): target is OpenClawToolTarget {
  if (!target || target.protocol !== "https:") return false;
  const hostname = target.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  const isPublicIpv4 = (octets: number[]): boolean => {
    if (
      octets.length !== 4 ||
      octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
    ) {
      return false;
    }
    const [first = 0, second = 0, third = 0] = octets;
    return !(
      first === 0 ||
      first === 10 ||
      first === 127 ||
      first >= 224 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 0 && third === 0) ||
      (first === 192 && second === 0 && third === 2) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      (first === 198 && second === 51 && third === 100) ||
      (first === 203 && second === 0 && third === 113)
    );
  };
  const mappedIpv4 = hostname.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u);
  if (mappedIpv4) {
    const high = Number.parseInt(mappedIpv4[1] ?? "", 16);
    const low = Number.parseInt(mappedIpv4[2] ?? "", 16);
    return isPublicIpv4([high >>> 8, high & 0xff, low >>> 8, low & 0xff]);
  }
  const isIpv6 = hostname.includes(":");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "::1" ||
    hostname === "::" ||
    (isIpv6 &&
      (hostname.startsWith("fc") ||
        hostname.startsWith("fd") ||
        hostname.startsWith("fe8") ||
        hostname.startsWith("fe9") ||
        hostname.startsWith("fea") ||
        hostname.startsWith("feb") ||
        hostname.startsWith("ff")))
  ) {
    return false;
  }
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname)) return true;
  return isPublicIpv4(hostname.split(".").map(Number));
}

export function assessPersonalPublicFetchToolEvidence(
  evidence: OpenClawToolEvidence,
): PersonalPublicFetchToolEvidenceAssessment {
  const allRecords = [...evidence.toolCalls, ...evidence.toolExecutions, ...evidence.toolResults];
  const allowedToolNames = new Set(
    evidence.projectedTargetEvidence
      ? ["web_fetch", "tool_search", "tool_describe", "tool_call"]
      : ["web_fetch"],
  );
  const forbiddenToolNames = [
    ...new Set(allRecords.map(({ name }) => name).filter((name) => !allowedToolNames.has(name))),
  ].sort();
  const forbiddenProviderMentions = evidence.providerMentions.filter((name) =>
    ["brave", "tavily"].includes(name),
  );
  const webFetchCalls = evidence.toolCalls.filter(({ name }) => name === "web_fetch");
  const webFetchExecutions = evidence.toolExecutions.filter(({ name }) => name === "web_fetch");
  const publicHttpsTargets = webFetchCalls.map(({ target }) => target).filter(isPublicHttpsTarget);
  const qualifyingWebFetchResults = evidence.webFetchResults.filter(
    (result) =>
      result.expectedContentMatches &&
      result.expectedUrlMatches &&
      result.httpSuccess &&
      result.maxCharsWithinLimit &&
      result.paired &&
      result.resultSuccess &&
      isPublicHttpsTarget(result.target),
  );
  return {
    controlTargetViolations: evidence.controlTargetViolations,
    forbiddenProviderMentions,
    forbiddenToolNames,
    matches:
      evidence.errors.length === 0 &&
      evidence.controlTargetViolations === 0 &&
      evidence.finalStatuses.length === 1 &&
      evidence.finalStatuses[0] === "success" &&
      evidence.unexpectedWebFetchCalls === 0 &&
      evidence.unexpectedWebFetchExecutions === 0 &&
      evidence.unexpectedWebFetchResults === 0 &&
      webFetchCalls.length > 0 &&
      webFetchExecutions.length > 0 &&
      publicHttpsTargets.length > 0 &&
      qualifyingWebFetchResults.length > 0 &&
      forbiddenToolNames.length === 0 &&
      forbiddenProviderMentions.length === 0,
    projectedTargetEvidence: evidence.projectedTargetEvidence,
    publicHttpsTargets,
    qualifyingWebFetchResults: qualifyingWebFetchResults.length,
    unexpectedWebFetchCalls: evidence.unexpectedWebFetchCalls,
    unexpectedWebFetchExecutions: evidence.unexpectedWebFetchExecutions,
    unexpectedWebFetchResults: evidence.unexpectedWebFetchResults,
    webFetchCalls: webFetchCalls.length,
    webFetchExecutions: webFetchExecutions.length,
  };
}

export function projectPersonalPublicFetchToolEvidenceArtifact(
  evidence: OpenClawToolEvidence,
): PersonalPublicFetchToolEvidenceArtifact {
  const assessment = assessPersonalPublicFetchToolEvidence(evidence);
  const webFetchResultCounts = {
    expectedContentMatches: evidence.webFetchResults.filter(
      ({ expectedContentMatches }) => expectedContentMatches,
    ).length,
    expectedUrlMatches: evidence.webFetchResults.filter(
      ({ expectedUrlMatches }) => expectedUrlMatches,
    ).length,
    httpSuccess: evidence.webFetchResults.filter(({ httpSuccess }) => httpSuccess).length,
    maxCharsWithinLimit: evidence.webFetchResults.filter(
      ({ maxCharsWithinLimit }) => maxCharsWithinLimit,
    ).length,
    paired: evidence.webFetchResults.filter(({ paired }) => paired).length,
    publicHttpsTarget: evidence.webFetchResults.filter(({ target }) => isPublicHttpsTarget(target))
      .length,
    resultSuccess: evidence.webFetchResults.filter(({ resultSuccess }) => resultSuccess).length,
    total: evidence.webFetchResults.length,
  };
  return {
    schemaVersion: 1,
    controlTargetViolations: evidence.controlTargetViolations,
    errorCount: evidence.errors.length,
    finalStatusCount: evidence.finalStatuses.length,
    finalSuccess: evidence.finalStatuses.length === 1 && evidence.finalStatuses[0] === "success",
    forbiddenProviderMentionCount: assessment.forbiddenProviderMentions.length,
    forbiddenToolCount: assessment.forbiddenToolNames.length,
    matches: assessment.matches,
    projectedTargetEvidence: evidence.projectedTargetEvidence,
    publicHttpsTargets: assessment.publicHttpsTargets,
    qualifyingWebFetchResults: assessment.qualifyingWebFetchResults,
    unexpectedWebFetchCalls: assessment.unexpectedWebFetchCalls,
    unexpectedWebFetchExecutions: assessment.unexpectedWebFetchExecutions,
    unexpectedWebFetchResults: assessment.unexpectedWebFetchResults,
    webFetchCalls: assessment.webFetchCalls,
    webFetchExecutions: assessment.webFetchExecutions,
    webFetchResultCounts,
    webFetchResultsWithinMaxChars: webFetchResultCounts.maxCharsWithinLimit,
  };
}

export async function validateOpenClawAgentAttemptEvidence(
  options: OpenClawAgentAttemptEvidenceOptions,
): Promise<OpenClawAgentAttemptEvidenceResult> {
  if (!options.classification.passed) return { attempt: options.classification };

  let toolEvidence: OpenClawToolEvidence | undefined;
  if (options.toolEvidenceValidator) {
    const reduced = await options.reduceToolEvidence();
    if (reduced.exitCode !== 0) {
      await options.recordToolEvidenceReductionFailure({
        schemaVersion: 1,
        failureClass: "command-failed",
        exitCode: reduced.exitCode,
        signal: reduced.signal ?? null,
        timedOut: reduced.timedOut ?? false,
      });
      return {
        attempt: { passed: false, failureClass: "deterministic" },
        failure: `reduced tool evidence exited with ${String(reduced.exitCode)}`,
      };
    }
    try {
      toolEvidence = parseOpenClawToolEvidence(reduced.stdout);
    } catch (error) {
      await options.recordToolEvidenceReductionFailure({
        schemaVersion: 1,
        failureClass: "output-invalid",
        exitCode: reduced.exitCode,
        signal: reduced.signal ?? null,
        timedOut: reduced.timedOut ?? false,
      });
      return {
        attempt: { passed: false, failureClass: "deterministic" },
        failure: error instanceof Error ? error.message : String(error),
      };
    }
    await options.recordToolEvidence(toolEvidence);
    if (!options.toolEvidenceValidator(toolEvidence)) {
      const assessment = projectPersonalPublicFetchToolEvidenceArtifact(toolEvidence);
      const counts = assessment.webFetchResultCounts;
      const diagnostic = [
        `errors=${toolEvidence.errors.length}`,
        `finalStatuses=${toolEvidence.finalStatuses.length}`,
        `finalSuccess=${assessment.finalSuccess}`,
        `projectedTarget=${assessment.projectedTargetEvidence}`,
        `controlTargetViolations=${assessment.controlTargetViolations}`,
        `webFetchCalls=${assessment.webFetchCalls}`,
        `webFetchExecutions=${assessment.webFetchExecutions}`,
        `qualifying=${assessment.qualifyingWebFetchResults}`,
        `unexpectedWebFetchCalls=${assessment.unexpectedWebFetchCalls}`,
        `unexpectedWebFetchExecutions=${assessment.unexpectedWebFetchExecutions}`,
        `unexpectedWebFetchResults=${assessment.unexpectedWebFetchResults}`,
        `webFetchResults=${counts.total}`,
        `expectedContentMatches=${counts.expectedContentMatches}`,
        `expectedUrlMatches=${counts.expectedUrlMatches}`,
        `httpSuccess=${counts.httpSuccess}`,
        `maxCharsWithinLimit=${counts.maxCharsWithinLimit}`,
        `paired=${counts.paired}`,
        `publicHttpsTarget=${counts.publicHttpsTarget}`,
        `resultSuccess=${counts.resultSuccess}`,
        `forbiddenTools=${assessment.forbiddenToolCount}`,
        `forbiddenProviders=${assessment.forbiddenProviderMentionCount}`,
      ].join("; ");
      return {
        attempt: { passed: false, failureClass: "deterministic" },
        failure: `${options.label}: reduced tool evidence did not match the required trajectory (${diagnostic})`,
      };
    }
  }
  return {
    attempt: { passed: true },
    evidence: toolEvidence ? { reply: options.reply, toolEvidence } : { reply: options.reply },
  };
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
const TOOL_APPROVAL_AGENT_REPLY_RE =
  /(?:waiting for|requires?) (?:your )?approval|please approve(?: it)? to proceed/iu;
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

/** Recognize retryable Hermes turn failures without accepting an incomplete product response. */
export function isHermesTransientAgentFailure(httpStatus: string, output: string): boolean {
  if (httpStatus === "200" && TOOL_APPROVAL_AGENT_REPLY_RE.test(output)) return true;
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
