// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { normalizeInferenceSelection } from "./selection";

describe("normalizeInferenceSelection", () => {
  it("persists recognized endpoint provenance only with a recorded endpoint", () => {
    expect(
      normalizeInferenceSelection({
        endpointUrl: "https://inference.example/v1",
        endpointSource: "onboard",
      }).endpointSource,
    ).toBe("onboard");
    expect(
      normalizeInferenceSelection({
        endpointUrl: "https://inference.example/v1",
        endpointSource: "inference-set",
      }).endpointSource,
    ).toBe("inference-set");
    expect(
      normalizeInferenceSelection({
        endpointUrl: "https://inference.example/v1",
        endpointSource: "forged",
      } as never).endpointSource,
    ).toBeNull();
    expect(
      normalizeInferenceSelection({ endpointUrl: null, endpointSource: "onboard" }).endpointSource,
    ).toBeNull();
  });

  it("persists canonical compatible-endpoint reasoning values", () => {
    expect(
      normalizeInferenceSelection({
        provider: "compatible-endpoint",
        compatibleEndpointReasoning: " TRUE ",
      }).compatibleEndpointReasoning,
    ).toBe("true");
    expect(
      normalizeInferenceSelection({
        provider: "compatible-endpoint",
        compatibleEndpointReasoning: "false",
      }).compatibleEndpointReasoning,
    ).toBe("false");
  });

  it("rejects malformed reasoning values", () => {
    expect(
      normalizeInferenceSelection({
        provider: "compatible-endpoint",
        compatibleEndpointReasoning: "yes",
      }).compatibleEndpointReasoning,
    ).toBeNull();
  });

  it("clears reasoning state for non-compatible providers", () => {
    expect(
      normalizeInferenceSelection({
        provider: "nvidia-prod",
        compatibleEndpointReasoning: "true",
      }).compatibleEndpointReasoning,
    ).toBeNull();
  });
});
