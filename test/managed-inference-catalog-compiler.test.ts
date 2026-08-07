// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import catalogSchema from "../managed-inference/schemas/catalog.schema.json" with { type: "json" };
import presetSchema from "../managed-inference/schemas/preset.schema.json" with { type: "json" };
import recipeSchema from "../managed-inference/schemas/recipe.schema.json" with { type: "json" };
import { getManagedInferenceServingCatalogRegistries } from "../src/lib/inference/serving/adapter-registry.js";
import { compileTrustedServingCatalog } from "../src/lib/inference/serving/catalog.js";
import type { ServingCatalogSource } from "../src/lib/inference/serving/types.js";

const REPOSITORY_ROOT = path.join(import.meta.dirname, "..");
const PROFILE_ID = "vllm.dgx-spark-gb10.dual.deepseek-v4-flash-0731";
const RECIPE_ID = "vllm.deepseek-v4-flash-0731.spark-dual.v1";
const LLAMA_CPP_PROFILE_ID = "llama-cpp.dgx-spark-gb10.single.nemotron-3-nano-30b-a3b";
const LLAMA_CPP_RECIPE_ID = "llama-cpp.nemotron-3-nano-30b-a3b.spark-single.v1";
const LLAMA_CPP_IMAGE =
  "ghcr.io/ggml-org/llama.cpp@sha256:866ad568474de9e835e487ae841ad6ace1a494b5eab4f292cbd45adb6180f711";
const LLAMA_CPP_MODEL_DIGEST =
  "sha256:627f5b04aedc97f967332f331bd75b7a4ed2f33ca83e6ee74b44235cc1887890";

function catalogSources(): ServingCatalogSource[] {
  return (["presets", "recipes"] as const).flatMap((kind) => {
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
      preset: presetSchema,
      recipe: recipeSchema,
    },
    registries: getManagedInferenceServingCatalogRegistries(),
  });
}

describe("managed inference YAML profile contract", () => {
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

  it("compiles the explicit DGX Spark llama.cpp profile from YAML (#8173)", () => {
    const catalog = compile(catalogSources());
    const preset = catalog.presets.find(({ metadata }) => metadata.id === LLAMA_CPP_PROFILE_ID);
    const recipe = catalog.recipes.find(({ metadata }) => metadata.id === LLAMA_CPP_RECIPE_ID);

    expect(preset?.spec).toMatchObject({
      selection: "explicit-only",
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
        imageDownloadSizeBytes: 2181958990,
        networkExposure: "loopback",
      },
      serve: {
        authentication: "bearer",
        contextSize: 262144,
        batchSize: 2048,
        microBatchSize: 512,
        flashAttention: "enabled",
        kvCache: { key: "f16", value: "f16" },
        speculativeDecoding: "disabled",
      },
    });
  });

  it("keeps vLLM automatic while llama.cpp remains explicit-only (#8173)", () => {
    const catalog = compile(catalogSources());
    const vllmPreset = catalog.presets.find(({ metadata }) => metadata.id === PROFILE_ID);
    const llamaCppPreset = catalog.presets.find(
      ({ metadata }) => metadata.id === LLAMA_CPP_PROFILE_ID,
    );

    expect(vllmPreset?.spec.selection).toBe("automatic");
    expect(llamaCppPreset?.spec.selection).toBe("explicit-only");
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
  });
});
