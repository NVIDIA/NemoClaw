// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { renderCanonicalNemoClawConfig, validateNemoClawConfig } from "./index";
import {
  isImmutableImageReference,
  isValidNemoClawBoundedText,
  isValidNemoClawConfigDocumentName,
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
  it("validates one aggregate config with explicit effective policy (#10938)", () => {
    expect(validateNemoClawConfig(config())).toEqual(config());
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

  it.each(["hermes", "langchain-deepagents-code", "nemocua"])(
    "rejects unsupported v1 agent type %s (#10938)",
    (type) => {
      const value = structuredClone(config()) as unknown as Record<string, any>;
      value.spec.sandboxes[0].agents[0].type = type;
      expect(() => validateNemoClawConfig(value)).toThrow("must be equal to constant");
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
