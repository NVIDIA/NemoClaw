// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { OnboardInferenceCapabilityCache } from "./inference-capability-cache";

describe("OnboardInferenceCapabilityCache", () => {
  it("reuses one selected Chat Completions validation for one matching smoke request", () => {
    const cache = new OnboardInferenceCapabilityCache();
    const input = {
      endpointUrl: "https://api.example.test/v1/",
      model: "model-a",
      authMode: "bearer" as const,
    };

    expect(cache.rememberCompletedOpenAiChat(input)).toBe(true);
    expect(
      cache.takeCompletedOpenAiChat({ ...input, endpointUrl: "https://api.example.test/v1" }),
    ).toBe(true);
    expect(cache.takeCompletedOpenAiChat(input)).toBe(false);
  });

  it("does not reuse mismatched or security-sensitive validation", () => {
    const cache = new OnboardInferenceCapabilityCache();
    const input = {
      endpointUrl: "https://api.example.test/v1",
      model: "model-a",
      authMode: "query-param" as const,
    };

    expect(cache.rememberCompletedOpenAiChat(input)).toBe(true);
    expect(cache.takeCompletedOpenAiChat({ ...input, model: "model-b" })).toBe(false);
    expect(cache.takeCompletedOpenAiChat({ ...input, authMode: "bearer" })).toBe(false);
    expect(
      cache.rememberCompletedOpenAiChat({
        ...input,
        endpointUrl: "https://api.example.test/v1?key=x",
      }),
    ).toBe(false);
    expect(cache.rememberCompletedOpenAiChat({ ...input, extraHeaders: ["X-Test: value"] })).toBe(
      false,
    );

    cache.invalidate();
    expect(cache.takeCompletedOpenAiChat(input)).toBe(false);
  });

  it("reuses a DNS-pinned validation result only for the same approved IP address set", () => {
    const cache = new OnboardInferenceCapabilityCache();
    const input = {
      endpointUrl: "https://api.example.test/v1",
      model: "model-a",
      pinnedAddresses: ["2606:4700:4700::1111", "93.184.216.34"],
    };

    expect(cache.rememberCompletedOpenAiChat(input)).toBe(true);
    expect(
      cache.takeCompletedOpenAiChat({
        ...input,
        pinnedAddresses: ["93.184.216.34", "2606:4700:4700::1111", "93.184.216.34"],
      }),
    ).toBe(true);

    expect(cache.rememberCompletedOpenAiChat(input)).toBe(true);
    expect(cache.takeCompletedOpenAiChat({ ...input, pinnedAddresses: ["93.184.216.35"] })).toBe(
      false,
    );
    expect(
      cache.rememberCompletedOpenAiChat({ ...input, pinnedAddresses: ["not-an-ip-address"] }),
    ).toBe(false);
  });
});
