// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parseCompiledServingCatalogJson } from "../../dist/lib/inference/serving/catalog";
import catalogSchema from "../../managed-inference/schemas/catalog.schema.json" with {
  type: "json",
};
import presetSchema from "../../managed-inference/schemas/preset.schema.json" with { type: "json" };
import recipeSchema from "../../managed-inference/schemas/recipe.schema.json" with { type: "json" };

const REPOSITORY_ROOT = path.join(import.meta.dirname, "..", "..");

function createPackFixture(): string {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "nemoclaw-serving-catalog-pack-"));
  const packageJson = JSON.parse(
    readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };
  // Local-directory packs always prepare first; keep this fixture scoped to packlist behavior.
  packageJson.scripts = {};

  writeFileSync(
    path.join(fixtureRoot, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
  copyFileSync(path.join(REPOSITORY_ROOT, ".gitignore"), path.join(fixtureRoot, ".gitignore"));
  mkdirSync(path.join(fixtureRoot, "dist"), { recursive: true });
  cpSync(
    path.join(REPOSITORY_ROOT, "dist", "managed-inference"),
    path.join(fixtureRoot, "dist", "managed-inference"),
    { recursive: true },
  );
  cpSync(
    path.join(REPOSITORY_ROOT, "managed-inference"),
    path.join(fixtureRoot, "managed-inference"),
    { recursive: true },
  );
  return fixtureRoot;
}

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
    const fixtureRoot = createPackFixture();
    try {
      const result = JSON.parse(
        execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
          cwd: fixtureRoot,
          encoding: "utf8",
        }),
      ) as Array<{ files: Array<{ path: string }> }>;
      const files = result[0]?.files.map((file) => file.path) ?? [];

      expect(files).toContain("dist/managed-inference/catalog.json");
      expect(files).toContain("managed-inference/schemas/catalog.schema.json");
      expect(files).toContain("managed-inference/schemas/recipe.schema.json");
      expect(files).toContain("managed-inference/schemas/preset.schema.json");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
