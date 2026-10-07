// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from "vitest";
import { nativeCompatibleEndpointIdentity } from "../../../inference/native-compatible/endpoint";
import { nativeBedrockIdentity } from "../../../inference/native-bedrock/contract";
import { BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL } from "../../../inference/bedrock-runtime";
import { createSession } from "../../../state/onboard-session";
import { nativeProviderCreateIntentFields } from "../../sandbox-registration";
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

it.each([
  {
    endpointUrl: "https://bedrock-runtime.us-west-2.amazonaws.com",
    preferredInferenceApi: "openai-completions",
  },
  {
    endpointUrl: binding.endpointUrl,
    preferredInferenceApi: "anthropic-messages",
  },
  { endpointUrl: null, preferredInferenceApi: null },
])(
  "refuses a stored Bedrock receipt when the requested selection changes: %j",
  async (selection) => {
    const f = fixture(receipt);
    await expect(handleSandboxState({ ...f.options, ...selection })).rejects.toThrow();
    expect(f.calls.createSandbox).not.toHaveBeenCalled();
    expect(f.calls.removeSandbox).not.toHaveBeenCalled();
  },
);

it.each([
  {
    endpointUrl: "https://other.example.com/v1",
    preferredInferenceApi: "openai-completions",
  },
  {
    endpointUrl: "https://api.example.com/v1",
    preferredInferenceApi: "anthropic-messages",
  },
  { endpointUrl: null, preferredInferenceApi: null },
])("refuses a compatible receipt against changed requested selection: %j", async (selection) => {
  const identity = nativeCompatibleEndpointIdentity({
    addresses: ["93.184.216.34"],
    endpointUrl: "https://api.example.com/v1",
    api: "openai-completions",
  });
  const compatible = {
    ...identity,
    schemaVersion: 1 as const,
    providerId: "owned",
    addresses: ["93.184.216.34"],
    endpointUrl: identity.endpoint,
  };
  const { deps, calls } = createDeps({
    getSandboxRegistryEntry: (name) => ({
      name,
      provider: "compatible-endpoint",
      endpointUrl: identity.endpoint,
      preferredInferenceApi: identity.api,
      nativeCompatibleProviderAttachment: compatible,
    }),
  });
  await expect(
    handleSandboxState({
      ...baseOptions(deps, createSession({ sandboxName: "compatible" })),
      sandboxName: "compatible",
      provider: "compatible-endpoint",
      ...selection,
    }),
  ).rejects.toThrow("selected endpoint");
  expect(calls.createSandbox).not.toHaveBeenCalled();
  expect(calls.removeSandbox).not.toHaveBeenCalled();
});

it("does not inherit a stored endpoint when the current endpoint is explicitly undefined", () => {
  expect(() =>
    nativeProviderCreateIntentFields(
      {
        provider: "compatible-anthropic-endpoint",
        endpointUrl: undefined,
        preferredInferenceApi: undefined,
      },
      {
        name: "bedrock",
        provider: "compatible-anthropic-endpoint",
        endpointUrl: binding.endpointUrl,
        preferredInferenceApi: "openai-completions",
        nativeBedrockProviderAttachment: receipt,
      },
    ),
  ).toThrow();
});
