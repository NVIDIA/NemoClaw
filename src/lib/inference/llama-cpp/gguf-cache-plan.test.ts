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
  readonly quotaBytes?: number;
  readonly stagingHeadroomBytes?: number;
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
          authentication: { mode: "optional", environment: "HF_TOKEN" },
        },
        cache: {
          ref: "llama-cpp.gguf-content-addressed/v1",
          receiptRef: "llama-cpp.gguf-cache-entry.receipt/v1",
          root: "user-cache",
          quotaBytes: overrides.quotaBytes ?? 2048,
          stagingHeadroomBytes: overrides.stagingHeadroomBytes ?? 512,
          staging: "same-filesystem",
          publication: "atomic-no-clobber",
          reuse: "verified-only-offline",
          sharing: "owner-only",
          cleanup: "receipt-owner-only",
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
        ref: "llama-cpp.gguf-content-addressed/v1",
        receiptRef: "llama-cpp.gguf-cache-entry.receipt/v1",
        root: "user-cache",
        quotaBytes: 2048,
        stagingHeadroomBytes: 512,
        staging: "same-filesystem",
        publication: "atomic-no-clobber",
        reuse: "verified-only-offline",
        sharing: "owner-only",
        cleanup: "receipt-owner-only",
      },
    });
    expect(first.cache.key).toBe(
      "sha256-711b4f2b33679e7ea8c3c0066929f9fb91bf6d8cf23535b46a450388ca8c4e3b",
    );
    expect(first.planDigest).toBe(
      "sha256:3d1c36437dd13ea12ea4aaaff21e3972ad8db97069822a9d787581a02dd03122",
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

  it("changes only the plan digest when the cache quota changes (#8279)", () => {
    const baseline = compileLlamaCppGgufCachePlan(recipe());
    const changed = compileLlamaCppGgufCachePlan(recipe({ quotaBytes: 4096 }));

    expect(changed.cache.key).toBe(baseline.cache.key);
    expect(changed.planDigest).not.toBe(baseline.planDigest);
  });

  it("accepts a quota equal to the file size plus staging headroom (#8279)", () => {
    expect(() =>
      compileLlamaCppGgufCachePlan(
        recipe({ sizeBytes: 1024, stagingHeadroomBytes: 512, quotaBytes: 1536 }),
      ),
    ).not.toThrow();
  });

  it("rejects a quota below the file size plus staging headroom (#8279)", () => {
    expect(() =>
      compileLlamaCppGgufCachePlan(
        recipe({ sizeBytes: 1024, stagingHeadroomBytes: 512, quotaBytes: 1535 }),
      ),
    ).toThrow("cache quota must be at least 1536 bytes");
  });
});
