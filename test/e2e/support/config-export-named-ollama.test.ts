// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parseConfigExport } from "../fixtures/phases/config-export-validation.ts";

const NAMED_OLLAMA_EXPORT = {
  apiVersion: "nemoclaw.nvidia.com/v1alpha1",
  kind: "NemoClawConfig",
  metadata: { name: "attached-ollama", uid: "123e4567-e89b-42d3-a456-426614174000" },
  spec: {
    gateway: {
      management: "managed",
      endpoint: "http://127.0.0.1:17681",
      networkCIDR: "172.30.50.0/24",
    },
    services: {
      "ollama-auth": {
        kind: "ollamaProxy",
        image: null,
        endpoint: "http://172.30.50.1:11440/v1",
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

const NAMED_VLLM_EXPORT = {
  ...NAMED_OLLAMA_EXPORT,
  spec: {
    ...NAMED_OLLAMA_EXPORT.spec,
    services: {
      vllm: {
        kind: "vllm",
        authentication: "bearer",
        hardware: {
          architecture: "amd64",
          minComputeCapability: 90,
          minGpuMemoryBytes: 96_000_000_000,
          minDriverMajor: 580,
        },
        container: { ipc: "host", sharedMemoryGiB: 32 },
        image: null,
        model: {
          repository: "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4",
          revision: "0dcd680e5585c791728c83342b311d0a0026dbeb",
        },
        serving: {
          modelName: "nvidia-nemotron-3.5-lightning-30b-a3b-nvfp4",
          mambaBackend: "flashinfer",
          enforceEager: false,
          toolParser: "qwen3_coder",
          reasoningParser: "nemotron_v3",
          port: 18_000,
          contextTokens: 65_536,
          maxSequences: 1,
          batchTokens: 4096,
          startupTimeoutSeconds: 1800,
        },
        memory: { gpuMemoryUtilization: 0.75 },
      },
    },
    inferenceProviders: [
      {
        name: "managed-vllm",
        provider: "openai",
        api: "openai-completions",
        serviceRef: "vllm",
      },
    ],
    sandboxes: NAMED_OLLAMA_EXPORT.spec.sandboxes.map((sandbox) => ({
      ...sandbox,
      agent: {
        ...sandbox.agent,
        inference: {
          routes: [
            {
              name: "primary",
              providerRef: "managed-vllm",
              overrides: { model: "nvidia-nemotron-3.5-lightning-30b-a3b-nvfp4" },
            },
          ],
        },
      },
    })),
  },
};

describe("named Ollama proxy export schema", () => {
  it("accepts the v1alpha1 named service document (#12012)", () => {
    expect(parseConfigExport(JSON.stringify(NAMED_OLLAMA_EXPORT))).toMatchObject({
      spec: {
        inferenceProviders: [{ serviceRef: "ollama-auth" }],
        services: {
          "ollama-auth": {
            image: null,
            endpoint: "http://172.30.50.1:11440/v1",
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

describe("named vLLM export schema", () => {
  it("accepts the null-image current-v1 service template (#12012)", () => {
    expect(parseConfigExport(JSON.stringify(NAMED_VLLM_EXPORT))).toMatchObject({
      spec: {
        inferenceProviders: [{ serviceRef: "vllm" }],
        services: {
          vllm: {
            kind: "vllm",
            image: null,
            serving: {
              modelName: "nvidia-nemotron-3.5-lightning-30b-a3b-nvfp4",
              contextTokens: 65_536,
            },
          },
        },
      },
    });
  });
});
