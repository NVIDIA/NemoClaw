// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from "vitest";
import { nativeBedrockIdentity } from "../../../inference/native-bedrock/contract";
import { BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL } from "../../../inference/bedrock-runtime";
import { createSession } from "../../../state/onboard-session";
import { handleSandboxState } from "./sandbox";
import { baseOptions, createDeps } from "./sandbox-test-fixtures";
vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
}));
const binding = {
  endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
  region: "us-east-1",
  adapterGeneration: "a".repeat(32),
  adapterBaseUrl: BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL,
  gatewayName: "nemoclaw",
};
const receipt = {
  ...binding,
  ...nativeBedrockIdentity(binding),
  schemaVersion: 1 as const,
  providerId: "owned",
};
function fixture(nativeBedrockProviderAttachment?: typeof receipt) {
  const { deps, calls } = createDeps({
    getSandboxRegistryEntry: (name: string) => ({
      name,
      provider: "compatible-anthropic-endpoint",
      model: "anthropic.claude",
      endpointUrl: binding.endpointUrl,
      gatewayName: "nemoclaw",
      preferredInferenceApi: "openai-completions",
      nativeBedrockProviderAttachment,
      webSearchEnabled: false,
      toolDisclosure: "progressive" as const,
      fromDockerfile: null,
      hermesAuthMethod: null,
    }),
  });
  return {
    calls,
    options: {
      ...baseOptions(deps, createSession({ sandboxName: "bedrock" })),
      sandboxName: "bedrock",
      provider: "compatible-anthropic-endpoint",
      model: "anthropic.claude",
      endpointUrl: binding.endpointUrl,
      preferredInferenceApi: "openai-completions",
    },
  };
}
it("carries the retained Bedrock provider identity into sandbox creation", async () => {
  const f = fixture(receipt);
  await handleSandboxState(f.options);
  expect(f.calls.resolveCreateIntent).toHaveBeenCalledWith(
    expect.objectContaining({
      inferenceProvider: receipt.providerName,
      nativeBedrockProviderAttachment: receipt,
    }),
  );
});
it("refuses a missing Bedrock receipt before sandbox creation instead of using the shared route", async () => {
  const f = fixture();
  await expect(handleSandboxState(f.options)).rejects.toThrow("Recreate this beta sandbox");
  expect(f.calls.createSandbox).not.toHaveBeenCalled();
  expect(f.calls.removeSandbox).not.toHaveBeenCalled();
});
