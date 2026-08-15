// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { LlamaCppServingRecipe } from "../serving/types";
import { compileLlamaCppGgufCachePlan } from "./gguf-cache-plan";

interface RecipeOverrides {
  readonly repository?: string;
  readonly revision?: string;
  readonly path?: string;
  readonly digest?: string;
  readonly sizeBytes?: number;
}

function recipe(overrides: RecipeOverrides = {}): LlamaCppServingRecipe {
  return {
    apiVersion: "nemoclaw.nvidia.com/managed-inference/v1",
    kind: "ServingRecipe",
    metadata: { id: "test.llama.recipe" },
    spec: {
      backend: "install-llama-cpp",
      providerId: "llama-cpp-local",
      model: {
        id: overrides.repository ?? "test/model",
        revision: overrides.revision ?? "a".repeat(40),
        files: [
          {
            path: overrides.path ?? "model.Q4_K_M.gguf",
            digest: overrides.digest ?? `sha256:${"b".repeat(64)}`,
            sizeBytes: overrides.sizeBytes ?? 1024,
            format: "gguf",
          },
        ],
        acquisition: {
          ref: "hugging-face-exact-file/v1",
          downloaderImage: `registry.example/downloader@sha256:${"e".repeat(64)}`,
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
      policy: {
        egress: "disabled",
        modelSource: "verified-local",
        modelDownloads: "disabled",
      },
    },
  } as unknown as LlamaCppServingRecipe;
}

describe("compileLlamaCppGgufCachePlan", () => {
  it("derives one deterministic Hugging Face cache plan from the recipe (#8279)", () => {
    const first = compileLlamaCppGgufCachePlan(recipe());
    const second = compileLlamaCppGgufCachePlan(recipe());

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      schemaVersion: 1,
      recipeId: "test.llama.recipe",
      acquisition: {
        ref: "hugging-face-exact-file/v1",
        downloaderImage: `registry.example/downloader@sha256:${"e".repeat(64)}`,
        url: `https://huggingface.co/test/model/resolve/${"a".repeat(40)}/model.Q4_K_M.gguf`,
        authentication: { mode: "optional", environment: "HF_TOKEN" },
        source: {
          repository: "test/model",
          revision: "a".repeat(40),
          file: {
            path: "model.Q4_K_M.gguf",
            digest: `sha256:${"b".repeat(64)}`,
            sizeBytes: 1024,
          },
        },
      },
      cache: {
        ref: "hugging-face-shared-cache/v1",
        root: "user-cache",
        reuse: "verify-exact-file",
        sharing: "host-user",
        cleanup: "preserve",
      },
    });
    expect(first.cache.key).toBe(
      "sha256-711b4f2b33679e7ea8c3c0066929f9fb91bf6d8cf23535b46a450388ca8c4e3b",
    );
    expect(first.planDigest).toBe(
      "sha256:e4f4880bef828bbc2b94ca08bb171b791bf55f5c220b53a3e843472e6f66ffd6",
    );
  });

  it.each([
    ["repository", { repository: "other/model" }],
    ["revision", { revision: "c".repeat(40) }],
    ["file name", { path: "other.Q4_K_M.gguf" }],
    ["file digest", { digest: `sha256:${"d".repeat(64)}` }],
    ["file size", { sizeBytes: 1025 }],
  ] satisfies readonly [
    string,
    RecipeOverrides,
  ][])("changes the cache key when the immutable %s changes (#8279)", (_field, overrides) => {
    const baseline = compileLlamaCppGgufCachePlan(recipe());
    const changed = compileLlamaCppGgufCachePlan(recipe(overrides));

    expect(changed.cache.key).not.toBe(baseline.cache.key);
    expect(changed.planDigest).not.toBe(baseline.planDigest);
  });
});
