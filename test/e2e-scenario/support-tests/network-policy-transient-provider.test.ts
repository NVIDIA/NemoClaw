// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { isTransientProviderValidationFailure } from "../live/network-policy-transient-provider.ts";

function probeOutput(output: string): { stdout: string; stderr: string } {
  return { stdout: "", stderr: output };
}

describe("network-policy transient provider validation classifier", () => {
  it("matches only endpoint validation failures with transient upstream details", () => {
    expect(
      isTransientProviderValidationFailure(
        probeOutput("Chat Completions API validation failed: request timed out"),
      ),
    ).toBe(true);
    expect(
      isTransientProviderValidationFailure(
        probeOutput("endpoint validation failed: returned HTTP 503 from provider"),
      ),
    ).toBe(true);
    expect(
      isTransientProviderValidationFailure(
        probeOutput("endpoint validation failed: provider rate limit exceeded"),
      ),
    ).toBe(true);

    expect(
      isTransientProviderValidationFailure(
        probeOutput("endpoint validation failed: invalid NVIDIA_INFERENCE_API_KEY credential"),
      ),
    ).toBe(false);
    expect(
      isTransientProviderValidationFailure(
        probeOutput("endpoint validation failed: invalid NVIDIA_API_KEY credential quota exceeded"),
      ),
    ).toBe(false);
    expect(
      isTransientProviderValidationFailure(
        probeOutput("endpoint validation failed: denied by network policy rate-limit preset"),
      ),
    ).toBe(false);
    expect(
      isTransientProviderValidationFailure(
        probeOutput("endpoint validation failed: routing failed before rate limit check"),
      ),
    ).toBe(false);
    expect(
      isTransientProviderValidationFailure(
        probeOutput("endpoint validation failed: proxy header stripping quota marker failed"),
      ),
    ).toBe(false);
    expect(
      isTransientProviderValidationFailure(
        probeOutput("policy update failed: denied by network policy"),
      ),
    ).toBe(false);
    expect(
      isTransientProviderValidationFailure(
        probeOutput("sandbox create failed: Docker daemon unavailable"),
      ),
    ).toBe(false);
    expect(
      isTransientProviderValidationFailure(
        probeOutput("curl failed (exit 28) while applying policy preset"),
      ),
    ).toBe(false);
  });
});
