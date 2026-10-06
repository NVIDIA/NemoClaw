// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL } from "../../inference/bedrock-runtime";
import { nativeBedrockIdentity } from "../../inference/native-bedrock/contract";
import {
  buildSandboxInferenceInvocationCommand,
  probeSandboxInferenceInvocation,
  resolveSandboxInferenceInvocationEndpoint,
} from "./inference-invocation-probe";

const binding = {
  endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
  region: "us-east-1",
  adapterGeneration: "a".repeat(32),
  adapterBaseUrl: BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL,
  gatewayName: "selected-gateway",
};
const input = {
  sandboxName: "selected-sandbox",
  gatewayName: binding.gatewayName,
  provider: "compatible-anthropic-endpoint",
  model: "anthropic.claude-model",
  preferredInferenceApi: "anthropic-messages",
  nativeBedrockProviderAttachment: {
    schemaVersion: 1 as const,
    providerId: "owned-adapter-provider",
    ...nativeBedrockIdentity(binding),
    ...binding,
  },
};

describe("Bedrock native invocation", () => {
  it("uses the recorded adapter route and issued adapter token rather than AWS credentials", () => {
    expect(resolveSandboxInferenceInvocationEndpoint(input)).toBe(
      `${binding.adapterBaseUrl}/chat/completions`,
    );
    const command = buildSandboxInferenceInvocationCommand(input);
    expect(command).toContain("NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN");
    expect(command).not.toContain("inference.local");
    expect(command).not.toContain("AWS_");
    expect(command).not.toContain("anthropic-version");
  });
  it.each([undefined, "another-gateway"])(
    "refuses an unbound gateway %s before executing",
    (gatewayName) => {
      expect(() => buildSandboxInferenceInvocationCommand({ ...input, gatewayName })).toThrow();
    },
  );
  it("validates the adapter OpenAI response and executes only in the recorded gateway", async () => {
    const execute = vi.fn().mockResolvedValue({
      status: 0,
      stdout: '200\n{"choices":[{"message":{"content":"OK"}}]}',
      stderr: "",
    });
    await expect(probeSandboxInferenceInvocation(input, { execute })).resolves.toEqual({
      ok: true,
    });
    expect(execute).toHaveBeenCalledWith(
      input.sandboxName,
      expect.any(String),
      expect.any(Number),
      { gatewayName: binding.gatewayName },
    );
  });
});
