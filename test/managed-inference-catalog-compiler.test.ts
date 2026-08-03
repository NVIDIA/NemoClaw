// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  compileManagedInferenceCatalogSources,
  type ManagedInferenceCatalogSource,
} from "../scripts/managed-inference/compile-catalog.mts";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PRESET_PATH =
  "managed-inference/presets/vllm.dgx-spark-gb10.dual.deepseek-v4-flash-0731.yaml";
const RECIPE_PATH = "managed-inference/recipes/vllm.deepseek-v4-flash-0731.spark-dual.v1.yaml";
function source(sourcePath: string): ManagedInferenceCatalogSource {
  return {
    path: sourcePath,
    contents: fs.readFileSync(path.join(REPOSITORY_ROOT, sourcePath), "utf8"),
  };
}

function catalogSources(): ManagedInferenceCatalogSource[] {
  return [source(PRESET_PATH), source(RECIPE_PATH)];
}

function replaceSource(
  sources: readonly ManagedInferenceCatalogSource[],
  sourcePath: string,
  replace: (contents: string) => string,
): ManagedInferenceCatalogSource[] {
  return sources.map((item) =>
    item.path === sourcePath ? { ...item, contents: replace(item.contents) } : item,
  );
}

describe("managed inference catalog compiler", () => {
  it("produces identical canonical JSON regardless of source enumeration order", () => {
    const sources = catalogSources();

    expect(compileManagedInferenceCatalogSources(sources).json).toBe(
      compileManagedInferenceCatalogSources(sources.reverse()).json,
    );
  });

  it("rejects an unknown recipe field", () => {
    const sources = replaceSource(catalogSources(), RECIPE_PATH, (contents) =>
      contents.replace("  backend: vllm", "  backend: vllm\n  unsupportedField: true"),
    );

    expect(() => compileManagedInferenceCatalogSources(sources)).toThrow(/additional properties/u);
  });

  it("rejects a mutable runtime image reference", () => {
    const sources = replaceSource(catalogSources(), RECIPE_PATH, (contents) =>
      contents.replace(
        /ghcr\.io\/anemll\/dspark-vllm-gx10@sha256:[0-9a-f]{64}/u,
        "ghcr.io/anemll/dspark-vllm-gx10:0.1.1",
      ),
    );

    expect(() => compileManagedInferenceCatalogSources(sources)).toThrow(/schema validation/u);
  });

  it("requires a new recipe ID for any material contract change", () => {
    const sources = replaceSource(catalogSources(), RECIPE_PATH, (contents) =>
      contents.replace("      NCCL_DEBUG: WARN", "      NCCL_DEBUG: INFO"),
    );

    expect(() => compileManagedInferenceCatalogSources(sources)).toThrow(
      /contract changed without a new recipe ID/u,
    );
  });

  it.each([
    "--node-rank",
    "--headless",
    "--host",
  ])("rejects materializer-owned serving argument %s", (argument) => {
    const sources = replaceSource(catalogSources(), RECIPE_PATH, (contents) =>
      contents.replace("      - name: --port", `      - name: ${argument}\n      - name: --port`),
    );

    expect(() => compileManagedInferenceCatalogSources(sources)).toThrow(
      new RegExp(`materializer-owned argument ${argument}`),
    );
  });

  it("rejects an unresolved preset recipe reference", () => {
    const sources = replaceSource(catalogSources(), PRESET_PATH, (contents) =>
      contents.replace(
        "recipeRef: vllm.deepseek-v4-flash-0731.spark-dual.v1",
        "recipeRef: vllm.missing.recipe",
      ),
    );

    expect(() => compileManagedInferenceCatalogSources(sources)).toThrow(
      /references unknown recipe/u,
    );
  });
});
