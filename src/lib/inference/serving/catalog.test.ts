// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import catalogSchema from "../../../../managed-inference/schemas/catalog.schema.json" with {
  type: "json",
};
import presetSchema from "../../../../managed-inference/schemas/preset.schema.json" with {
  type: "json",
};
import recipeSchema from "../../../../managed-inference/schemas/recipe.schema.json" with {
  type: "json",
};
import {
  compileTrustedServingCatalog,
  parseCompiledServingCatalogJson,
  serializeCompiledServingCatalog,
} from "./catalog";
import type {
  ServingCatalogRegistries,
  ServingCatalogSchemas,
  ServingCatalogSource,
} from "./types";

const SOURCE_REVISION = "a".repeat(40);
const IMAGE_DIGEST = "b".repeat(64);
const MODEL_REVISION = "c".repeat(40);
const SCHEMAS: ServingCatalogSchemas = {
  catalog: catalogSchema,
  preset: presetSchema,
  recipe: recipeSchema,
};
const REGISTRIES: ServingCatalogRegistries = {
  receipts: new Set(["test.receipt/v1"]),
  materializers: new Set(["test.materializer/v1"]),
  lifecycles: new Set(["test.lifecycle/v1"]),
  readinessContracts: new Set(["test.readiness/v1"]),
  readiness: new Map([
    ["test.runtime.present", { kind: "capability" }],
    ["test.runtime.other", { kind: "capability" }],
    ["test.os", { kind: "observation", valueType: "string", role: "operating-system" }],
    ["test.architecture", { kind: "observation", valueType: "string", role: "architecture" }],
    [
      "test.container-runtime",
      { kind: "observation", valueType: "string", role: "container-runtime" },
    ],
    ["test.gpu-count", { kind: "observation", valueType: "number", role: "gpu-count" }],
    ["test.driver-version", { kind: "observation", valueType: "version", role: "driver-version" }],
    ["test.agent.qualified", { kind: "qualification" }],
  ]),
};

function recipeSource(
  id = "test.recipe.v1",
  overrides: { image?: string; execution?: string } = {},
): ServingCatalogSource {
  return {
    path: `managed-inference/recipes/test/${id}.yaml`,
    contents: `
apiVersion: nemoclaw.nvidia.com/managed-inference/v1
kind: ServingRecipe
metadata:
  id: ${id}
spec:
  backend: test
  model:
    id: test/model
    revision: ${MODEL_REVISION}
    servedName: test-model
    files:
      - path: model.gguf
        digest: sha256:${"d".repeat(64)}
  runtime:
    image: ${overrides.image ?? `registry.example/test/server@sha256:${IMAGE_DIGEST}`}
    architecture: amd64
  execution:
${overrides.execution ?? "    materializerRef: test.materializer/v1\n    lifecycleRef: test.lifecycle/v1"}
  serve:
    arguments:
      - name: --port
        value: 8081
  readiness:
    timeoutSeconds: 30
    expectedModel: test-model
`,
  };
}

function presetSource(
  id = "test.preset.auto",
  options: { priority?: number; recipeRef?: string; readinessId?: string } = {},
): ServingCatalogSource {
  return {
    path: `managed-inference/presets/test/${id}.yaml`,
    contents: `
apiVersion: nemoclaw.nvidia.com/managed-inference/v1
kind: ServingPreset
metadata:
  id: ${id}
spec:
  selection: automatic
  priority: ${options.priority ?? 100}
  requirements:
    all:
      - readiness:
          scope: everyNode
          kind: capability
          id: ${options.readinessId ?? "test.runtime.present"}
          state: present
  plan:
    backend: test
    recipeRef: ${options.recipeRef ?? "test.recipe.v1"}
`,
  };
}

function llamaCppRecipeSource(): ServingCatalogSource {
  return {
    path: "managed-inference/recipes/test/test.llama.recipe.yaml",
    contents: `
apiVersion: nemoclaw.nvidia.com/managed-inference/v1
kind: ServingRecipe
metadata:
  id: test.llama.recipe
spec:
  backend: install-llama-cpp
  providerId: llama-cpp-local
  server:
    technology: llama.cpp
    source:
      repository: test/llama.cpp
      revision: ${"e".repeat(40)}
  model:
    id: test/model
    revision: ${"f".repeat(40)}
    servedName: test-model
    files:
      - path: test-model.Q4_K_M.gguf
        digest: sha256:${"1".repeat(64)}
        sizeBytes: 4294967296
        format: gguf
        quantization: Q4_K_M
        license: Apache-2.0
    acquisition:
      ref: hugging-face-exact-file/v1
      authentication:
        mode: optional
        environment: HF_TOKEN
    cache:
      ref: llama-cpp.gguf-content-addressed/v1
      receiptRef: llama-cpp.gguf-cache-entry.receipt/v1
      root: user-cache
      quotaBytes: 6442450944
      stagingHeadroomBytes: 1073741824
      staging: same-filesystem
      publication: atomic-no-clobber
      reuse: verified-only-offline
      sharing: owner-only
      cleanup: receipt-owner-only
  runtime:
    image: registry.example/test/llama-server@sha256:${"2".repeat(64)}
    imageDownloadSizeBytes: 1073741824
    platforms:
      - linux/amd64
      - linux/arm64
    containerRuntime: docker
    networkExposure: loopback
    hosts: 1
    cuda:
      baseImage: registry.example/nvidia/cuda@sha256:${"3".repeat(64)}
      minimumDriverVersion: 570.0.0
    gpu:
      vendor: nvidia
      count: 1
      offload: full
      cpuFallback: reject
    resources:
      memoryBytes: 34359738368
      writableStorageBytes: 1073741824
      pidsLimit: 256
  execution:
    receiptRef: test.receipt/v1
    materializerRef: test.materializer/v1
    lifecycleRef: test.lifecycle/v1
  serve:
    protocol: openai-completions
    authentication: bearer
    port: 8081
    chatTemplate: test-chat
    contextSize: 32768
    slots: 1
    idleSleepSeconds: -1
    batchSize: 2048
    microBatchSize: 512
    flashAttention: enabled
    kvCache:
      key: f16
      value: f16
    speculativeDecoding: disabled
    limits:
      maxRequestBodyBytes: 1048576
      maxPromptTokens: 24576
      maxCompletionTokens: 8192
      requestTimeoutSeconds: 120
  readiness:
    contractRef: test.readiness/v1
    timeoutSeconds: 120
    expectedModel: test-model
    probes:
      models: true
      health: true
      properties: true
      metrics: true
  policy:
    egress: disabled
    modelSource: verified-local
    modelDownloads: disabled
  surfaces:
    ui: disabled
    slotInspection: disabled
    router: disabled
    mcpProxy: disabled
    serverTools: disabled
    agentMode: disabled
    multimodalProjection: disabled
  capabilities:
    agents: []
    protocols:
      - openai-completions
    streaming: true
    toolCalls: true
    structuredOutputs: true
    parallelToolCalls: false
    responsesApi: false
    embeddings: false
    reranking: false
    multimodal: false
`,
  };
}

function llamaCppPresetSource(selection = "explicit-only"): ServingCatalogSource {
  return {
    path: "managed-inference/presets/test/test.llama.preset.yaml",
    contents: `
apiVersion: nemoclaw.nvidia.com/managed-inference/v1
kind: ServingPreset
metadata:
  id: test.llama.preset
spec:
  selection: ${selection}
  priority: 100
  requirements:
    all:
      - readiness:
          scope: everyNode
          kind: observation
          id: test.os
          comparison:
            operator: equals
            value: linux
      - readiness:
          scope: everyNode
          kind: observation
          id: test.architecture
          comparison:
            operator: one-of
            values:
              - amd64
              - arm64
      - readiness:
          scope: everyNode
          kind: observation
          id: test.container-runtime
          comparison:
            operator: equals
            value: docker
      - readiness:
          scope: everyNode
          kind: observation
          id: test.gpu-count
          comparison:
            operator: at-least
            value: 1
      - readiness:
          scope: everyNode
          kind: observation
          id: test.driver-version
          comparison:
            operator: version-at-least
            value: 570.0.0
  plan:
    backend: install-llama-cpp
    recipeRef: test.llama.recipe
`,
  };
}

function replaceSource(
  source: ServingCatalogSource,
  expected: string | RegExp,
  replacement: string,
): ServingCatalogSource {
  const contents = source.contents.replace(expected, replacement);
  expect(contents).not.toBe(source.contents);
  return { ...source, contents };
}

function compile(sources: readonly ServingCatalogSource[], registries = REGISTRIES) {
  return compileTrustedServingCatalog({
    sources,
    sourceRevision: SOURCE_REVISION,
    schemas: SCHEMAS,
    registries,
  });
}

function requireValidationFailure(run: () => void, expectedMessage: string): void {
  expect(run).toThrow(expectedMessage);
}

describe("managed inference serving catalog compiler", () => {
  it("compiles managed-inference YAML to deterministic canonical JSON (#8144)", () => {
    const recipe = recipeSource();
    const preset = presetSource();

    const first = compile([recipe, preset]);
    const second = compile([preset, recipe]);

    expect(serializeCompiledServingCatalog(first)).toBe(serializeCompiledServingCatalog(second));
    expect(first.readinessSchemaRef).toBe(
      "https://github.com/NVIDIA/NemoClaw/schemas/system-readiness.schema.json",
    );
    expect(first.compilerVersion).toBe("1.2.0");
    expect(first.recipes.map((definition) => definition.metadata.id)).toEqual(["test.recipe.v1"]);
    expect(first.presets.map((definition) => definition.metadata.id)).toEqual(["test.preset.auto"]);
    expect(first.sources.map((source) => source.path)).toEqual([
      "managed-inference/presets/test/test.preset.auto.yaml",
      "managed-inference/recipes/test/test.recipe.v1.yaml",
    ]);
  });

  it("compiles a complete synthetic llama.cpp recipe and explicit-only preset (#8181)", () => {
    const recipe = llamaCppRecipeSource();
    const preset = llamaCppPresetSource();

    const first = compile([recipe, preset]);
    const second = compile([preset, recipe]);

    expect(serializeCompiledServingCatalog(first)).toBe(serializeCompiledServingCatalog(second));
    expect(first.recipes[0]?.spec).toMatchObject({
      providerId: "llama-cpp-local",
      server: { technology: "llama.cpp" },
      runtime: {
        imageDownloadSizeBytes: 1073741824,
        platforms: ["linux/amd64", "linux/arm64"],
        networkExposure: "loopback",
        gpu: { count: 1, cpuFallback: "reject" },
      },
      serve: {
        protocol: "openai-completions",
        authentication: "bearer",
        port: 8081,
        slots: 1,
        batchSize: 2048,
        microBatchSize: 512,
        flashAttention: "enabled",
        kvCache: { key: "f16", value: "f16" },
        speculativeDecoding: "disabled",
      },
      capabilities: { agents: [], protocols: ["openai-completions"] },
    });
    expect(first.presets[0]?.spec.selection).toBe("explicit-only");
    expect(first.sources.every((source) => /^sha256:[0-9a-f]{64}$/.test(source.digest))).toBe(true);
    expect(first.catalogDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it.each([
    ["a missing server source revision", `      revision: ${"e".repeat(40)}\n`, ""],
    [
      "a mutable server source revision",
      `      revision: ${"e".repeat(40)}`,
      "      revision: main",
    ],
    ["a mutable model revision", `    revision: ${"f".repeat(40)}`, "    revision: latest"],
    ["a missing GGUF digest", `        digest: sha256:${"1".repeat(64)}\n`, ""],
    ["a missing GGUF byte size", "        sizeBytes: 4294967296\n", ""],
    ["a non-GGUF file", "      - path: test-model.Q4_K_M.gguf", "      - path: model.bin"],
    [
      "an unsupported acquisition transport",
      "      ref: hugging-face-exact-file/v1",
      "      ref: arbitrary-url/v1",
    ],
    ["a required acquisition credential", "        mode: optional", "        mode: required"],
    [
      "an arbitrary acquisition endpoint",
      "      ref: hugging-face-exact-file/v1",
      "      ref: hugging-face-exact-file/v1\n      endpoint: https://example.test/model.gguf",
    ],
    [
      "an embedded acquisition credential",
      "        environment: HF_TOKEN",
      "        environment: HF_TOKEN\n        token: test-secret",
    ],
    ["a shared cache owner", "      sharing: owner-only", "      sharing: host-user"],
    [
      "cross-filesystem staging",
      "      staging: same-filesystem",
      "      staging: system-temporary",
    ],
    [
      "clobbering cache publication",
      "      publication: atomic-no-clobber",
      "      publication: replace-existing",
    ],
    ["unverified cache reuse", "      reuse: verified-only-offline", "      reuse: trust-existing"],
    [
      "a mutable server image",
      `    image: registry.example/test/llama-server@sha256:${"2".repeat(64)}`,
      "    image: registry.example/test/llama-server:latest",
    ],
    [
      "a mutable CUDA base image",
      `      baseImage: registry.example/nvidia/cuda@sha256:${"3".repeat(64)}`,
      "      baseImage: registry.example/nvidia/cuda:12.8",
    ],
    ["incomplete platform coverage", "      - linux/arm64\n", ""],
    ["a missing image byte size", "    imageDownloadSizeBytes: 1073741824\n", ""],
    ["missing process limits", "      pidsLimit: 256\n", ""],
    [
      "an embedded credential",
      `      revision: ${"e".repeat(40)}`,
      `      revision: ${"e".repeat(40)}\n      credential: test-secret`,
    ],
    ["a host model path", "      - path: test-model.Q4_K_M.gguf", "      - path: /tmp/model.gguf"],
    ["shell syntax", "    chatTemplate: test-chat", "    chatTemplate: $(id)"],
    ["environment expansion", "    chatTemplate: test-chat", "    chatTemplate: \${HOME}"],
    [
      "an unsupported protocol",
      "    protocol: openai-completions",
      "    protocol: openai-responses",
    ],
    ["CPU fallback", "      cpuFallback: reject", "      cpuFallback: allow"],
    ["external network exposure", "    networkExposure: loopback", "    networkExposure: lan"],
    ["missing authentication", "    authentication: bearer\n", ""],
    ["an unsafe KV cache type", "      key: f16", "      key: q4_0"],
    ["disabled flash attention", "    flashAttention: enabled", "    flashAttention: disabled"],
    [
      "enabled speculative decoding",
      "    speculativeDecoding: disabled",
      "    speculativeDecoding: enabled",
    ],
    ["server egress", "    egress: disabled", "    egress: enabled"],
    ["a remote model source", "    modelSource: verified-local", "    modelSource: remote"],
    [
      "an arbitrary launch argument",
      "    protocol: openai-completions",
      "    protocol: openai-completions\n    arguments:\n      - name: --unsafe",
    ],
    ["an unsupported capability", "    responsesApi: false", "    responsesApi: true"],
    ["a malformed agent qualification", "    agents: []", "    agents: [openclaw]"],
    ["a path-based served model name", "    servedName: test-model", "    servedName: test/model"],
  ])("rejects %s in a llama.cpp recipe (#8181)", (_case, expected, replacement) => {
    const recipe = replaceSource(llamaCppRecipeSource(), expected, replacement);

    expect(() => compile([recipe])).toThrow("does not satisfy the ServingRecipe schema");
  });

  it.each([
    [
      "top-level topology bindings",
      "  backend: install-llama-cpp",
      `  backend: install-llama-cpp
  bindings:
    cluster:
      type: topologyQualificationOutput
      qualificationId: test.qualification
      schemaVersion: 1
      outputSchema: test.output`,
    ],
    [
      "managed model preparation",
      "    servedName: test-model",
      `    servedName: test-model
    preparation:
      ref: none/v1`,
    ],
    [
      "managed runtime networking",
      "    networkExposure: loopback",
      `    networkExposure: loopback
    networkMode: host`,
    ],
    [
      "managed cluster execution sizing",
      "    receiptRef: test.receipt/v1",
      `    receiptRef: test.receipt/v1
    nodeCount: 1`,
    ],
    [
      "an executable override",
      "    authentication: bearer",
      `    authentication: bearer
    executable: /usr/local/bin/llama-server`,
    ],
  ])("rejects generic-only %s in a llama.cpp recipe (#8173)", (_case, expected, replacement) => {
    const recipe = replaceSource(llamaCppRecipeSource(), expected, replacement);

    expect(() => compile([recipe])).toThrow("does not satisfy the ServingRecipe schema");
  });

  it.each([
    [
      "acquisition",
      `    revision: ${MODEL_REVISION}`,
      `    revision: ${MODEL_REVISION}
    acquisition:
      ref: hugging-face-exact-file/v1
      authentication:
        mode: optional
        environment: HF_TOKEN`,
    ],
    [
      "cache",
      `    revision: ${MODEL_REVISION}`,
      `    revision: ${MODEL_REVISION}
    cache:
      ref: llama-cpp.gguf-content-addressed/v1
      receiptRef: llama-cpp.gguf-cache-entry.receipt/v1
      root: user-cache
      quotaBytes: 2048
      stagingHeadroomBytes: 1024
      staging: same-filesystem
      publication: atomic-no-clobber
      reuse: verified-only-offline
      sharing: owner-only
      cleanup: receipt-owner-only`,
    ],
  ])("rejects llama.cpp model %s on a generic recipe (#8279)", (_field, expected, replacement) => {
    const recipe = replaceSource(recipeSource(), expected, replacement);

    expect(() => compile([recipe])).toThrow("does not satisfy the ServingRecipe schema");
  });

  it("rejects a llama.cpp readiness model that differs from the served name (#8181)", () => {
    const wrongExpectedModel = replaceSource(
      llamaCppRecipeSource(),
      "    expectedModel: test-model",
      "    expectedModel: other-model",
    );

    expect(() => compile([wrongExpectedModel])).toThrow(
      "readiness expectedModel must match model servedName",
    );
  });

  it("rejects llama.cpp request token limits that exceed serve.contextSize (#8181)", () => {
    const excessiveTokenLimits = replaceSource(
      llamaCppRecipeSource(),
      "      maxCompletionTokens: 8192",
      "      maxCompletionTokens: 8193",
    );

    expect(() => compile([excessiveTokenLimits])).toThrow(
      "request token limits exceed serve.contextSize",
    );
  });

  it("rejects a llama.cpp micro-batch larger than its batch (#8173)", () => {
    const invalidBatching = replaceSource(
      llamaCppRecipeSource(),
      "    microBatchSize: 512",
      "    microBatchSize: 4096",
    );

    expect(() => compile([invalidBatching])).toThrow(
      "serve.microBatchSize cannot exceed serve.batchSize",
    );
  });

  it("rejects a llama.cpp cache quota below the file size and staging headroom (#8279)", () => {
    const insufficientQuota = replaceSource(
      llamaCppRecipeSource(),
      "      quotaBytes: 6442450944",
      "      quotaBytes: 5368709119",
    );

    expect(() => compile([insufficientQuota])).toThrow(
      "cache quota must be at least 5368709120 bytes",
    );
  });

  it.each([
    ["a backend that does not match llama.cpp", "  backend: install-llama-cpp", "  backend: vllm"],
    [
      "a GGUF byte size above Number.MAX_SAFE_INTEGER",
      "        sizeBytes: 4294967296",
      "        sizeBytes: 9007199254740992",
    ],
  ])("rejects %s in the typed llama.cpp contract (#8181)", (_case, expected, replacement) => {
    const recipe = replaceSource(llamaCppRecipeSource(), expected, replacement);

    expect(() => compile([recipe])).toThrow("does not satisfy the ServingRecipe schema");
  });

  it("reserves the install-llama-cpp backend for typed llama.cpp recipes (#8181)", () => {
    const escapedRecipe = replaceSource(
      recipeSource(),
      "  backend: test",
      "  backend: install-llama-cpp",
    );

    expect(() => compile([escapedRecipe])).toThrow("does not satisfy the ServingRecipe schema");
  });

  it.each([
    ["receipt contract", { receipts: new Set<string>() }, "unknown receipt contract"],
    ["materializer", { materializers: new Set<string>() }, "unknown materializer"],
    ["lifecycle adapter", { lifecycles: new Set<string>() }, "unknown lifecycle adapter"],
    ["readiness contract", { readinessContracts: new Set<string>() }, "unknown readiness contract"],
  ])("rejects a llama.cpp recipe with an unknown %s reference (#8181)", (_name, registry, message) => {
    expect(() => compile([llamaCppRecipeSource()], { ...REGISTRIES, ...registry })).toThrow(
      message,
    );
  });

  it("validates optional receipt and readiness contracts on generic recipes (#8181)", () => {
    const receiptRecipe = recipeSource("test.recipe.receipt", {
      execution:
        "    receiptRef: test.receipt/v1\n    materializerRef: test.materializer/v1\n    lifecycleRef: test.lifecycle/v1",
    });
    const readinessRecipe = replaceSource(
      recipeSource("test.recipe.readiness"),
      "  readiness:\n",
      "  readiness:\n    contractRef: test.readiness/v1\n",
    );

    expect(() => compile([receiptRecipe], { ...REGISTRIES, receipts: new Set() })).toThrow(
      "unknown receipt contract test.receipt/v1",
    );
    expect(() =>
      compile([readinessRecipe], { ...REGISTRIES, readinessContracts: new Set() }),
    ).toThrow("unknown readiness contract test.readiness/v1");
  });

  it("rejects automatic selection for a llama.cpp recipe (#8181)", () => {
    expect(() => compile([llamaCppRecipeSource(), llamaCppPresetSource("automatic")])).toThrow(
      "must use explicit-only selection for llama.cpp recipe",
    );
  });

  it("requires readiness requirements for an explicit llama.cpp preset (#8181)", () => {
    const presetWithoutReadiness = replaceSource(
      llamaCppPresetSource(),
      /  requirements:[\s\S]*?  plan:/u,
      "  plan:",
    );

    expect(() => compile([llamaCppRecipeSource(), presetWithoutReadiness])).toThrow(
      "must declare readiness requirements for llama.cpp recipe",
    );
  });

  it("allows an explicit llama.cpp preset to narrow a multiarch image to arm64 (#8173)", () => {
    const arm64Preset = replaceSource(
      llamaCppPresetSource(),
      "            operator: one-of\n            values:\n              - amd64\n              - arm64",
      "            operator: equals\n            value: arm64",
    );

    expect(() => compile([llamaCppRecipeSource(), arm64Preset])).not.toThrow();
  });

  it.each([
    ["operating-system", "            value: linux", "            value: windows"],
    ["architecture", "              - arm64", "              - riscv64"],
    ["container-runtime", "            value: docker", "            value: podman"],
    ["gpu-count", "            value: 1", "            value: 0"],
    ["driver-version", "            value: 570.0.0", "            value: 1.0.0"],
  ])("rejects a llama.cpp preset whose %s contradicts its recipe (#8181)", (role, expected, replacement) => {
    const preset = replaceSource(llamaCppPresetSource(), expected, replacement);

    expect(() => compile([llamaCppRecipeSource(), preset])).toThrow(
      `must require ${role} matching llama.cpp recipe`,
    );
  });

  it.each([
    ["shell syntax", "$(id)"],
    ["environment expansion", "${HOME}"],
    ["an absolute path", "/tmp/model.gguf"],
  ])("rejects %s in a readiness comparison string (#8181)", (_case, value) => {
    const preset = replaceSource(
      llamaCppPresetSource(),
      "            value: linux",
      `            value: ${value}`,
    );

    expect(() => compile([llamaCppRecipeSource(), preset])).toThrow(
      "does not satisfy the ServingPreset schema",
    );
  });

  it("rejects a negative readiness threshold (#8181)", () => {
    const preset = replaceSource(
      llamaCppPresetSource(),
      "            value: 1",
      "            value: -1",
    );

    expect(() => compile([llamaCppRecipeSource(), preset])).toThrow(
      "does not satisfy the ServingPreset schema",
    );
  });

  it("requires declared llama.cpp agents to reference a qualification entity (#8181)", () => {
    const declaredAgent = replaceSource(
      llamaCppRecipeSource(),
      "    agents: []",
      "    agents:\n      - id: test.agent\n        qualificationRef: test.agent.qualified",
    );
    const unknownQualification = replaceSource(
      declaredAgent,
      "        qualificationRef: test.agent.qualified",
      "        qualificationRef: test.agent.unknown",
    );

    expect(() => compile([declaredAgent])).not.toThrow();
    expect(() => compile([unknownQualification])).toThrow(
      "references unknown agent qualification test.agent.unknown for test.agent",
    );
  });

  it("gates declared llama.cpp agents on preset qualification readiness (#8181)", () => {
    const declaredAgent = replaceSource(
      llamaCppRecipeSource(),
      "    agents: []",
      "    agents:\n      - id: test.agent\n        qualificationRef: test.agent.qualified",
    );
    const preset = llamaCppPresetSource();
    const qualifiedPreset = replaceSource(
      preset,
      "  plan:\n",
      `      - readiness:
          scope: everyNode
          kind: qualification
          id: test.agent.qualified
          status: qualified
  plan:
`,
    );

    expect(() => compile([declaredAgent, preset])).toThrow(
      "must require qualified status for test.agent.qualified",
    );
    expect(() => compile([declaredAgent, qualifiedPreset])).not.toThrow();
  });

  it("rejects duplicate llama.cpp agent capability declarations (#8181)", () => {
    const duplicateAgent = replaceSource(
      llamaCppRecipeSource(),
      "    agents: []",
      `    agents:
      - id: test.agent
        qualificationRef: test.agent.qualified
      - id: test.agent
        qualificationRef: test.other.qualified`,
    );

    expect(() => compile([duplicateAgent])).toThrow("repeats agent capability test.agent");
  });

  it("rejects duplicate and contradictory readiness requirements (#8181)", () => {
    const repeatedRequirement = `      - readiness:
          scope: everyNode
          kind: observation
          id: test.os
          comparison:
            operator: equals
            value: linux
`;
    const duplicate = replaceSource(
      llamaCppPresetSource(),
      "  plan:\n",
      `${repeatedRequirement}  plan:\n`,
    );
    const contradiction = replaceSource(
      duplicate,
      "            value: linux\n  plan:",
      "            value: windows\n  plan:",
    );

    expect(() => compile([llamaCppRecipeSource(), duplicate])).toThrow(
      "repeats readiness requirement",
    );
    expect(() => compile([llamaCppRecipeSource(), contradiction])).toThrow(
      "has contradictory readiness requirements",
    );
  });

  it("rejects a readiness comparison whose value type conflicts with its registry entry (#8181)", () => {
    const readiness = new Map(REGISTRIES.readiness);
    readiness.set("test.gpu-count", { kind: "observation", valueType: "string" });

    expect(() =>
      compile([llamaCppRecipeSource(), llamaCppPresetSource()], { ...REGISTRIES, readiness }),
    ).toThrow("compares test.gpu-count as number, but the readiness registry declares string");
  });

  it("rejects duplicate definition IDs and dangling recipe references (#8144)", () => {
    const duplicate = {
      ...recipeSource(),
      path: "managed-inference/recipes/test/duplicate.yaml",
    };
    expect(() => compile([recipeSource(), duplicate])).toThrow("ID test.recipe.v1 is duplicated");
    expect(() =>
      compile([
        recipeSource(),
        presetSource("test.preset.missing", {
          recipeRef: "test.recipe.missing",
        }),
      ]),
    ).toThrow("references unknown recipe test.recipe.missing");
  });

  it("rejects executable fields and mutable artifact references (#8144)", () => {
    expect(() =>
      compile([
        recipeSource("test.recipe.shell", {
          execution:
            "    materializerRef: test.materializer/v1\n    lifecycleRef: test.lifecycle/v1\n    command: sh -c server",
        }),
      ]),
    ).toThrow("does not satisfy the ServingRecipe schema");
    expect(() =>
      compile([
        recipeSource("test.recipe.mutable", {
          image: "registry.example/test/server:latest",
        }),
      ]),
    ).toThrow("does not satisfy the ServingRecipe schema");
  });

  it("accepts only exact immutable model revision forms (#8144)", () => {
    for (const revision of ["e".repeat(40), "e".repeat(64), `sha256:${"e".repeat(64)}`]) {
      expect(() =>
        compile([
          replaceSource(recipeSource(), `revision: ${MODEL_REVISION}`, `revision: ${revision}`),
        ]),
      ).not.toThrow();
    }
    for (const revision of ["e".repeat(41), "e".repeat(63)]) {
      expect(() =>
        compile([
          replaceSource(recipeSource(), `revision: ${MODEL_REVISION}`, `revision: ${revision}`),
        ]),
      ).toThrow("does not satisfy the ServingRecipe schema");
    }
  });

  it("rejects duplicate source paths and YAML aliases (#8144)", () => {
    const duplicatePath = { ...presetSource(), path: recipeSource().path };
    expect(() => compile([recipeSource(), duplicatePath])).toThrow(
      `Catalog source path ${recipeSource().path} is duplicated`,
    );

    const recipe = recipeSource("test.recipe.alias");
    const aliasedRecipe = {
      ...recipe,
      contents: recipe.contents
        .replace("id: test/model", "id: &model-id test/model")
        .replace("servedName: test-model", "servedName: *model-id"),
    };
    expect(() => compile([aliasedRecipe])).toThrow("cannot use YAML aliases");
  });

  it("rejects duplicate structured arguments and model files (#8144)", () => {
    const duplicateArgument = replaceSource(
      recipeSource("test.recipe.duplicate-argument"),
      "      - name: --port\n        value: 8081",
      "      - name: --port\n        value: 8081\n      - name: --port\n        value: 8082",
    );
    expect(() => compile([duplicateArgument])).toThrow("repeats structured argument --port");

    const duplicateModelFile = replaceSource(
      recipeSource("test.recipe.duplicate-model-file"),
      `      - path: model.gguf\n        digest: sha256:${"d".repeat(64)}`,
      `      - path: model.gguf\n        digest: sha256:${"d".repeat(64)}\n      - path: model.gguf\n        digest: sha256:${"e".repeat(64)}`,
    );
    expect(() => compile([duplicateModelFile])).toThrow("repeats model file model.gguf");

    for (const path of [
      "./model.gguf",
      "models//model.gguf",
      "models/./model.gguf",
      "models/",
      "models\\model.gguf",
      "C:\\model.gguf",
    ]) {
      expect(() =>
        compile([replaceSource(recipeSource(), "path: model.gguf", `path: ${path}`)]),
      ).toThrow("does not satisfy the ServingRecipe schema");
    }
  });

  it("rejects adapter and readiness IDs outside the injected registries (#8144)", () => {
    expect(() =>
      compile([recipeSource()], {
        ...REGISTRIES,
        materializers: new Set(),
      }),
    ).toThrow("references unknown materializer test.materializer/v1");
    expect(() =>
      compile([
        recipeSource(),
        presetSource("test.preset.unknown", {
          readinessId: "test.readiness.unknown",
        }),
      ]),
    ).toThrow("references unknown readiness entity test.readiness.unknown");

    const mismatchedKind = presetSource("test.preset.kind-mismatch");
    expect(() =>
      compile([
        recipeSource(),
        {
          ...mismatchedKind,
          contents: mismatchedKind.contents.replace("kind: capability", "kind: observation"),
        },
      ]),
    ).toThrow(
      "uses test.runtime.present as observation, but the readiness registry declares capability",
    );
  });

  it("rejects duplicate automatic selectors at one priority (#8144)", () => {
    expect(() =>
      compile([
        recipeSource(),
        presetSource(),
        presetSource("test.preset.other", { priority: 100 }),
      ]),
    ).toThrow("have the same selector at priority 100 for backend test");
  });

  it("accepts disjoint automatic selectors at one priority (#8144)", () => {
    const catalog = compile([
      recipeSource(),
      presetSource(),
      presetSource("test.preset.other", {
        priority: 100,
        readinessId: "test.runtime.other",
      }),
    ]);

    expect(catalog.presets.map((preset) => preset.metadata.id)).toEqual([
      "test.preset.auto",
      "test.preset.other",
    ]);
  });

  it("accepts only compiled JSON whose digest matches its content (#8144)", () => {
    const serialized = serializeCompiledServingCatalog(compile([recipeSource(), presetSource()]));
    const parsed = parseCompiledServingCatalogJson(serialized, SCHEMAS);
    const tampered = serialized.replace("test/model", "test/other-model");
    requireValidationFailure(
      () => parseCompiledServingCatalogJson(tampered, SCHEMAS),
      "digest mismatch",
    );
    requireValidationFailure(
      () => parseCompiledServingCatalogJson("apiVersion: v1", SCHEMAS),
      "is not valid JSON",
    );

    expect(parsed.catalogDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
