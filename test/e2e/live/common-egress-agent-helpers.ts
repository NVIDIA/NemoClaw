// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Pure parsing/classification helpers shared by the common-egress-agent live
// E2E target and its PR-collected unit tests. Extracting them lets the fast
// e2e-support project verify the OpenClaw JSON framing, Hermes response parsing,
// expected-token matching, and pre-contract provider-validation skip
// classification without gating on NEMOCLAW_RUN_LIVE_E2E=1.

import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { isTransientProviderValidationFailure } from "./network-policy-transient-provider.ts";

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

export function agentReplyContainsToken(reply: string, expected: string): boolean {
  const compactExpected = compactAgentReply(expected);
  return compactExpected.length > 0 && compactAgentReply(reply).includes(compactExpected);
}

export function classifyPreContractProviderValidationSkip(
  result: Pick<ShellProbeResult, "stdout" | "stderr">,
): CommonEgressProviderValidationSkip {
  const output = text(result);
  const providerValidation =
    /endpoint validation failed|failed to verify inference endpoint|Chat Completions API validation/i.test(
      output,
    );
  const transientProviderValidationFailure = isTransientProviderValidationFailure(result);
  const http429ProviderValidationFailure =
    providerValidation && /HTTP\s*429|\b429\b|rate[- ]?limit|too many requests/i.test(output);
  const sanitizedEndpointValidationFailure =
    providerValidation &&
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
