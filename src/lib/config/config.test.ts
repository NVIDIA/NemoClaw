// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { renderCanonicalNemoClawConfig, validateNemoClawConfig } from "./index";
import {
  EXPORTED_VLLM_PROFILE_ID,
  EXPORTED_VLLM_RECIPE_ID,
  isCredentialEnvironmentReferenceName,
  isImmutableImageReference,
  isValidNemoClawBoundedText,
  isValidNemoClawConfigDocumentName,
  isValidNemoClawInferenceEndpoint,
  isValidNemoClawRuntimeProvider,
  NemoClawConfigSchema,
  parseNemoClawConfigDocumentName,
  type ImmutableImageReference,
  type NemoClawConfigDocumentName,
  type NemoClawConfigDocumentUid,
} from "./model";

function config(uid = "11111111-1111-4111-8111-111111111111") {
  return {
    apiVersion: "nemoclaw.nvidia.com/v1",
    kind: "NemoClawConfig",
    metadata: { name: "work-agents", uid },
    spec: {
      gateway: { management: "nemoclaw", name: "nemoclaw", port: 8080 },
      inferenceProviders: [
        {
          name: "hosted-openai",
          provider: "openai",
          api: "openai-responses",
          endpoint: "https://api.openai.com/v1",
          credential: { env: "OPENAI_API_KEY" },
        },
      ],
      sandboxes: [
        {
          name: "alpha",
          runtime: {
            provider: "docker",
            image: {
              ref: "nvcr.io/nvidia/nemoclaw@sha256:" + "a".repeat(64),
            },
          },
          network: {
            policy: {
              explicit: {
                version: 1,
                network_policies: {
                  inference: {
                    name: "inference",
                    endpoints: [{ host: "api.openai.com", port: 443 }],
                    binaries: [{ path: "/usr/bin/openclaw" }],
                  },
                },
              },
            },
          },
          agents: [
            {
              name: "primary",
              type: "openclaw",
              inference: {
                routes: [
                  { name: "primary", providerRef: "hosted-openai", overrides: { model: "gpt-5" } },
                ],
              },
            },
          ],
        },
      ],
    },
  };
}

function renderInput(value: unknown) {
  return renderCanonicalNemoClawConfig(validateNemoClawConfig(value));
}

describe("NemoClawConfig v1", () => {
  it.each([0, 0.5, 1])("preserves local OTLP sample rate %s in canonical YAML", (sampleRate) => {
    const value = config();
    const observability = {
      otlp: {
        enabled: true,
        endpoint: "http://host.openshell.internal:4318",
        serviceName: "s".repeat(256),
        sampleRate,
      },
    };
    Object.assign(value.spec.sandboxes[0]!.agents[0]!, { observability });

    const rendered = renderInput(value);
    const roundTrip = validateNemoClawConfig(YAML.parse(rendered.yaml));

    expect(roundTrip.spec.sandboxes[0]!.agents[0]!).toMatchObject({ observability });
  });

  it("rejects OpenClaw observability on a Hermes agent", () => {
    const value = config();
    Object.assign(value.spec.sandboxes[0]!.agents[0]!, {
      type: "hermes",
      observability: {
        otlp: {
          enabled: true,
          endpoint: "http://host.openshell.internal:4318",
          serviceName: "research-assistant",
          sampleRate: 0.5,
        },
      },
    });

    expect(() => validateNemoClawConfig(value)).toThrow("Invalid NemoClawConfig");
  });

  it.each([
    { label: "disabled explicit profile", change: { enabled: false } },
    { label: "remote collector", change: { endpoint: "https://collector.example/v1/traces" } },
    {
      label: "collector path",
      change: { endpoint: "http://host.openshell.internal:4318/v1/traces" },
    },
    {
      label: "collector credentials",
      change: { endpoint: "http://user:OTEL_CANARY@host.openshell.internal:4318" },
    },
    {
      label: "collector query",
      change: { endpoint: "http://host.openshell.internal:4318?token=OTEL_CANARY" },
    },
    {
      label: "collector fragment",
      change: { endpoint: "http://host.openshell.internal:4318#OTEL_CANARY" },
    },
    { label: "collector headers", change: { headers: { authorization: "OTEL_CANARY" } } },
    { label: "empty service", change: { serviceName: "" } },
    { label: "leading service space", change: { serviceName: " research" } },
    { label: "trailing service space", change: { serviceName: "research " } },
    { label: "service newline", change: { serviceName: "research\n" } },
    { label: "service carriage return", change: { serviceName: "research\r" } },
    { label: "service control character", change: { serviceName: "research\u0000assistant" } },
    { label: "Unicode service", change: { serviceName: "recherche-é" } },
    { label: "oversized service", change: { serviceName: "s".repeat(257) } },
    { label: "negative sample", change: { sampleRate: -0.1 } },
    { label: "sample above one", change: { sampleRate: 1.1 } },
    { label: "non-finite sample", change: { sampleRate: Infinity } },
    { label: "NaN sample", change: { sampleRate: NaN } },
  ])("rejects OTLP $label without echoing its value", ({ change }) => {
    const value = config();
    Object.assign(value.spec.sandboxes[0]!.agents[0]!, {
      observability: {
        otlp: {
          enabled: true,
          endpoint: "http://host.openshell.internal:4318",
          serviceName: "research-assistant",
          sampleRate: 0.5,
          ...change,
        },
      },
    });

    expect(() => validateNemoClawConfig(value)).toThrow("Invalid NemoClawConfig");
    try {
      validateNemoClawConfig(value);
    } catch (error) {
      expect(String(error)).not.toContain("OTEL_CANARY");
    }
  });

  it("validates one aggregate config with explicit effective policy (#10938)", () => {
    expect(validateNemoClawConfig(config())).toEqual(config());
  });

  it("retains explicit false, default reasoning effort, and zero heartbeat", () => {
    const value = config();
    const agent = value.spec.sandboxes[0]!.agents[0]!;
    Object.assign(agent.inference.routes[0]!.overrides, {
      contextWindow: 4194304,
      maxTokens: 1000000000,
      reasoning: false,
      reasoningEffort: "default",
    });
    Object.assign(agent, { execution: { timeoutSeconds: 1000000000, heartbeatEvery: "0m" } });
    expect(validateNemoClawConfig(value)).toEqual(value);
  });

  it.each([
    { contextWindow: 0 },
    { contextWindow: 4194305 },
    { maxTokens: 1.5 },
    { maxTokens: 1000000001 },
    { reasoning: "false" },
    { reasoningEffort: "extreme" },
    { inputModalities: ["image"] },
    { unexpected: true },
  ])("rejects invalid or unsupported route settings", (fields) => {
    const value = config();
    Object.assign(value.spec.sandboxes[0]!.agents[0]!.inference.routes[0]!.overrides, fields);
    expect(() => validateNemoClawConfig(value)).toThrow();
  });

  it.each([
    {},
    { timeoutSeconds: 0 },
    { timeoutSeconds: 1000000001 },
    { heartbeatEvery: "30m\n" },
    { heartbeatEvery: "30d" },
    { heartbeatEvery: "3".repeat(256) + "m" },
    { heartbeatEvery: null },
    { unexpected: true },
  ])("rejects invalid or unsupported execution settings", (fields) => {
    const value = config();
    Object.assign(value.spec.sandboxes[0]!.agents[0]!, { execution: fields });
    expect(() => validateNemoClawConfig(value)).toThrow();
  });

  it("rejects OpenClaw execution settings on a Hermes agent", () => {
    const value = config();
    Object.assign(value.spec.sandboxes[0]!.agents[0]!, {
      type: "hermes",
      execution: { timeoutSeconds: 900 },
    });
    expect(() => validateNemoClawConfig(value)).toThrow();
  });

  it("round-trips Brave search bound to the primary agent (#10904)", () => {
    const value = config();
    const integration = {
      webSearch: {
        provider: "brave",
        agentRefs: ["primary"],
        credential: { env: "BRAVE_API_KEY" },
      },
    };
    Object.assign(value.spec.sandboxes[0]!, { integrations: integration });
    const rendered = renderInput(value);
    expect(validateNemoClawConfig(YAML.parse(rendered.yaml))).toEqual(value);
  });

  it.each([
    { provider: "tavily" },
    { agentRefs: [] },
    { agentRefs: ["primary", "primary"] },
    { agentRefs: ["other"] },
    { credential: { env: "NEMOCLAW_PROVIDER_KEY" } },
    { credential: { env: "TAVILY_API_KEY" } },
    { credential: { value: "secret-canary" } },
    { unexpected: true },
  ])("rejects unsupported Brave configuration %j (#10904)", (change) => {
    const value = config();
    Object.assign(value.spec.sandboxes[0]!, {
      integrations: {
        webSearch: {
          provider: "brave",
          agentRefs: ["primary"],
          credential: { env: "BRAVE_API_KEY" },
          ...change,
        },
      },
    });
    expect(() => validateNemoClawConfig(value)).toThrow();
    try {
      validateNemoClawConfig(value);
    } catch (error) {
      expect(String(error)).not.toContain("secret-canary");
    }
  });

  it.each([
    { label: "missing primary", change: { name: "other" } },
    { label: "wrong type", change: { type: "hermes" } },
  ])("rejects a Brave binding with $label (#10904)", ({ change }) => {
    const value = config();
    Object.assign(value.spec.sandboxes[0]!, {
      integrations: {
        webSearch: {
          provider: "brave",
          agentRefs: ["primary"],
          credential: { env: "BRAVE_API_KEY" },
        },
      },
    });
    Object.assign(value.spec.sandboxes[0]!.agents[0]!, change);
    expect(() => validateNemoClawConfig(value)).toThrow();
  });

  it.each([
    { host: "user:secret-canary@proxy.internal", port: 3129 },
    { host: "http://proxy.internal", port: 3129 },
    { host: "proxy.internal\n", port: 3129 },
    { host: "a".repeat(257), port: 3129 },
    { host: "proxy.internal", port: 0 },
    { host: "proxy.internal", port: 65_536 },
    { host: "proxy.internal", port: 3129.5 },
    { host: "proxy.internal", port: 3129, credential: "secret-canary" },
    { host: "proxy.internal" },
    { port: 3129 },
  ])("rejects malformed or incomplete managed proxy configuration", (proxy) => {
    const value = config();
    Object.assign(value.spec.sandboxes[0]!.network, { proxy });
    expect(() => validateNemoClawConfig(value)).toThrow();
    try {
      validateNemoClawConfig(value);
    } catch (error) {
      expect(String(error)).not.toContain("secret-canary");
    }
  });

  it("returns an owned and deeply frozen validated document (#10938)", () => {
    const input = config();
    const validated = validateNemoClawConfig(input);

    expect(validated).not.toBe(input);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.spec.sandboxes[0]!.network.policy.explicit)).toBe(true);
    (input.metadata as { name: string }).name = "changed-after-validation";
    expect(validated.metadata.name).toBe("work-agents");
  });

  it("preserves validated leaf brands in the aggregate type", () => {
    const validated = validateNemoClawConfig(config());
    const leaves = {
      documentName: validated.metadata.name,
      documentUid: validated.metadata.uid,
      imageRef: validated.spec.sandboxes[0]!.runtime.image.ref,
    } satisfies {
      documentName: NemoClawConfigDocumentName;
      documentUid: NemoClawConfigDocumentUid;
      imageRef: ImmutableImageReference;
    };

    expect(leaves.documentName).toBe("work-agents");
  });

  it.each(["openai-completions", "openai-responses", "anthropic-messages"] as const)(
    "accepts supported inference API %s (#10938)",
    (api) => {
      const value = structuredClone(config()) as unknown as Record<string, any>;
      value.spec.inferenceProviders[0].api = api;
      expect(validateNemoClawConfig(value).spec.inferenceProviders[0]!.api).toBe(api);
    },
  );

  it("rejects an unknown inference API (#10938)", () => {
    const value = structuredClone(config()) as unknown as Record<string, any>;
    value.spec.inferenceProviders[0].api = "openai";
    expect(() => validateNemoClawConfig(value)).toThrow(
      "must be equal to one of the allowed values",
    );
  });

  it("accepts Hermes as a v1 agent type (#11286)", () => {
    const value = structuredClone(config()) as unknown as Record<string, any>;
    value.spec.sandboxes[0].agents[0].type = "hermes";

    expect(validateNemoClawConfig(value).spec.sandboxes[0]!.agents[0]!.type).toBe("hermes");
  });

  it("round-trips Hermes API-key authentication bound to its inference route (#11432)", () => {
    const value = structuredClone(config()) as unknown as Record<string, any>;
    const provider = value.spec.inferenceProviders[0];
    provider.name = "hosted-hermes-provider";
    provider.provider = "hermes-provider";
    provider.api = "openai-completions";
    provider.endpoint = "https://inference-api.nousresearch.com/v1";
    provider.credential.env = "NOUS_API_KEY";
    const agent = value.spec.sandboxes[0].agents[0];
    agent.type = "hermes";
    agent.inference.routes[0].providerRef = provider.name;
    agent.auth = { method: "api-key", providerRef: provider.name };

    const rendered = renderInput(value);
    expect(validateNemoClawConfig(YAML.parse(rendered.yaml))).toEqual(value);
  });

  it.each([
    ["OpenClaw agent", { agentType: "openclaw" }],
    ["unknown provider", { authProviderRef: "missing" }],
    ["foreign provider", { provider: "openai" }],
    ["foreign API", { api: "anthropic-messages" }],
    ["foreign endpoint", { endpoint: "https://api.example.com/v1" }],
    ["foreign credential", { credentialEnv: "OPENAI_API_KEY" }],
  ])("rejects Hermes API-key authentication with an %s (#11432)", (_case, change) => {
    const options = change as Partial<{
      agentType: string;
      api: string;
      authProviderRef: string;
      credentialEnv: string;
      endpoint: string;
      provider: string;
      routeProviderRef: string;
    }>;
    const value = structuredClone(config()) as unknown as Record<string, any>;
    const provider = value.spec.inferenceProviders[0];
    provider.name = "hosted-hermes-provider";
    provider.provider = options.provider ?? "hermes-provider";
    provider.api = options.api ?? "openai-completions";
    provider.endpoint = options.endpoint ?? "https://inference-api.nousresearch.com/v1";
    provider.credential.env = options.credentialEnv ?? "NOUS_API_KEY";
    const agent = value.spec.sandboxes[0].agents[0];
    agent.type = options.agentType ?? "hermes";
    agent.inference.routes[0].providerRef = options.routeProviderRef ?? provider.name;
    agent.auth = {
      method: "api-key",
      providerRef: options.authProviderRef ?? provider.name,
    };

    expect(() => validateNemoClawConfig(value)).toThrow();
  });

  it("rejects Hermes API-key authentication unrelated to its inference route", () => {
    const value = structuredClone(config()) as unknown as Record<string, any>;
    value.spec.inferenceProviders.push({
      name: "hosted-hermes-provider",
      provider: "hermes-provider",
      api: "openai-completions",
      endpoint: "https://inference-api.nousresearch.com/v1",
      credential: { env: "NOUS_API_KEY" },
    });
    const agent = value.spec.sandboxes[0].agents[0];
    agent.type = "hermes";
    agent.auth = { method: "api-key", providerRef: "hosted-hermes-provider" };

    expect(() => validateNemoClawConfig(value)).toThrow(
      "must match an inference route for this agent",
    );
  });

  it.each([
    { method: "oauth", providerRef: "hosted-openai" },
    { method: "api_key", providerRef: "hosted-openai" },
    { method: "api-key", providerRef: "hosted-openai", token: "secret-canary" },
  ])("rejects unsupported Hermes auth structure %j (#11432)", (auth) => {
    const value = structuredClone(config()) as unknown as Record<string, any>;
    value.spec.sandboxes[0].agents[0].type = "hermes";
    value.spec.sandboxes[0].agents[0].auth = auth;
    expect(() => validateNemoClawConfig(value)).toThrow();
    try {
      validateNemoClawConfig(value);
    } catch (error) {
      expect(String(error)).not.toContain("secret-canary");
    }
  });

  it("keeps the exported authoritative schema deeply immutable", () => {
    expect(Object.isFrozen(NemoClawConfigSchema)).toBe(true);
    expect(Object.isFrozen(NemoClawConfigSchema.properties.spec)).toBe(true);
    expect(() => {
      (NemoClawConfigSchema as unknown as { additionalProperties: boolean }).additionalProperties =
        true;
    }).toThrow();
    expect(() => {
      (
        NemoClawConfigSchema.properties.spec as unknown as { additionalProperties: boolean }
      ).additionalProperties = true;
    }).toThrow();
  });

  it("uses separate document and sandbox name domains (#10938)", () => {
    const documentName = "a-valid-document-name-that-is-longer-than-nineteen";
    expect(isValidNemoClawConfigDocumentName(documentName)).toBe(true);
    expect(parseNemoClawConfigDocumentName(documentName)).toBe(documentName);

    const value = structuredClone(config()) as unknown as Record<string, any>;
    value.metadata.name = documentName;
    value.spec.sandboxes[0].name = "sandbox-name-longer-than-nineteen";
    expect(() => validateNemoClawConfig(value)).toThrow("must NOT have more than 19 characters");
  });

  it("does not include rejected document names in parser diagnostics (#10938)", () => {
    const canary = "DO_NOT_LOG_DOCUMENT_NAME";
    expect(() => parseNemoClawConfigDocumentName(canary)).toThrow("config name must contain");
    try {
      parseNemoClawConfigDocumentName(canary);
    } catch (error) {
      expect(String(error)).not.toContain(canary);
    }
  });

  it("rejects unknown fields and unresolved provider references (#10938)", () => {
    const unknown = { ...config(), unexpected: true };
    expect(() => validateNemoClawConfig(unknown)).toThrow("additional properties");
    const unresolved = structuredClone(config()) as unknown as Record<string, any>;
    unresolved.spec.sandboxes[0].agents[0].inference.routes[0].providerRef = "missing";
    expect(() => validateNemoClawConfig(unresolved)).toThrow(
      "does not match an inference provider",
    );
  });

  it.each(["langchain-deepagents-code", "nemocua"])(
    "rejects unsupported v1 agent type %s (#10938)",
    (type) => {
      const value = structuredClone(config()) as unknown as Record<string, any>;
      value.spec.sandboxes[0].agents[0].type = type;
      expect(() => validateNemoClawConfig(value)).toThrow("Invalid NemoClawConfig");
    },
  );

  it.each(["reasoning", "limits"])(
    "rejects unsupported v1 inference field %s (#10938)",
    (field) => {
      const value = structuredClone(config()) as unknown as Record<string, any>;
      value.spec.sandboxes[0].agents[0].inference.routes[0][field] = {};
      expect(() => validateNemoClawConfig(value)).toThrow("additional properties");
    },
  );

  it.each(["NEMOCLAW_PROVIDER_KEY", "OPENSHELL_SECRET", "VITEST_TOKEN", "CI"])(
    "rejects reserved credential reference %s (#10938)",
    (env) => {
      const value = structuredClone(config()) as unknown as Record<string, any>;
      value.spec.inferenceProviders[0].credential = { env };
      expect(() => validateNemoClawConfig(value)).toThrow("not an allowed credential reference");
    },
  );

  it("uses the model guard for credential-reference semantics", () => {
    expect(isCredentialEnvironmentReferenceName("OPENAI_API_KEY")).toBe(true);
    expect(isCredentialEnvironmentReferenceName("NEMOCLAW_PROVIDER_KEY")).toBe(false);
    expect(isCredentialEnvironmentReferenceName(42)).toBe(false);
  });

  it("rejects unsafe endpoints without including their contents in diagnostics (#10938)", () => {
    const canary = "DO_NOT_LOG_ENDPOINT_SECRET";
    const value = structuredClone(config()) as unknown as Record<string, any>;
    value.spec.inferenceProviders[0].endpoint = `https://user:${canary}@api.example.com/v1`;
    try {
      validateNemoClawConfig(value);
      throw new Error("Expected validation to fail");
    } catch (error) {
      expect(String(error)).toContain("must not contain userinfo, query, or fragment components");
      expect(String(error)).not.toContain(canary);
    }
  });

  it.each(["http://api.example.com/v1", `https://api.example.com/${"a".repeat(2049)}`])(
    "rejects an endpoint outside the complete v1 contract",
    (endpoint) => {
      const value = structuredClone(config()) as unknown as Record<string, any>;
      value.spec.inferenceProviders[0].endpoint = endpoint;
      expect(() => validateNemoClawConfig(value)).toThrow();
    },
  );

  it("uses the model guard for complete inference-endpoint semantics", () => {
    expect(isValidNemoClawInferenceEndpoint("https://api.example.com/v1")).toBe(true);
    expect(isValidNemoClawInferenceEndpoint("https://user:secret@api.example.com/v1")).toBe(false);
    expect(isValidNemoClawInferenceEndpoint(42)).toBe(false);
  });

  it.each([
    "nvcr.io/nvidia/nemoclaw:latest",
    "nvcr.io/nvidia/nemoclaw@sha256:not-a-digest",
    `nvcr.io/nvidia/nemoclaw@sha256:${"a".repeat(64)}\n`,
    `registry.example/${"a".repeat(500)}/image@sha256:${"a".repeat(64)}`,
  ])("rejects a mutable or malformed image reference", (ref) => {
    expect(isImmutableImageReference(ref)).toBe(false);
    const value = structuredClone(config()) as unknown as Record<string, any>;
    value.spec.sandboxes[0].runtime.image.ref = ref;
    expect(() => validateNemoClawConfig(value)).toThrow();
  });

  it.each(["Docker", "docker runtime", "docker_runtime", "-docker", "d".repeat(64)])(
    "rejects runtime provider %s outside the identity grammar",
    (provider) => {
      expect(isValidNemoClawRuntimeProvider(provider)).toBe(false);
      const value = structuredClone(config()) as unknown as Record<string, any>;
      value.spec.sandboxes[0].runtime.provider = provider;
      expect(() => validateNemoClawConfig(value)).toThrow();
    },
  );

  it.each(["open ai", "open\u202eai", "open\u200bai"])(
    "rejects whitespace and format controls in bounded identity text",
    (provider) => {
      expect(isValidNemoClawBoundedText(provider)).toBe(false);
      const value = structuredClone(config()) as unknown as Record<string, any>;
      value.spec.inferenceProviders[0].provider = provider;
      expect(() => validateNemoClawConfig(value)).toThrow();
    },
  );

  it("counts bounded identity text in Unicode code points", () => {
    const accepted = "😀".repeat(512);
    const rejected = "😀".repeat(513);
    const decomposedRejected = "a\u0301".repeat(512);
    expect(isValidNemoClawBoundedText(accepted)).toBe(true);
    expect(isValidNemoClawBoundedText(rejected)).toBe(false);
    expect(isValidNemoClawBoundedText(decomposedRejected)).toBe(false);

    const value = structuredClone(config()) as unknown as Record<string, any>;
    value.spec.inferenceProviders[0].provider = accepted;
    expect(validateNemoClawConfig(value).spec.inferenceProviders[0]!.provider).toBe(accepted);
    value.spec.inferenceProviders[0].provider = rejected;
    expect(() => validateNemoClawConfig(value)).toThrow();
    value.spec.inferenceProviders[0].provider = decomposedRejected;
    expect(() => validateNemoClawConfig(value)).toThrow();
  });

  it("rejects credential-bearing policy without exposing its value", () => {
    const canary = "credential-canary-value";
    const value = structuredClone(config()) as unknown as Record<string, any>;
    value.spec.sandboxes[0].network.policy.explicit.process = { password: canary };
    try {
      validateNemoClawConfig(value);
      throw new Error("Expected validation to fail");
    } catch (error) {
      expect(String(error)).toContain("credential-free");
      expect(String(error)).not.toContain(canary);
    }
  });

  it("does not include policy mapping keys in schema diagnostics", () => {
    const canary = "DO_NOT_LOG_POLICY_KEY";
    const value = structuredClone(config()) as unknown as Record<string, any>;
    value.spec.sandboxes[0].network.policy.explicit.network_policies[canary] = {
      name: "invalid",
      endpoints: [],
      binaries: [],
    };
    try {
      validateNemoClawConfig(value);
      throw new Error("Expected validation to fail");
    } catch (error) {
      expect(String(error)).not.toContain(canary);
    }
  });

  it.each([
    ["Map", () => new Map([["key", "value"]])],
    ["Date", () => new Date(0)],
  ] as const)("rejects %s values outside exact JSON data", (_name, createValue) => {
    const value = structuredClone(config()) as unknown as Record<string, any>;
    value.spec.sandboxes[0].network.policy.explicit.extra = createValue();
    expect(() => validateNemoClawConfig(value)).toThrow("exact plain JSON data");
  });

  it("rejects accessors, undefined properties, and cycles as non-wire data", () => {
    const accessor = structuredClone(config()) as unknown as Record<string, any>;
    Object.defineProperty(accessor, "computed", { enumerable: true, get: () => "value" });
    expect(() => validateNemoClawConfig(accessor)).toThrow("exact plain JSON data");

    const undefinedValue = structuredClone(config()) as unknown as Record<string, any>;
    undefinedValue.spec.inferenceProviders[0].credential = undefined;
    expect(() => validateNemoClawConfig(undefinedValue)).toThrow("exact plain JSON data");

    const cyclic = structuredClone(config()) as unknown as Record<string, any>;
    cyclic.self = cyclic;
    expect(() => validateNemoClawConfig(cyclic)).toThrow("exact plain JSON data");
  });

  it("rejects a separate image digest field (#10938)", () => {
    const value = structuredClone(config()) as unknown as Record<string, any>;
    value.spec.sandboxes[0].runtime.image.digest = `sha256:${"a".repeat(64)}`;
    expect(() => validateNemoClawConfig(value)).toThrow("additional properties");
  });

  it("uses fixed code-unit ordering for non-ASCII mapping keys (#10938)", () => {
    const value = config();
    (value.spec.sandboxes[0]!.network.policy.explicit as Record<string, any>).network_policies = {
      ä: {
        name: "ä",
        endpoints: [{ host: "z.example.com", port: 443 }],
        binaries: [{ path: "/usr/bin/z" }],
      },
      z: {
        name: "z",
        endpoints: [{ host: "a.example.com", port: 443 }],
        binaries: [{ path: "/usr/bin/a" }],
      },
    };
    const reordered = config();
    const policies = value.spec.sandboxes[0]!.network.policy.explicit.network_policies as Record<
      string,
      unknown
    >;
    (reordered.spec.sandboxes[0]!.network.policy.explicit as Record<string, any>).network_policies =
      {
        z: policies.z,
        ä: policies.ä,
      };
    const rendered = renderInput(value);
    expect(rendered.yaml.indexOf("      z:")).toBeLessThan(rendered.yaml.indexOf("      ä:"));
    expect(renderInput(reordered)).toEqual(rendered);
  });

  it("emits the same canonical YAML for mapping insertion order changes (#10938)", () => {
    const value = config();
    const reordered = {
      kind: value.kind,
      spec: value.spec,
      metadata: value.metadata,
      apiVersion: value.apiVersion,
    };
    expect(renderInput(reordered).yaml).toBe(renderInput(value).yaml);
    expect(YAML.parse(renderInput(value).yaml)).toEqual(value);
  });

  it("changes documentDigest but keeps specDigest when a fresh UID changes (#10938)", () => {
    const first = renderInput(config());
    const second = renderInput(config("22222222-2222-4222-8222-222222222222"));
    expect(second.documentDigest).not.toBe(first.documentDigest);
    expect(second.specDigest).toBe(first.specDigest);
    expect(first.documentDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });
});

function managedServingConfig() {
  const value = config();
  const provider = {
    name: "managed-vllm",
    provider: "vllm-local",
    api: "openai-completions",
    serving: {
      backend: "vllm",
      catalogDigest: `sha256:${"b".repeat(64)}`,
      profile: { id: EXPORTED_VLLM_PROFILE_ID, digest: `sha256:${"c".repeat(64)}` },
      recipe: { id: EXPORTED_VLLM_RECIPE_ID, digest: `sha256:${"d".repeat(64)}` },
      model: { id: "nvidia/model", revision: "e".repeat(40), servedName: "managed-model" },
      runtime: { image: { ref: `nvcr.io/nvidia/vllm@sha256:${"f".repeat(64)}` } },
      hostPort: 18000,
    },
  };
  Object.assign(value.spec, { inferenceProviders: [provider] });
  const route = {
    name: "primary",
    providerRef: "managed-vllm",
    overrides: { model: "managed-model", contextWindow: 65536 },
  };
  value.spec.sandboxes[0]!.agents[0]!.inference.routes = [route];
  return { value, provider, route };
}

describe("fixed managed serving public contract", () => {
  it("round trips an immutable catalog reference and nondefault published port", () => {
    const { value } = managedServingConfig();
    expect(validateNemoClawConfig(YAML.parse(renderInput(value).yaml))).toEqual(value);
  });

  it("rejects vllm-local without its managed serving contract", () => {
    const { value, provider } = managedServingConfig();
    Reflect.deleteProperty(provider, "serving");
    Object.assign(provider, { endpoint: "https://127.0.0.1:18000/v1" });
    expect(() => validateNemoClawConfig(value)).toThrow();
  });

  it.each([
    [
      "transport credential",
      (f: ReturnType<typeof managedServingConfig>) =>
        Object.assign(f.provider, { credential: { env: "NEMOCLAW_VLLM_LOCAL_TOKEN" } }),
    ],
    [
      "arbitrary endpoint",
      (f: ReturnType<typeof managedServingConfig>) =>
        Object.assign(f.provider, { endpoint: "http://127.0.0.1:18000/v1" }),
    ],
    [
      "arbitrary arguments",
      (f: ReturnType<typeof managedServingConfig>) =>
        Object.assign(f.provider.serving, { arguments: ["--trust-remote-code"] }),
    ],
    [
      "other recipe",
      (f: ReturnType<typeof managedServingConfig>) => {
        Object.assign(f.provider.serving.recipe, { id: "other" });
      },
    ],
    [
      "mutable image",
      (f: ReturnType<typeof managedServingConfig>) => {
        f.provider.serving.runtime.image.ref = "vllm:latest";
      },
    ],
    [
      "unknown backend",
      (f: ReturnType<typeof managedServingConfig>) => {
        f.provider.serving.backend = "ollama";
      },
    ],
    [
      "unknown runtime property",
      (f: ReturnType<typeof managedServingConfig>) =>
        Object.assign(f.provider.serving.runtime, { env: { SECRET: "private" } }),
    ],
    [
      "missing context",
      (f: ReturnType<typeof managedServingConfig>) =>
        Reflect.deleteProperty(f.route.overrides, "contextWindow"),
    ],
    [
      "different context",
      (f: ReturnType<typeof managedServingConfig>) => {
        f.route.overrides.contextWindow = 32768;
      },
    ],
    [
      "different model",
      (f: ReturnType<typeof managedServingConfig>) => {
        f.route.overrides.model = "other";
      },
    ],
    [
      "different runtime",
      (f: ReturnType<typeof managedServingConfig>) => {
        f.value.spec.sandboxes[0]!.runtime.provider = "apple-container";
      },
    ],
  ])("rejects %s instead of accepting an incomplete managed intent", (_name, change) => {
    const f = managedServingConfig();
    change(f);
    expect(() => validateNemoClawConfig(f.value)).toThrow();
  });
});

describe("OpenClaw dashboard configuration", () => {
  it("rejects dashboard interfaces on Hermes (#10904)", () => {
    const value = config();
    Object.assign(value.spec.sandboxes[0]!.agents[0]!, {
      type: "hermes",
      interfaces: { dashboard: { port: 19000, bind: "0.0.0.0" } },
    });
    expect(() => validateNemoClawConfig(value)).toThrow("Invalid NemoClawConfig");
  });

  it.each([
    { port: 19000, bind: "0.0.0.0" },
    { port: 1024 },
    { port: 65535 },
    { port: 18789, bind: "127.0.0.1" },
    { bind: "0.0.0.0" },
  ])("round trips supported dashboard settings %j (#10904)", (dashboard) => {
    const value = config();
    Object.assign(value.spec.sandboxes[0]!.agents[0]!, { interfaces: { dashboard } });
    expect(validateNemoClawConfig(YAML.parse(renderInput(value).yaml))).toEqual(value);
  });

  it.each([
    {},
    { port: 0 },
    { port: 1023 },
    { port: 65536 },
    { port: 19000.5 },
    { port: "19000" },
    { port: 8642 },
    { port: 8652 },
    { bind: "::" },
    { bind: "192.0.2.1" },
    { bind: "0.0.0.0\n" },
    { port: 19000, url: "https://dashboard.example.com" },
    { bind: "0.0.0.0", deviceAuth: { enabled: false } },
  ])("rejects unsupported dashboard settings %j (#10904)", (dashboard) => {
    const value = config();
    Object.assign(value.spec.sandboxes[0]!.agents[0]!, { interfaces: { dashboard } });
    expect(() => validateNemoClawConfig(value)).toThrow("Invalid NemoClawConfig");
  });
});
