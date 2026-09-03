// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";
import { describe, expect, it } from "vitest";
import {
  digestNemoClawConfig,
  serializeCanonicalNemoClawConfig,
  validateNemoClawConfig,
} from "./index";
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

  it("rejects credential transport and operation-control names (#10938)", () => {
    for (const env of ["NEMOCLAW_PROVIDER_KEY", "OPENSHELL_SECRET", "VITEST_TOKEN", "CI"]) {
      const value = structuredClone(config()) as unknown as Record<string, any>;
      value.spec.inferenceProviders[0].credential = { env };
      expect(() => validateNemoClawConfig(value)).toThrow("not an allowed credential reference");
    }
  });

  it("emits the same canonical YAML for mapping insertion order changes (#10938)", () => {
    const value = config();
    const reordered = {
      kind: value.kind,
      spec: value.spec,
      metadata: value.metadata,
      apiVersion: value.apiVersion,
    };
    expect(serializeCanonicalNemoClawConfig(reordered)).toBe(
      serializeCanonicalNemoClawConfig(value),
    );
    expect(YAML.parse(serializeCanonicalNemoClawConfig(value))).toEqual(value);
  });

  it("changes documentDigest but keeps specDigest when a fresh UID changes (#10938)", () => {
    const first = digestNemoClawConfig(config());
    const second = digestNemoClawConfig(config("22222222-2222-4222-8222-222222222222"));
    expect(second.documentDigest).not.toBe(first.documentDigest);
    expect(second.specDigest).toBe(first.specDigest);
    expect(first.documentDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });
});
