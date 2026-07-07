// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayProviderMetadata } from "../../onboard/gateway-provider-metadata";
import {
  canRecreateMissingRebuildGatewayProvider,
  checkRebuildGatewayCredentialReuseOrBail,
  checkRebuildGatewayProviderOrBail,
  classifyRebuildGatewayProviderRegistration,
  shouldVerifyRebuildGatewayProvider,
} from "./rebuild-provider-preflight";
import type { RebuildResumeConfig } from "./rebuild-resume-config";

const exactGatewayProvider: GatewayProviderMetadata = {
  name: "compatible-endpoint",
  type: "openai",
  credentialKeys: ["COMPATIBLE_API_KEY"],
  configKeys: ["OPENAI_BASE_URL"],
};

function config(overrides: Partial<RebuildResumeConfig> = {}): RebuildResumeConfig {
  return {
    agent: null,
    provider: "compatible-endpoint",
    model: "nvidia/model",
    nimContainer: null,
    credentialEnv: "COMPATIBLE_API_KEY",
    preferredInferenceApi: "openai-completions",
    compatibleEndpointReasoning: null,
    pinEndpoint: true,
    endpointUrl: "https://inference.example.test/v1",
    registryInferenceRoute: {
      provider: "compatible-endpoint",
      model: "nvidia/model",
      endpointUrl: "https://inference.example.test/v1",
      preferredInferenceApi: "openai-completions",
      source: "registry",
    },
    ambient: { presentVars: [], agentMismatch: null },
    ...overrides,
  };
}

const throwingBail = (message: string): never => {
  throw new Error(message);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shouldVerifyRebuildGatewayProvider", () => {
  it("requires remote registrations while allowing reconstructible local registrations", () => {
    expect(shouldVerifyRebuildGatewayProvider("nvidia-prod")).toBe(true);
    expect(shouldVerifyRebuildGatewayProvider("ollama-local")).toBe(false);
    expect(shouldVerifyRebuildGatewayProvider("vllm-local")).toBe(false);

    const log = vi.fn();
    const bail = vi.fn(() => {
      throw new Error("local provider must not require an existing gateway registration");
    });
    expect(checkRebuildGatewayProviderOrBail("ollama-local", null, log, bail)).toBe(true);
    expect(log).not.toHaveBeenCalled();
    expect(bail).not.toHaveBeenCalled();
  });
});

describe("canRecreateMissingRebuildGatewayProvider", () => {
  it("requires a canonical provider and its exact credential binding (#6114)", () => {
    expect(
      canRecreateMissingRebuildGatewayProvider("compatible-endpoint", "COMPATIBLE_API_KEY"),
    ).toBe(true);
    expect(canRecreateMissingRebuildGatewayProvider("compatible-endpoint", "OPENAI_API_KEY")).toBe(
      false,
    );
    expect(canRecreateMissingRebuildGatewayProvider("mystery-provider", "MYSTERY_API_KEY")).toBe(
      false,
    );
    expect(canRecreateMissingRebuildGatewayProvider("nvidia-nim", "NVIDIA_INFERENCE_API_KEY")).toBe(
      true,
    );
    expect(canRecreateMissingRebuildGatewayProvider("nvidia-nim", "NVIDIA_API_KEY")).toBe(false);
  });
});

describe("classifyRebuildGatewayProviderRegistration", () => {
  it("distinguishes explicit absence from an indeterminate lookup failure (#6114)", () => {
    expect(
      classifyRebuildGatewayProviderRegistration(
        {
          status: 1,
          stderr: "Error: provider 'compatible-endpoint' not found",
        },
        "compatible-endpoint",
      ),
    ).toBe("missing");
    expect(
      classifyRebuildGatewayProviderRegistration(
        {
          status: 1,
          stderr:
            "Error:   × code: 'Some requested entity was not found', message: \"provider not found\"",
        },
        "compatible-endpoint",
      ),
    ).toBe("missing");
    expect(
      classifyRebuildGatewayProviderRegistration(
        {
          status: 1,
          stderr:
            'Error: status: NotFound, message: "provider not found", details: [], metadata: MetadataMap { headers: {} }',
        },
        "compatible-endpoint",
      ),
    ).toBe("missing");
    expect(
      classifyRebuildGatewayProviderRegistration(
        {
          status: 7,
          stderr: "gateway transport unavailable",
        },
        "compatible-endpoint",
      ),
    ).toBe("indeterminate");
    expect(
      classifyRebuildGatewayProviderRegistration(
        {
          status: 7,
          stderr: "provider lookup failed because gateway was not found",
        },
        "compatible-endpoint",
      ),
    ).toBe("indeterminate");
    expect(
      classifyRebuildGatewayProviderRegistration(
        { status: 1, stderr: "provider lookup not found" },
        "compatible-endpoint",
      ),
    ).toBe("indeterminate");
    expect(
      classifyRebuildGatewayProviderRegistration(
        { status: 1, stderr: "provider 'other-provider' not found" },
        "compatible-endpoint",
      ),
    ).toBe("indeterminate");
    expect(
      classifyRebuildGatewayProviderRegistration(
        {
          status: 7,
          stderr: 'Error: status: Unavailable, message: "provider not found"',
        },
        "compatible-endpoint",
      ),
    ).toBe("indeterminate");
    expect(
      classifyRebuildGatewayProviderRegistration(
        {
          status: 1,
          stderr: 'Error: status: NotFound, message: "gateway not found"',
        },
        "compatible-endpoint",
      ),
    ).toBe("indeterminate");
    expect(
      classifyRebuildGatewayProviderRegistration(
        {
          status: 1,
          stderr: [
            'Error: status: NotFound, message: "gateway not found"',
            'Error: status: Unavailable, message: "provider not found"',
          ].join("\n"),
        },
        "compatible-endpoint",
      ),
    ).toBe("indeterminate");
    expect(
      classifyRebuildGatewayProviderRegistration(
        {
          status: 1,
          stderr:
            'Error: status: NotFound, message: "gateway not found"; status: Unavailable, message: "provider not found"',
        },
        "compatible-endpoint",
      ),
    ).toBe("indeterminate");
    expect(classifyRebuildGatewayProviderRegistration({ status: 0 }, "compatible-endpoint")).toBe(
      "registered",
    );
  });
});

describe("checkRebuildGatewayCredentialReuseOrBail", () => {
  it("accepts an exact complete registry route and gateway provider identity", () => {
    expect(
      checkRebuildGatewayCredentialReuseOrBail("alpha", config(), false, vi.fn(), throwingBail, {
        readGatewayProviderMetadata: () => exactGatewayProvider,
        readRecordedProviderEndpoints: () => [],
      }),
    ).toBe(true);
  });

  it("preserves normal host-key validation without reading gateway recovery metadata", () => {
    const readGatewayProviderMetadata = vi.fn();
    expect(
      checkRebuildGatewayCredentialReuseOrBail("alpha", config(), true, vi.fn(), throwingBail, {
        readGatewayProviderMetadata,
        readRecordedProviderEndpoints: vi.fn(),
      }),
    ).toBe(true);
    expect(readGatewayProviderMetadata).not.toHaveBeenCalled();
  });

  it("preserves Bedrock Runtime rebuilds with explicit AWS authentication", () => {
    const readGatewayProviderMetadata = vi.fn();
    const bedrock = config({
      provider: "compatible-anthropic-endpoint",
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      registryInferenceRoute: {
        provider: "compatible-anthropic-endpoint",
        model: "nvidia/model",
        endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        preferredInferenceApi: "openai-completions",
        source: "registry",
      },
    });

    expect(
      checkRebuildGatewayCredentialReuseOrBail("alpha", bedrock, false, vi.fn(), throwingBail, {
        hasBedrockRuntimeAwsAuth: () => true,
        readGatewayProviderMetadata,
        readRecordedProviderEndpoints: vi.fn(),
      }),
    ).toBe(true);
    expect(readGatewayProviderMetadata).not.toHaveBeenCalled();
  });

  it("rejects Bedrock Runtime before deletion when neither AWS nor compatible auth exists", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const bedrock = config({
      provider: "compatible-anthropic-endpoint",
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      registryInferenceRoute: {
        provider: "compatible-anthropic-endpoint",
        model: "nvidia/model",
        endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        preferredInferenceApi: "openai-completions",
        source: "registry",
      },
    });

    expect(() =>
      checkRebuildGatewayCredentialReuseOrBail("alpha", bedrock, false, vi.fn(), throwingBail, {
        hasBedrockRuntimeAwsAuth: () => false,
        readGatewayProviderMetadata: () => ({
          name: "compatible-anthropic-endpoint",
          type: "openai",
          credentialKeys: ["NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN"],
          configKeys: ["OPENAI_BASE_URL"],
        }),
        readRecordedProviderEndpoints: () => [],
      }),
    ).toThrow("Missing Bedrock Runtime authentication");

    const diagnostics = errors.mock.calls.flat().join(" ");
    expect(diagnostics).toContain("AWS_BEARER_TOKEN_BEDROCK");
    expect(diagnostics).toContain("AWS_PROFILE");
    expect(diagnostics).toContain("IAM environment credentials");
    expect(diagnostics).toContain("COMPATIBLE_ANTHROPIC_API_KEY");
  });

  it.each([
    ["missing registry route", config({ registryInferenceRoute: null })],
    [
      "oversized model",
      config({
        model: "m".repeat(513),
        registryInferenceRoute: {
          ...config().registryInferenceRoute!,
          model: "m".repeat(513),
        },
      }),
    ],
    [
      "oversized endpoint",
      config({
        endpointUrl: `https://example.test/${"x".repeat(2049)}`,
        registryInferenceRoute: {
          ...config().registryInferenceRoute!,
          endpointUrl: `https://example.test/${"x".repeat(2049)}`,
        },
      }),
    ],
  ])("rejects %s before destructive rebuild work", (_label, unsafeConfig) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() =>
      checkRebuildGatewayCredentialReuseOrBail(
        "alpha",
        unsafeConfig,
        false,
        vi.fn(),
        throwingBail,
        {
          readGatewayProviderMetadata: () => exactGatewayProvider,
          readRecordedProviderEndpoints: () => [],
        },
      ),
    ).toThrow("Unsafe gateway credential reuse");
  });

  it("rejects spoofed gateway bindings", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const spoofedProvider = {
      ...exactGatewayProvider,
      credentialKeys: ["ATTACKER_KEY"],
    };
    expect(() =>
      checkRebuildGatewayCredentialReuseOrBail("alpha", config(), false, vi.fn(), throwingBail, {
        readGatewayProviderMetadata: () => spoofedProvider,
        readRecordedProviderEndpoints: () => [],
      }),
    ).toThrow("no compatible non-secret identity");
  });

  it("rejects a custom endpoint recorded by another sandbox", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const readRecordedProviderEndpoints = vi.fn(() => ["https://other.example.test/v1"]);

    expect(() =>
      checkRebuildGatewayCredentialReuseOrBail("alpha", config(), false, vi.fn(), throwingBail, {
        readGatewayProviderMetadata: () => exactGatewayProvider,
        readRecordedProviderEndpoints,
      }),
    ).toThrow("recovered endpoint identity is missing or incompatible");
    expect(readRecordedProviderEndpoints).toHaveBeenCalledWith("compatible-endpoint", "alpha");
  });
});
