// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { parseGatewayProviderMetadata } from "./gateway-provider-metadata";
import {
  assessRecoveredProviderCredentialReuse,
  resolveRecoveredProviderCredentialReuse,
} from "./recovered-provider-reuse";

const completeRecovery = {
  hostCredentialAvailable: false,
  recoveredFromSandbox: true,
  selectedKey: "custom",
  selectedProvider: "compatible-endpoint",
  selectedModel: "nvidia/nemotron-3-ultra",
  recoveredProvider: "compatible-endpoint",
  recoveredModel: "nvidia/nemotron-3-ultra",
  recoveredPreferredInferenceApi: "openai-completions",
  expectedProviderType: "openai",
  expectedCredentialEnv: "COMPATIBLE_API_KEY",
  gatewayProvider: {
    name: "compatible-endpoint",
    type: "openai",
    credentialKeys: ["COMPATIBLE_API_KEY"],
    configKeys: ["OPENAI_BASE_URL"],
  },
  endpointIdentity: {
    flavor: "openai" as const,
    routeSource: "registry" as const,
    selected: "https://inference.example/v1/",
    recovered: "https://inference.example/v1?ignored=1",
    otherRecorded: [] as string[],
  },
};

describe("assessRecoveredProviderCredentialReuse", () => {
  it("preserves normal validation whenever a host credential is available", () => {
    expect(
      assessRecoveredProviderCredentialReuse({
        ...completeRecovery,
        hostCredentialAvailable: true,
        gatewayProvider: null,
        recoveredModel: null,
      }),
    ).toEqual({ kind: "validate-host-credential" });
  });

  it("reuses an exact registered provider with complete recovered routing state", () => {
    expect(assessRecoveredProviderCredentialReuse(completeRecovery)).toEqual({
      kind: "reuse-gateway-credential",
      preferredInferenceApi: "openai-completions",
    });
  });

  it("requires the exact endpoint-config binding for built-in provider recovery", () => {
    const builtInOpenAi = {
      ...completeRecovery,
      selectedKey: "openai",
      selectedProvider: "openai-api",
      recoveredProvider: "openai-api",
      expectedCredentialEnv: "OPENAI_API_KEY",
      gatewayProvider: {
        name: "openai-api",
        type: "openai",
        credentialKeys: ["OPENAI_API_KEY"],
        configKeys: ["OPENAI_BASE_URL"],
      },
      endpointIdentity: undefined,
    };

    expect(assessRecoveredProviderCredentialReuse(builtInOpenAi)).toMatchObject({
      kind: "reuse-gateway-credential",
    });
    for (const configKeys of [[], ["WRONG_BASE_URL"], ["OPENAI_BASE_URL", "EXTRA_FLAG"]]) {
      expect(
        assessRecoveredProviderCredentialReuse({
          ...builtInOpenAi,
          gatewayProvider: { ...builtInOpenAi.gatewayProvider, configKeys },
        }),
      ).toMatchObject({ kind: "reject" });
    }
  });

  it("reuses OpenRouter when its distinct provider name is registered as OpenAI-compatible (#5826)", () => {
    expect(
      assessRecoveredProviderCredentialReuse({
        ...completeRecovery,
        selectedKey: "openrouter",
        selectedProvider: "openrouter-api",
        recoveredProvider: "openrouter-api",
        expectedCredentialEnv: "OPENROUTER_API_KEY",
        gatewayProvider: {
          name: "openrouter-api",
          type: "openai",
          credentialKeys: ["OPENROUTER_API_KEY"],
          configKeys: ["OPENAI_BASE_URL"],
        },
        endpointIdentity: undefined,
      }),
    ).toMatchObject({
      kind: "reuse-gateway-credential",
      preferredInferenceApi: "openai-completions",
    });
  });

  it("rejects recovered OpenRouter responses routes because onboarding forces chat completions (#5826)", () => {
    expect(
      assessRecoveredProviderCredentialReuse({
        ...completeRecovery,
        selectedKey: "openrouter",
        selectedProvider: "openrouter-api",
        recoveredProvider: "openrouter-api",
        recoveredPreferredInferenceApi: "openai-responses",
        expectedCredentialEnv: "OPENROUTER_API_KEY",
        gatewayProvider: {
          name: "openrouter-api",
          type: "openai",
          credentialKeys: ["OPENROUTER_API_KEY"],
          configKeys: ["OPENAI_BASE_URL"],
        },
        endpointIdentity: undefined,
      }),
    ).toMatchObject({ kind: "reject" });
  });

  it.each([
    ["explicit selection", { recoveredFromSandbox: false }],
    ["provider mismatch", { recoveredProvider: "openai-api" }],
    ["missing provider", { recoveredProvider: null }],
    ["oversized provider", { recoveredProvider: `p${"x".repeat(128)}` }],
    ["missing model", { recoveredModel: null }],
    ["unsafe model", { recoveredModel: "model;touch /tmp/pwned" }],
    ["oversized model", { recoveredModel: `m${"x".repeat(512)}` }],
    ["model mismatch", { selectedModel: "another-model" }],
    ["missing inference API", { recoveredPreferredInferenceApi: null }],
    ["unsupported inference API", { recoveredPreferredInferenceApi: "ollama" }],
    ["missing gateway provider", { gatewayProvider: null }],
    [
      "gateway provider type mismatch",
      { gatewayProvider: { ...completeRecovery.gatewayProvider, type: "anthropic" } },
    ],
    [
      "gateway credential binding mismatch",
      { gatewayProvider: { ...completeRecovery.gatewayProvider, credentialKeys: ["OTHER_KEY"] } },
    ],
    [
      "ambiguous gateway credential binding",
      {
        gatewayProvider: {
          ...completeRecovery.gatewayProvider,
          credentialKeys: ["COMPATIBLE_API_KEY", "OTHER_KEY"],
        },
      },
    ],
  ])("rejects incomplete recovery state: %s", (_label, override) => {
    expect(
      assessRecoveredProviderCredentialReuse({ ...completeRecovery, ...override }),
    ).toMatchObject({
      kind: "reject",
    });
  });

  it("rejects syntactically valid credential/config-key spoofing at the authorization boundary", () => {
    const gatewayProvider = parseGatewayProviderMetadata(
      "Name: compatible-endpoint\nType: openai\nCredential keys: ATTACKER_KEY\nConfig keys: ATTACKER_BASE_URL",
    );

    expect(gatewayProvider).not.toBeNull();
    expect(
      assessRecoveredProviderCredentialReuse({ ...completeRecovery, gatewayProvider }),
    ).toEqual({
      kind: "reject",
      reason: "provider 'compatible-endpoint' has no compatible non-secret identity in OpenShell",
    });
  });

  it.each([
    ["different URL", "https://other.example/v1"],
    ["userinfo", "https://user:pass@inference.example/v1"],
    ["unsupported scheme", "file:///tmp/provider"],
    ["missing URL", null],
  ])("rejects an incompatible recovered endpoint identity: %s", (_label, recovered) => {
    expect(
      assessRecoveredProviderCredentialReuse({
        ...completeRecovery,
        endpointIdentity: { ...completeRecovery.endpointIdentity, recovered },
      }),
    ).toMatchObject({ kind: "reject", reason: expect.stringContaining("endpoint identity") });
  });

  it.each([
    ["missing target endpoint", null],
    ["valid target endpoint", "https://inference.example/v1"],
  ])("rejects an empty sibling endpoint with a %s", (_label, recovered) => {
    expect(
      assessRecoveredProviderCredentialReuse({
        ...completeRecovery,
        endpointIdentity: {
          ...completeRecovery.endpointIdentity,
          recovered,
          otherRecorded: [""],
        },
      }),
    ).toMatchObject({ kind: "reject", reason: expect.stringContaining("endpoint identity") });
  });

  it("rejects provider-incompatible APIs and conflicting recorded custom endpoints", () => {
    expect(
      assessRecoveredProviderCredentialReuse({
        ...completeRecovery,
        recoveredPreferredInferenceApi: "anthropic-messages",
      }),
    ).toMatchObject({ kind: "reject", reason: expect.stringContaining("inference API") });
    expect(
      assessRecoveredProviderCredentialReuse({
        ...completeRecovery,
        endpointIdentity: {
          ...completeRecovery.endpointIdentity,
          otherRecorded: ["https://other.example/v1"],
        },
      }),
    ).toMatchObject({ kind: "reject", reason: expect.stringContaining("endpoint identity") });
    expect(
      assessRecoveredProviderCredentialReuse({
        ...completeRecovery,
        gatewayProvider: { ...completeRecovery.gatewayProvider, configKeys: [] },
      }),
    ).toMatchObject({ kind: "reject", reason: expect.stringContaining("non-secret identity") });
    expect(
      assessRecoveredProviderCredentialReuse({
        ...completeRecovery,
        gatewayProvider: {
          ...completeRecovery.gatewayProvider,
          configKeys: ["OPENAI_BASE_URL", "EXTRA_FLAG"],
        },
      }),
    ).toMatchObject({ kind: "reject", reason: expect.stringContaining("non-secret identity") });
    expect(
      assessRecoveredProviderCredentialReuse({
        ...completeRecovery,
        endpointIdentity: { ...completeRecovery.endpointIdentity, routeSource: "session" },
      }),
    ).toMatchObject({ kind: "reject", reason: expect.stringContaining("endpoint identity") });
  });

  it("rejects mismatched recovered provider and model combinations", () => {
    for (const override of [
      { recoveredProvider: "another-provider" },
      { recoveredModel: "another-model" },
    ]) {
      expect(
        assessRecoveredProviderCredentialReuse({ ...completeRecovery, ...override }),
      ).toMatchObject({ kind: "reject" });
    }
  });

  it("rejects an unsupported API for the recovered provider type", () => {
    expect(
      assessRecoveredProviderCredentialReuse({
        ...completeRecovery,
        recoveredPreferredInferenceApi: "anthropic-messages",
      }),
    ).toEqual({
      kind: "reject",
      reason: "the recovered inference API is missing or unsupported",
    });
  });

  it("rejects oversized recovered provider, model, and endpoint values", () => {
    const oversizedProvider = "p".repeat(129);
    const oversizedModel = "m".repeat(513);
    const oversizedEndpoint = `https://inference.example/${"x".repeat(2049)}`;
    for (const override of [
      { selectedProvider: oversizedProvider, recoveredProvider: oversizedProvider },
      { selectedModel: oversizedModel, recoveredModel: oversizedModel },
      {
        endpointIdentity: {
          ...completeRecovery.endpointIdentity,
          selected: oversizedEndpoint,
          recovered: oversizedEndpoint,
        },
      },
    ]) {
      expect(
        assessRecoveredProviderCredentialReuse({ ...completeRecovery, ...override }),
      ).toMatchObject({ kind: "reject" });
    }
  });

  it("rejects recovered credential reuse when the registry route is missing", () => {
    expect(
      assessRecoveredProviderCredentialReuse({
        ...completeRecovery,
        endpointIdentity: {
          ...completeRecovery.endpointIdentity,
          routeSource: null,
        },
      }),
    ).toEqual({
      kind: "reject",
      reason: "the recovered endpoint identity is missing or incompatible",
    });
  });

  it("accepts the coerced compatible-Anthropic completions recovery with the OpenAI-surface identity (#6294)", () => {
    expect(
      assessRecoveredProviderCredentialReuse({
        ...completeRecovery,
        selectedKey: "anthropicCompatible",
        selectedProvider: "compatible-anthropic-endpoint",
        recoveredProvider: "compatible-anthropic-endpoint",
        recoveredPreferredInferenceApi: "openai-completions",
        expectedProviderType: "anthropic",
        expectedCredentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        gatewayProvider: {
          name: "compatible-anthropic-endpoint",
          type: "openai",
          credentialKeys: ["COMPATIBLE_ANTHROPIC_API_KEY"],
          configKeys: ["OPENAI_BASE_URL"],
        },
        endpointIdentity: { ...completeRecovery.endpointIdentity, flavor: "anthropic" },
      }),
    ).toMatchObject({ kind: "reuse-gateway-credential" });
  });

  it("rejects a stale Anthropic-surface identity for a coerced completions route so re-registration heals it (#6294)", () => {
    expect(
      assessRecoveredProviderCredentialReuse({
        ...completeRecovery,
        selectedKey: "anthropicCompatible",
        selectedProvider: "compatible-anthropic-endpoint",
        recoveredProvider: "compatible-anthropic-endpoint",
        recoveredPreferredInferenceApi: "openai-completions",
        expectedProviderType: "anthropic",
        expectedCredentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        gatewayProvider: {
          name: "compatible-anthropic-endpoint",
          type: "anthropic",
          credentialKeys: ["COMPATIBLE_ANTHROPIC_API_KEY"],
          configKeys: ["ANTHROPIC_BASE_URL"],
        },
        endpointIdentity: { ...completeRecovery.endpointIdentity, flavor: "anthropic" },
      }),
    ).toMatchObject({
      kind: "reject",
      reason:
        "provider 'compatible-anthropic-endpoint' is still registered for the Anthropic " +
        "Messages surface; export COMPATIBLE_ANTHROPIC_API_KEY so onboarding can " +
        "re-register it for the OpenAI-compatible route",
    });
  });

  it("keeps the legacy Bedrock completions recovery expectation on the Anthropic identity", () => {
    expect(
      assessRecoveredProviderCredentialReuse({
        ...completeRecovery,
        selectedKey: "anthropicCompatible",
        selectedProvider: "compatible-anthropic-endpoint",
        recoveredProvider: "compatible-anthropic-endpoint",
        recoveredPreferredInferenceApi: "openai-completions",
        expectedProviderType: "anthropic",
        expectedCredentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        gatewayProvider: {
          name: "compatible-anthropic-endpoint",
          type: "anthropic",
          credentialKeys: ["COMPATIBLE_ANTHROPIC_API_KEY"],
          configKeys: ["ANTHROPIC_BASE_URL"],
        },
        endpointIdentity: {
          ...completeRecovery.endpointIdentity,
          flavor: "anthropic",
          selected: "https://bedrock-runtime.us-east-1.amazonaws.com",
          recovered: "https://bedrock-runtime.us-east-1.amazonaws.com",
        },
      }),
    ).toMatchObject({ kind: "reuse-gateway-credential" });
  });
});

describe("resolveRecoveredProviderCredentialReuse", () => {
  it("leaves the normal validation path untouched when a host credential exists", () => {
    const state = {
      provider: "compatible-endpoint",
      endpointUrl: "https://inference.example/v1",
      preferredInferenceApi: null,
    };
    const readRecordedInferenceRoute = vi.fn(() => {
      throw new Error("recovery metadata must not be read");
    });
    const readGatewayProviderMetadata = vi.fn(() => {
      throw new Error("gateway reuse must not be checked");
    });

    expect(
      resolveRecoveredProviderCredentialReuse(
        {
          selected: { key: "custom" },
          remoteConfig: { label: "Other OpenAI-compatible endpoint", providerType: "openai" },
          state,
          selectedCredentialEnv: "COMPATIBLE_API_KEY",
          recoveredFromSandbox: true,
          selectedModel: "model",
          sandboxName: "alpha",
        },
        {
          resolveProviderCredential: () => "host-key",
          readRecordedInferenceRoute,
          readRecordedProviderEndpoints: vi.fn(),
          readGatewayProviderMetadata,
          note: vi.fn(),
        },
      ),
    ).toBe(false);
    expect(readRecordedInferenceRoute).not.toHaveBeenCalled();
    expect(readGatewayProviderMetadata).not.toHaveBeenCalled();
    expect(state).toEqual({
      provider: "compatible-endpoint",
      endpointUrl: "https://inference.example/v1",
      preferredInferenceApi: null,
    });
  });

  it("uses the pre-delete registry route after destructive removal", () => {
    const state = {
      provider: "compatible-endpoint",
      endpointUrl: "https://inference.example/v1",
      preferredInferenceApi: null,
    };
    const note = vi.fn();
    const readRecordedInferenceRoute = vi.fn(() => {
      throw new Error("the deleted registry row must not be re-read");
    });

    expect(
      resolveRecoveredProviderCredentialReuse(
        {
          selected: { key: "custom" },
          remoteConfig: { label: "Other OpenAI-compatible endpoint", providerType: "openai" },
          state,
          selectedCredentialEnv: "COMPATIBLE_API_KEY",
          recoveredFromSandbox: true,
          selectedModel: "model",
          sandboxName: "alpha",
          recoveredRegistryRoute: {
            provider: "compatible-endpoint",
            model: "model",
            endpointUrl: "https://inference.example/v1",
            preferredInferenceApi: "openai-completions",
            source: "registry",
          },
        },
        {
          resolveProviderCredential: () => null,
          readRecordedInferenceRoute,
          readRecordedProviderEndpoints: () => [],
          readGatewayProviderMetadata: () => ({
            name: "compatible-endpoint",
            type: "openai",
            credentialKeys: ["COMPATIBLE_API_KEY"],
            configKeys: ["OPENAI_BASE_URL"],
          }),
          note,
        },
      ),
    ).toBe(true);
    expect(state).toEqual({
      provider: "compatible-endpoint",
      endpointUrl: "https://inference.example/v1",
      preferredInferenceApi: "openai-completions",
      skipHostInferenceSmoke: true,
      reuseGatewayCredentialWithoutLocalKey: true,
    });
    expect(note).toHaveBeenCalledOnce();
    expect(readRecordedInferenceRoute).not.toHaveBeenCalled();
  });

  it("rejects an effective model override that differs from the atomic recovered route", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() =>
        resolveRecoveredProviderCredentialReuse(
          {
            selected: { key: "custom" },
            remoteConfig: { label: "Other OpenAI-compatible endpoint", providerType: "openai" },
            state: {
              provider: "compatible-endpoint",
              endpointUrl: "https://inference.example/v1",
              preferredInferenceApi: null,
            },
            selectedCredentialEnv: "COMPATIBLE_API_KEY",
            recoveredFromSandbox: true,
            selectedModel: "model-from-env-override",
            sandboxName: "alpha",
          },
          {
            resolveProviderCredential: () => null,
            readRecordedInferenceRoute: () => ({
              provider: "compatible-endpoint",
              model: "recorded-model",
              endpointUrl: "https://inference.example/v1",
              preferredInferenceApi: "openai-completions",
              source: "registry",
            }),
            readRecordedProviderEndpoints: () => [],
            readGatewayProviderMetadata: () => ({
              name: "compatible-endpoint",
              type: "openai",
              credentialKeys: ["COMPATIBLE_API_KEY"],
              configKeys: ["OPENAI_BASE_URL"],
            }),
            note: vi.fn(),
          },
        ),
      ).toThrow("exit 1");
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
