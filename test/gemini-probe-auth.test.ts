// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";

type OnboardProbeInternals = {
  getProbeAuthMode: (provider: string) => "query-param" | undefined;
};

function isOnboardProbeInternals(value: object | null): value is OnboardProbeInternals {
  return value !== null && typeof Reflect.get(value, "getProbeAuthMode") === "function";
}

const loadedOnboardProbeInternals = require("../dist/lib/onboard");
const onboardProbeInternals =
  typeof loadedOnboardProbeInternals === "object" && loadedOnboardProbeInternals !== null
    ? loadedOnboardProbeInternals
    : null;
if (!isOnboardProbeInternals(onboardProbeInternals)) {
  throw new Error("Expected onboard probe internals to expose getProbeAuthMode");
}
const { getProbeAuthMode } = onboardProbeInternals;

// The onboarder's Gemini validation probes target the OpenAI-compat
// endpoint at https://generativelanguage.googleapis.com/v1beta/openai/.
// That endpoint requires `Authorization: Bearer <KEY>` and rejects
// `?key=<KEY>` with HTTP 400 "Missing or invalid Authorization header."
//
// The dual-auth rejection described in #1960 applies to Gemini's native
// /v1beta/models/...:generateContent endpoint, which is not used by the
// onboarder probes. getProbeAuthMode therefore returns undefined for
// every provider so probes default to Bearer auth.
describe("getProbeAuthMode — Bearer auth for OpenAI-compat probes", () => {
  it("returns undefined for gemini-api so probes send Authorization: Bearer", () => {
    expect(getProbeAuthMode("gemini-api")).toBeUndefined();
  });

  it("returns undefined for non-Gemini providers", () => {
    expect(getProbeAuthMode("openai-api")).toBeUndefined();
    expect(getProbeAuthMode("nvidia-prod")).toBeUndefined();
    expect(getProbeAuthMode("anthropic-prod")).toBeUndefined();
    expect(getProbeAuthMode("compatible-endpoint")).toBeUndefined();
    expect(getProbeAuthMode("")).toBeUndefined();
  });
});
