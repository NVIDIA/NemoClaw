// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parseConfigExport } from "../fixtures/phases/config-export-validation.ts";

const NAMED_OLLAMA_EXPORT = {
  apiVersion: "nemoclaw.nvidia.com/v1alpha1",
  kind: "NemoClawConfig",
  metadata: { name: "attached-ollama", uid: "123e4567-e89b-42d3-a456-426614174000" },
  spec: {
    gateway: { management: "managed", endpoint: "http://127.0.0.1:17681" },
    services: {
      "ollama-auth": {
        kind: "ollamaProxy",
        endpoint: "http://host.openshell.internal:11440/v1",
        upstream: {
          endpoint: "http://127.0.0.1:11439/v1",
          model: { name: "qwen2.5:0.5b", digest: "a".repeat(64) },
        },
      },
    },
    inferenceProviders: [
      {
        name: "local",
        provider: "openai",
        api: "openai-completions",
        serviceRef: "ollama-auth",
      },
    ],
    sandboxes: [
      {
        name: "attached-ollama",
        runtime: { provider: "docker" },
        network: { policy: { explicit: { version: 1 } } },
        harness: { kind: "openclaw" },
        agent: {
          name: "primary",
          inference: {
            routes: [
              {
                name: "primary",
                providerRef: "local",
                overrides: { model: "qwen2.5:0.5b" },
              },
            ],
          },
        },
      },
    ],
  },
};

describe("named Ollama proxy export schema", () => {
  it("accepts the v1alpha1 named service document (#12012)", () => {
    expect(parseConfigExport(JSON.stringify(NAMED_OLLAMA_EXPORT))).toMatchObject({
      spec: {
        inferenceProviders: [{ serviceRef: "ollama-auth" }],
        services: {
          "ollama-auth": {
            endpoint: "http://host.openshell.internal:11440/v1",
            upstream: { model: { name: "qwen2.5:0.5b", digest: "a".repeat(64) } },
          },
        },
        sandboxes: [{ agent: { name: "primary" } }],
      },
    });
  });

  it("rejects the superseded inline proxy document (#12012)", () => {
    const inline = structuredClone(NAMED_OLLAMA_EXPORT);
    const provider = inline.spec.inferenceProviders[0]!;
    Reflect.deleteProperty(provider, "serviceRef");
    Object.assign(provider, {
      endpoint: "http://127.0.0.1:11439/v1",
      ollamaProxy: {},
    });

    expect(() => parseConfigExport(JSON.stringify(inline))).toThrow(
      "complete v1alpha1 export contract",
    );
  });
});
