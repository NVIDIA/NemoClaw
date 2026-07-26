// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { classifyCustomAnthropicEndpoint, isBedrockRuntimeEndpoint } from "./bedrock-runtime";

describe("Bedrock Runtime endpoint classification", () => {
  it("detects standard Bedrock Runtime hosts", () => {
    expect(
      classifyCustomAnthropicEndpoint("https://bedrock-runtime.us-east-1.amazonaws.com"),
    ).toEqual({
      kind: "bedrock-runtime",
      endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      hostname: "bedrock-runtime.us-east-1.amazonaws.com",
      region: "us-east-1",
      fips: false,
    });
  });

  it("detects Bedrock Runtime FIPS hosts", () => {
    expect(
      classifyCustomAnthropicEndpoint(
        "https://bedrock-runtime-fips.us-gov-west-1.amazonaws.com/v1/messages",
      ),
    ).toEqual({
      kind: "bedrock-runtime",
      endpointUrl: "https://bedrock-runtime-fips.us-gov-west-1.amazonaws.com",
      hostname: "bedrock-runtime-fips.us-gov-west-1.amazonaws.com",
      region: "us-gov-west-1",
      fips: true,
    });
  });

  it("leaves Bedrock Mantle and Anthropic-compatible gateways on the Messages path", () => {
    expect(isBedrockRuntimeEndpoint("https://bedrock-mantle.example.com/v1/messages")).toBe(false);
    expect(isBedrockRuntimeEndpoint("https://proxy.example.com/v1/messages")).toBe(false);
    expect(isBedrockRuntimeEndpoint("https://api.anthropic.com/v1/messages")).toBe(false);
  });

  it("requires the canonical authenticated TLS boundary for Bedrock Runtime", () => {
    expect(isBedrockRuntimeEndpoint("https://bedrock-runtime.us-east-1.amazonaws.com:443")).toBe(
      true,
    );
    expect(isBedrockRuntimeEndpoint("http://bedrock-runtime.us-east-1.amazonaws.com")).toBe(false);
    expect(isBedrockRuntimeEndpoint("https://bedrock-runtime.us-east-1.amazonaws.com:18147")).toBe(
      false,
    );
    expect(isBedrockRuntimeEndpoint("https://user@bedrock-runtime.us-east-1.amazonaws.com")).toBe(
      false,
    );
  });
});
