// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const GENERATED_CATALOG_DIRECTORY = path.join(
  REPOSITORY_ROOT,
  "dist/lib/inference/serving/generated",
);

describe("managed inference catalog package contract", () => {
  it("does not ship legacy generated TypeScript outputs", () => {
    expect(fs.existsSync(path.join(GENERATED_CATALOG_DIRECTORY, "catalog.js"))).toBe(false);
    expect(fs.existsSync(path.join(GENERATED_CATALOG_DIRECTORY, "catalog.js.map"))).toBe(false);
    expect(fs.existsSync(path.join(GENERATED_CATALOG_DIRECTORY, "catalog.d.ts"))).toBe(false);
    expect(fs.existsSync(path.join(GENERATED_CATALOG_DIRECTORY, "catalog.d.ts.map"))).toBe(false);
  });

  it("loads and validates the compiled catalog through the packaged runtime", () => {
    const catalogModule = require(
      path.join(REPOSITORY_ROOT, "dist/lib/inference/serving/catalog.js"),
    ) as {
      loadManagedInferenceCatalog(): {
        readonly presets: readonly unknown[];
        readonly recipes: readonly unknown[];
        readonly sourceFiles: readonly { readonly path: string }[];
      };
    };

    const catalog = catalogModule.loadManagedInferenceCatalog();
    expect(catalog.presets.length).toBeGreaterThan(0);
    expect(catalog.recipes.length).toBeGreaterThan(0);
    expect(catalog.sourceFiles).toHaveLength(catalog.presets.length + catalog.recipes.length);
    expect(
      catalog.sourceFiles.every(({ path: sourcePath }) =>
        /^managed-inference\/(?:presets|recipes)\/[a-z0-9._-]+\.yaml$/u.test(sourcePath),
      ),
    ).toBe(true);
  });
});
