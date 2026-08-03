// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import catalogSchema from "../../managed-inference/schemas/catalog.schema.json" with {
  type: "json",
};
import presetSchema from "../../managed-inference/schemas/preset.schema.json" with { type: "json" };
import recipeSchema from "../../managed-inference/schemas/recipe.schema.json" with { type: "json" };

import { parseCompiledServingCatalogJson } from "../../dist/lib/inference/serving/catalog";

const REPOSITORY_ROOT = path.join(import.meta.dirname, "..", "..");

describe("compiled managed inference serving catalog", () => {
  it("build output contains a schema-valid catalog with a source revision and matching digest (#8144)", () => {
    const source = readFileSync(
      path.join(REPOSITORY_ROOT, "dist", "managed-inference", "catalog.json"),
      "utf8",
    );
    parseCompiledServingCatalogJson(source, {
      catalog: catalogSchema,
      preset: presetSchema,
      recipe: recipeSchema,
    });
  });

  it("includes the compiled catalog in the npm package (#8144)", () => {
    const result = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
      }),
    ) as Array<{ files: Array<{ path: string }> }>;
    const files = result[0]?.files.map((file) => file.path) ?? [];

    expect(files).toContain("dist/managed-inference/catalog.json");
    expect(files).toContain("managed-inference/schemas/catalog.schema.json");
  }, 120_000);
});
