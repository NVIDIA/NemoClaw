// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { renderCanonicalNemoClawConfig, validateNemoClawConfig } from "./index";
import type { NemoClawConfig } from "./model";

function config(uid = "11111111-1111-4111-8111-111111111111"): NemoClawConfig {
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
          api: "openai",
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
              digest: "sha256:" + "a".repeat(64),
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

describe("NemoClawConfig v1", () => {
  it("validates one aggregate config with explicit effective policy (#10938)", () => {
    expect(validateNemoClawConfig(config())).toEqual(config());
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
    const rendered = renderCanonicalNemoClawConfig(value);
    expect(rendered.yaml.indexOf("      z:")).toBeLessThan(rendered.yaml.indexOf("      ä:"));
    expect(renderCanonicalNemoClawConfig(reordered)).toEqual(rendered);
  });

  it("emits the same canonical YAML for mapping insertion order changes (#10938)", () => {
    const value = config();
    const reordered = {
      kind: value.kind,
      spec: value.spec,
      metadata: value.metadata,
      apiVersion: value.apiVersion,
    };
    expect(renderCanonicalNemoClawConfig(reordered).yaml).toBe(
      renderCanonicalNemoClawConfig(value).yaml,
    );
    expect(YAML.parse(renderCanonicalNemoClawConfig(value).yaml)).toEqual(value);
  });

  it("changes documentDigest but keeps specDigest when a fresh UID changes (#10938)", () => {
    const first = renderCanonicalNemoClawConfig(config());
    const second = renderCanonicalNemoClawConfig(config("22222222-2222-4222-8222-222222222222"));
    expect(second.documentDigest).not.toBe(first.documentDigest);
    expect(second.specDigest).toBe(first.specDigest);
    expect(first.documentDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });
});
