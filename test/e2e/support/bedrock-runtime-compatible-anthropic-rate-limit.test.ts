// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  BEDROCK_PRE_CONTRACT_ENDPOINT_VALIDATION_INVALID_STATE,
  BEDROCK_PRE_CONTRACT_ENDPOINT_VALIDATION_REMOVAL_CONDITION,
  BEDROCK_PRE_CONTRACT_ENDPOINT_VALIDATION_SOURCE_BOUNDARY,
  isPreContractEndpointValidationRateLimitEvidence,
  type PreContractEndpointValidationEvidence,
} from "../live/bedrock-runtime-compatible-anthropic-rate-limit.ts";

function evidence(
  overrides: Partial<PreContractEndpointValidationEvidence> = {},
): PreContractEndpointValidationEvidence {
  return {
    mockConverseCount: 0,
    mockConverseStreamCount: 0,
    onboardingExitCode: 1,
    redactedStderr: "",
    redactedStdout: "",
    ...overrides,
  };
}

describe("Bedrock Runtime pre-contract endpoint-validation skip evidence", () => {
  it("classifies explicit HTTP 429 endpoint validation before fake Bedrock traffic", () => {
    expect(
      isPreContractEndpointValidationRateLimitEvidence(
        evidence({
          redactedStderr: "NVIDIA Endpoints endpoint validation failed: HTTP 429 Too Many Requests",
        }),
      ),
    ).toBe(true);
  });

  it("classifies sanitized transient NVIDIA validation before fake Bedrock traffic", () => {
    expect(
      isPreContractEndpointValidationRateLimitEvidence(
        evidence({
          redactedStderr:
            "NVIDIA Endpoints endpoint validation failed. Validation details were omitted to avoid exposing credentials. Request timed out.",
        }),
      ),
    ).toBe(true);
  });

  it("does not skip once the fake Bedrock contract has begun", () => {
    expect(
      isPreContractEndpointValidationRateLimitEvidence(
        evidence({
          mockConverseCount: 1,
          redactedStderr: "NVIDIA Endpoints endpoint validation failed: HTTP 429 Too Many Requests",
        }),
      ),
    ).toBe(false);
  });

  it("does not skip successful onboarding", () => {
    expect(
      isPreContractEndpointValidationRateLimitEvidence(
        evidence({
          onboardingExitCode: 0,
          redactedStderr: "NVIDIA Endpoints endpoint validation failed: HTTP 429 Too Many Requests",
        }),
      ),
    ).toBe(false);
  });

  it("does not skip non-transient endpoint-validation failures", () => {
    expect(
      isPreContractEndpointValidationRateLimitEvidence(
        evidence({
          redactedStderr: "NVIDIA Endpoints endpoint validation failed: invalid model",
        }),
      ),
    ).toBe(false);
  });

  it("documents the external source boundary and removal condition", () => {
    expect(BEDROCK_PRE_CONTRACT_ENDPOINT_VALIDATION_SOURCE_BOUNDARY).toContain(
      "external NVIDIA Endpoints",
    );
    expect(BEDROCK_PRE_CONTRACT_ENDPOINT_VALIDATION_INVALID_STATE).toContain(
      "before any fake Bedrock Runtime Converse traffic",
    );
    expect(BEDROCK_PRE_CONTRACT_ENDPOINT_VALIDATION_REMOVAL_CONDITION).toContain(
      "hermetic provider-validation fixture",
    );
  });
});
