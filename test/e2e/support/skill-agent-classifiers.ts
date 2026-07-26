// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Pure predicate helpers shared by the skill-agent live E2E target and its
// PR-collected unit tests. Keeping them here lets the fast e2e-support project
// exercise the classification logic without gating on NEMOCLAW_RUN_LIVE_E2E=1.

// Token the injected skill fixture must echo back through the agent transcript.
export const VERIFY_PHRASE = "SKILL_SMOKE_VERIFY_K9X2";

export function isExternalAgentVerificationFlake(text: string): boolean {
  // Only provider/model/transport timeout signatures are skippable, and only
  // after the fixture is proven present. OpenClaw tool/runtime errors must fail
  // this migration guard because the contract is that the real agent can read
  // SKILL.md and return the token. This tolerance can be narrowed once the live
  // provider/agent turn is consistently non-429/non-timeout in scheduled runs.
  return /LLM idle timeout|request timed out|fetch timeout|model did not produce a response|ssh\/agent exit 124|exit 124|HTTP 429|\b429\b|rate[- ]?limit|quota|temporarily unavailable/i.test(
    text,
  );
}

export function isAgentVerificationFailClosed(text: string): boolean {
  // Preserve the existing helper's fail-closed ordering: a non-zero helper
  // result that reports tool/security/runtime failure must not be turned into
  // success just because the agent transcript also echoed the token.
  return /SsrFBlockedError|Blocked hostname|Blocked: resolves to|transport error|provider error|ECONNREFUSED|EAI_AGAIN|gateway unavailable/i.test(
    text,
  );
}

export function shouldSkipExternalAgentVerificationFailure(
  text: string,
  fixturePresent: boolean,
): boolean {
  return (
    fixturePresent && !isAgentVerificationFailClosed(text) && isExternalAgentVerificationFlake(text)
  );
}

export function isExternalProviderValidationFailure(text: string): boolean {
  // Onboarding can fail before sandbox creation when the external NVIDIA
  // endpoint validation is rate-limited or unavailable. Treat only those
  // live-service states as inconclusive; repo-local onboarding errors still
  // fail. This can be narrowed when endpoint validation stops producing
  // intermittent 429/timeout failures in scheduled live runs.
  return (
    /NVIDIA Endpoints endpoint validation failed/i.test(text) &&
    /HTTP 429|rate limit|quota|temporarily unavailable|timed out|timeout/i.test(text)
  );
}

export function agentSectionContainsToken(
  agentOutput: string,
  verifyPhrase: string = VERIFY_PHRASE,
): boolean {
  const match = agentOutput.match(/--- agent stdout\/stderr[\s\S]*?--- end ---/);
  if (!match) return false;
  const collapsed = match[0].replace(/[\n\r`"']/g, "").toLowerCase();
  return collapsed.includes(verifyPhrase.toLowerCase());
}
