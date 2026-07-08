// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const BEDROCK_PRE_CONTRACT_ENDPOINT_VALIDATION_SKIP_REASON =
  "external-provider-validation-unavailable-before-bedrock-runtime-contract";
export const BEDROCK_PRE_CONTRACT_ENDPOINT_VALIDATION_SOURCE_BOUNDARY =
  "external NVIDIA Endpoints provider availability before Bedrock Runtime contract";
export const BEDROCK_PRE_CONTRACT_ENDPOINT_VALIDATION_INVALID_STATE =
  "onboarding failed before any fake Bedrock Runtime Converse traffic because unrelated external provider validation was rate-limited or unavailable";
export const BEDROCK_PRE_CONTRACT_ENDPOINT_VALIDATION_REMOVAL_CONDITION =
  "remove once CI endpoint validation is stable for a release cycle or covered by a hermetic provider-validation fixture";

export interface PreContractEndpointValidationEvidence {
  readonly onboardingExitCode: number | null;
  readonly redactedStdout: string;
  readonly redactedStderr: string;
  readonly mockConverseCount: number;
  readonly mockConverseStreamCount: number;
}

export function isPreContractEndpointValidationRateLimitEvidence(
  evidence: PreContractEndpointValidationEvidence,
): boolean {
  if (evidence.onboardingExitCode === 0) return false;
  if (evidence.mockConverseCount > 0 || evidence.mockConverseStreamCount > 0) return false;

  const text = [evidence.redactedStdout, evidence.redactedStderr].filter(Boolean).join("\n");
  const endpointValidation =
    /NVIDIA Endpoints endpoint validation failed|endpoint validation failed|failed to verify inference endpoint|Chat Completions API validation/i.test(
      text,
    );
  const explicitRateLimit = /HTTP 429|\b429\b|Too Many Requests/i.test(text);
  const transientProviderFailure =
    explicitRateLimit ||
    /rate[- ]?limit|quota|temporarily unavailable|timed? out|timeout/i.test(text);
  const sanitizedNvidiaValidation =
    /NVIDIA Endpoints endpoint validation failed/i.test(text) &&
    /Validation details were omitted to avoid exposing credentials/i.test(text);

  return (
    endpointValidation &&
    (explicitRateLimit || (sanitizedNvidiaValidation && transientProviderFailure))
  );
}
