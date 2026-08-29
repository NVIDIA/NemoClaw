// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import catalogSchema from "../../../managed-inference/schemas/catalog.schema.json" with { type: "json" };
import modelSchema from "../../../managed-inference/schemas/model.schema.json" with { type: "json" };
import presetSchema from "../../../managed-inference/schemas/preset.schema.json" with { type: "json" };
import recipeSchema from "../../../managed-inference/schemas/recipe.schema.json" with { type: "json" };
import { getManagedInferenceServingCatalogRegistries } from "../../../src/lib/inference/serving/adapter-registry.js";
import { compileTrustedServingCatalog } from "../../../src/lib/inference/serving/catalog.js";
import type { ServingCatalogSource } from "../../../src/lib/inference/serving/types.js";

const REPOSITORY_ROOT = path.join(import.meta.dirname, "../../..");
const PROFILE_ID = "vllm.dgx-spark-gb10.dual.deepseek-v4-flash-0731";
const RECIPE_ID = "vllm.deepseek-v4-flash-0731.spark-dual.v1";
const LLAMA_CPP_PROFILE_ID = "llama-cpp.dgx-spark-gb10.single.nemotron-3-nano-30b-a3b";
const LLAMA_CPP_RECIPE_ID = "llama-cpp.nemotron-3-nano-30b-a3b.spark-single.v1";
const LLAMA_CPP_IMAGE =
  "ghcr.io/nvidia/nemoclaw/llama-cpp-server@sha256:9d0cddd7bcaf98d3b75a7fc8c7ce3af3a9973b5f23a8092e7e93a9afc473a675";
const LLAMA_CPP_IMAGE_DOWNLOAD_SIZE_BYTES = 1_827_478_485;
const LLAMA_CPP_MODEL_DIGEST =
  "sha256:627f5b04aedc97f967332f331bd75b7a4ed2f33ca83e6ee74b44235cc1887890";
const MUSE_LLAMA_CPP_PROFILE_ID = "llama-cpp.dgx-spark-gb10.single.muse-glimmer-30b";
const MUSE_LLAMA_CPP_RECIPE_ID = "llama-cpp.muse-glimmer-30b.spark-single.v1";
const MUSE_LLAMA_CPP_MODEL_DIGEST =
  "sha256:4cc57c0f51040a226e5a72cc47b7613f7772950e460a665f7083de89f183f60e";
const LIGHTNING_PROFILE_ID = "vllm.dgx-spark-gb10.single.nemotron-3.5-lightning-30b-a3b-nvfp4";
const LIGHTNING_RECIPE_ID = "vllm.nemotron-3.5-lightning-30b-a3b-nvfp4.spark-single.v1";
const MUSE_PROFILE_ID = "vllm.dgx-spark-gb10.single.muse-glimmer-30b-nvfp4-w4a4";
const MUSE_RECIPE_ID = "vllm.muse-glimmer-30b-nvfp4-w4a4.spark-single.v1";
const LINUX_VLLM_PROFILES = [
  {
    presetId: "vllm.linux-amd64-nvidia.single.muse-glimmer-30b-nvfp4-w4a4",
    recipeId: "vllm.muse-glimmer-30b-nvfp4-w4a4.linux-amd64-single.v1",
  },
  {
    presetId: "vllm.linux-amd64-nvidia.single.nemotron-3.5-lightning-30b-a3b-nvfp4",
    recipeId: "vllm.nemotron-3.5-lightning-30b-a3b-nvfp4.linux-amd64-single.v1",
  },
] as const;

function catalogSources(): ServingCatalogSource[] {
  return (["models", "presets", "recipes"] as const).flatMap((kind) => {
    const directory = path.join(REPOSITORY_ROOT, "managed-inference", kind);
    return readdirSync(directory)
      .filter((name) => name.endsWith(".yaml"))
      .map((name) => ({
        path: `managed-inference/${kind}/${name}`,
        contents: readFileSync(path.join(directory, name), "utf8"),
      }));
  });
}

function compile(sources: readonly ServingCatalogSource[]) {
  return compileTrustedServingCatalog({
    sources,
    sourceRevision: "a".repeat(40),
    schemas: {
      catalog: catalogSchema,
      model: modelSchema,
      preset: presetSchema,
      recipe: recipeSchema,
    },
    registries: getManagedInferenceServingCatalogRegistries(),
  });
}

describe("managed inference YAML profile contract", () => {
  it.each([
    ["vllm.qwen3-6-27b-fp8.linux-amd64-single.v1", 48_000_000_000, 0.7, 30_900_000_000],
    ["vllm.qwen3-6-27b-fp8.linux-arm64-single.v1", 48_000_000_000, 0.7, 30_900_000_000],
    ["vllm.qwen3-6-27b-fp8.optimized-arm64-single.v1", 48_000_000_000, 0.7, 30_900_000_000],
    ["vllm.qwen3-6-35b-a3b-nvfp4.spark-single.v1", 64_000_000_000, 0.4, 23_500_000_000],
    [
      "vllm.muse-glimmer-30b-nvfp4-w4a4.linux-amd64-single.v1",
      96_000_000_000,
      0.75,
      25_447_097_878,
    ],
    [
      "vllm.nemotron-3.5-lightning-30b-a3b-nvfp4.linux-amd64-single.v1",
      96_000_000_000,
      0.75,
      21_561_882_284,
    ],
  ])(
    "reserves model-weight headroom within the %s GPU utilization budget",
    (recipeId, minimumGpuMemoryBytes, utilization, downloadSizeBytes) => {
      const recipe = compile(catalogSources()).recipes.find(
        ({ metadata }) => metadata.id === recipeId,
      );

      expect(recipe?.spec).toMatchObject({
        model: { downloadSizeBytes },
        runtime: { minimumGpuMemoryBytes },
        serve: {
          arguments: expect.arrayContaining([
            { name: "--gpu-memory-utilization", value: utilization },
          ]),
        },
      });
      expect(minimumGpuMemoryBytes * utilization).toBeGreaterThan(downloadSizeBytes * 1.05);
    },
  );

  it("compiles the shipped managed-cluster profile through the canonical catalog (#8129)", () => {
    const catalog = compile(catalogSources());
    const preset = catalog.presets.find(({ metadata }) => metadata.id === PROFILE_ID);
    const recipe = catalog.recipes.find(({ metadata }) => metadata.id === RECIPE_ID);

    expect(preset?.spec.plan.recipeRef).toBe(RECIPE_ID);
    expect(recipe?.spec.execution.nodeCount).toBe(2);
    expect(preset?.spec.requirements?.all).toContainEqual({
      fact: "cluster.nodeCount",
      state: "present",
      operator: "equals",
      value: 2,
    });
  });

  it("accepts another compatible profile as YAML-only catalog additions (#8129)", () => {
    const sources = catalogSources();
    const recipeSource = sources.find(({ contents }) => contents.includes(`id: ${RECIPE_ID}`))!;
    const presetSource = sources.find(({ contents }) => contents.includes(`id: ${PROFILE_ID}`))!;
    const syntheticRecipeId = "vllm.synthetic.managed-cluster.v1";
    const syntheticPresetId = "vllm.synthetic.managed-cluster";
    const catalog = compile([
      ...sources,
      {
        path: "managed-inference/recipes/vllm.synthetic.managed-cluster.v1.yaml",
        contents: recipeSource.contents.replace(RECIPE_ID, syntheticRecipeId),
      },
      {
        path: "managed-inference/presets/vllm.synthetic.managed-cluster.yaml",
        contents: presetSource.contents
          .replace(PROFILE_ID, syntheticPresetId)
          .replace(RECIPE_ID, syntheticRecipeId)
          .replace("priority: 400", "priority: 399"),
      },
    ]);

    expect(catalog.recipes.some(({ metadata }) => metadata.id === syntheticRecipeId)).toBe(true);
    expect(catalog.presets.some(({ metadata }) => metadata.id === syntheticPresetId)).toBe(true);
  });

  it("compiles the automatic DGX Spark llama.cpp profile from YAML", () => {
    const catalog = compile(catalogSources());
    const preset = catalog.presets.find(({ metadata }) => metadata.id === LLAMA_CPP_PROFILE_ID);
    const recipe = catalog.recipes.find(({ metadata }) => metadata.id === LLAMA_CPP_RECIPE_ID);

    expect(preset?.spec).toMatchObject({
      selection: "automatic",
      plan: { backend: "install-llama-cpp", recipeRef: LLAMA_CPP_RECIPE_ID },
    });
    expect(preset?.spec.requirements?.all).toContainEqual({
      readiness: {
        scope: "everyNode",
        kind: "observation",
        id: "host.os.architecture",
        comparison: { operator: "equals", value: "arm64" },
      },
    });
    expect(recipe?.spec).toMatchObject({
      backend: "install-llama-cpp",
      providerId: "llama-cpp-local",
      model: {
        servedName: "nvidia-nemotron-3-nano-30b-a3b",
        files: [{ digest: LLAMA_CPP_MODEL_DIGEST, sizeBytes: 22833947424 }],
        acquisition: {
          ref: "hugging-face-exact-file/v1",
          authentication: { mode: "optional", environment: "HF_TOKEN" },
        },
        cache: {
          ref: "hugging-face-shared-cache/v1",
          root: "user-cache",
          reuse: "verify-exact-file",
          sharing: "host-user",
          cleanup: "preserve",
        },
      },
      runtime: {
        image: LLAMA_CPP_IMAGE,
        imageDownloadSizeBytes: LLAMA_CPP_IMAGE_DOWNLOAD_SIZE_BYTES,
        networkExposure: "loopback",
      },
      serve: {
        authentication: "bearer",
        contextSize: 262144,
        limits: { maxRequestBodyBytes: 32768 },
        batchSize: 2048,
        microBatchSize: 512,
        flashAttention: "enabled",
        kvCache: { key: "f16", value: "f16" },
        speculativeDecoding: "disabled",
      },
    });
  });

  it("compiles Muse Glimmer as an explicit-only Experimental DGX Spark llama.cpp profile (#10239)", () => {
    const catalog = compile(catalogSources());
    const preset = catalog.presets.find(
      ({ metadata }) => metadata.id === MUSE_LLAMA_CPP_PROFILE_ID,
    );
    const recipe = catalog.recipes.find(
      ({ metadata }) => metadata.id === MUSE_LLAMA_CPP_RECIPE_ID,
    );

    expect(preset?.metadata.supportState).toBe("experimental");
    expect(preset?.spec).toMatchObject({
      selection: "explicit-only",
      priority: 500,
      plan: { backend: "install-llama-cpp", recipeRef: MUSE_LLAMA_CPP_RECIPE_ID },
    });
    expect(recipe?.spec).toMatchObject({
      backend: "install-llama-cpp",
      providerId: "llama-cpp-local",
      server: {
        technology: "llama.cpp",
        source: { revision: "8e7f22b67ef4667b4ddd50230771287f328cfb3f" },
      },
      model: {
        id: "meta-models/Muse-Glimmer-30B-GGUF",
        revision: "43c7eadd41352a299ea8e0a36b3157978dd63596",
        servedName: "muse-glimmer",
        files: [
          {
            path: "Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf",
            digest: MUSE_LLAMA_CPP_MODEL_DIGEST,
            sizeBytes: 16756683904,
          },
        ],
      },
      runtime: {
        image: LLAMA_CPP_IMAGE,
        imageDownloadSizeBytes: LLAMA_CPP_IMAGE_DOWNLOAD_SIZE_BYTES,
        platforms: ["linux/amd64", "linux/arm64"],
        cuda: {
          baseImage:
            "docker.io/nvidia/cuda@sha256:789e629e49401647e22b7054ae9c6c4f6427dba68010ba428deb4cc6b063676e",
        },
      },
      serve: {
        chatTemplate: "model-embedded-jinja",
        chatTemplateArguments: { reasoningStrength: "low" },
        contextSize: 131072,
        limits: { maxRequestBodyBytes: 16384 },
        slots: 1,
        speculativeDecoding: "disabled",
      },
      surfaces: { multimodalProjection: "disabled" },
      capabilities: { toolCalls: true, multimodal: false },
    });
  });

  it("compiles the explicit DGX Spark Lightning 3.5 vLLM profile from YAML (#8385)", () => {
    const catalog = compile(catalogSources());
    const preset = catalog.presets.find(({ metadata }) => metadata.id === LIGHTNING_PROFILE_ID);
    const recipe = catalog.recipes.find(({ metadata }) => metadata.id === LIGHTNING_RECIPE_ID);

    expect(preset?.metadata.supportState).toBe("experimental");
    expect(preset?.spec).toMatchObject({
      selection: "explicit-only",
      plan: { backend: "vllm", recipeRef: LIGHTNING_RECIPE_ID },
    });
    expect(recipe?.spec).toMatchObject({
      backend: "vllm",
      model: {
        id: "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4",
        revision: "0dcd680e5585c791728c83342b311d0a0026dbeb",
        servedName: "nvidia-nemotron-3.5-lightning-30b-a3b-nvfp4",
      },
      runtime: {
        architecture: "arm64",
        image:
          "vllm/vllm-openai@sha256:3af90144a0926e5c5fe46ee16e5201e763dd854538b9d7ce433755f11dadaf78",
        environment: { VLLM_USE_RUST_FRONTEND: "0" },
      },
      execution: {
        materializerRef: "vllm.host-local/v1",
        lifecycleRef: "vllm.host-local.lifecycle/v1",
      },
      serve: {
        arguments: expect.arrayContaining([
          { name: "--gpu-memory-utilization", value: 0.65 },
          { name: "--tool-call-parser", value: "step3p5" },
          { name: "--reasoning-parser", value: "step3p5" },
          {
            name: "--speculative-config",
            value: '{"method":"mtp","num_speculative_tokens":1,"moe_backend":"flashinfer_cutlass"}',
          },
        ]),
      },
    });
  });

  it("compiles the explicit DGX Spark Muse vLLM profile from YAML (#8836)", () => {
    const catalog = compile(catalogSources());
    const preset = catalog.presets.find(({ metadata }) => metadata.id === MUSE_PROFILE_ID);
    const recipe = catalog.recipes.find(({ metadata }) => metadata.id === MUSE_RECIPE_ID);

    expect(preset?.metadata.supportState).toBe("experimental");
    expect(preset?.spec).toMatchObject({
      selection: "explicit-only",
      plan: { backend: "vllm", recipeRef: MUSE_RECIPE_ID },
    });
    expect(recipe?.spec).toMatchObject({
      backend: "vllm",
      model: {
        id: "Inferact/Muse-Glimmer-30B-NVFP4-W4A4",
        revision: "d35cb79050f419c457611b1cee5c5d15b176f285",
        servedName: "muse-glimmer",
      },
      runtime: {
        architecture: "arm64",
        image:
          "vllm/vllm-openai@sha256:b0e84e5f2b00a7268e4fdda332790ebd4bfb166b64757e166914753afaeee965",
      },
      execution: {
        materializerRef: "vllm.host-local/v1",
        lifecycleRef: "vllm.host-local.lifecycle/v1",
      },
      serve: {
        arguments: expect.arrayContaining([
          { name: "--tool-call-parser", value: "muse_glimmer" },
          { name: "--reasoning-parser", value: "muse_glimmer" },
        ]),
      },
    });
  });

  it.each(LINUX_VLLM_PROFILES)(
    "compiles $presetId as an explicit Linux amd64 catalog profile (#9673)",
    ({ presetId, recipeId }) => {
      const catalog = compile(catalogSources());
      const preset = catalog.presets.find(({ metadata }) => metadata.id === presetId);
      const recipe = catalog.recipes.find(({ metadata }) => metadata.id === recipeId);

      expect(preset?.metadata.supportState).toBe("experimental");
      expect(preset?.spec).toMatchObject({
        selection: "explicit-only",
        plan: { backend: "vllm", platform: "linux", recipeRef: recipeId },
      });
      expect(preset?.spec.requirements?.all).toContainEqual({
        readiness: {
          scope: "everyNode",
          kind: "observation",
          id: "host.os.architecture",
          comparison: { operator: "equals", value: "x64" },
        },
      });
      expect(recipe?.spec).toMatchObject({
        backend: "vllm",
        runtime: { architecture: "amd64" },
        execution: {
          materializerRef: "vllm.host-local/v1",
          lifecycleRef: "vllm.host-local.lifecycle/v1",
        },
      });
    },
  );

  it("documents the Experimental Lightning support boundary (#8385)", () => {
    const setupGuide = readFileSync(
      path.join(REPOSITORY_ROOT, "docs", "inference", "set-up-vllm.mdx"),
      "utf8",
    );
    const warning = setupGuide.match(
      /<Warning title="Experimental Nemotron 3\.5 Lightning vLLM Profile">([\s\S]*?)<\/Warning>/u,
    )?.[1];

    expect(warning).toBeDefined();
    expect(warning).toContain(
      "This profile is an explicit opt-in for one DGX Spark and remains Experimental.",
    );
    expect(warning).toContain(
      "Promotion requires broader validation of the pinned Python frontend and the `step3p5` reasoning and tool-call parsers.",
    );
    expect(warning).not.toContain("qualified for broader support");
  });

  it("keeps vLLM and llama.cpp profiles eligible for automatic selection", () => {
    const catalog = compile(catalogSources());
    const vllmPreset = catalog.presets.find(({ metadata }) => metadata.id === PROFILE_ID);
    const llamaCppPreset = catalog.presets.find(
      ({ metadata }) => metadata.id === LLAMA_CPP_PROFILE_ID,
    );

    expect(vllmPreset?.spec.selection).toBe("automatic");
    expect(llamaCppPreset?.spec.selection).toBe("automatic");
  });

  it("does not enable arbitrary remote model code in shipped managed recipes (#8129)", () => {
    const unsafeRecipes = compile(catalogSources())
      .recipes.filter((recipe) => {
        const { serve } = recipe.spec;
        return (
          serve !== undefined &&
          "arguments" in serve &&
          serve.arguments?.some(({ name }) => name === "--trust-remote-code")
        );
      })
      .map(({ metadata }) => metadata.id);

    expect(unsafeRecipes).toEqual([]);
  });

  it("keeps shipped profile identities out of production TypeScript (#8129)", () => {
    const servingRoot = path.join(REPOSITORY_ROOT, "src", "lib", "inference", "serving");
    const productionSources = readdirSync(servingRoot)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => readFileSync(path.join(servingRoot, name), "utf8"))
      .join("\n");

    expect(productionSources).not.toContain(PROFILE_ID);
    expect(productionSources).not.toContain(RECIPE_ID);
    expect(productionSources).not.toContain(LLAMA_CPP_PROFILE_ID);
    expect(productionSources).not.toContain(LLAMA_CPP_RECIPE_ID);
    expect(productionSources).not.toContain(LIGHTNING_PROFILE_ID);
    expect(productionSources).not.toContain(LIGHTNING_RECIPE_ID);
    expect(productionSources).not.toContain(MUSE_PROFILE_ID);
    expect(productionSources).not.toContain(MUSE_RECIPE_ID);
  });
});
