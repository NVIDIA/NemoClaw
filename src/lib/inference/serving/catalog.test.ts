// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  getManagedInferenceCompiledPreset,
  getManagedInferenceCompiledRecipe,
  loadManagedInferenceCatalog,
} from "./catalog.js";

describe("managed inference catalog", () => {
  it("loads every compiled YAML definition with unique IDs and resolvable references", () => {
    const catalog = loadManagedInferenceCatalog();
    expect(catalog.catalogDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(catalog.presets.length).toBeGreaterThan(0);
    expect(catalog.recipes.length).toBeGreaterThan(0);

    const ids = [
      ...catalog.presets.map(({ definition }) => definition.metadata.id),
      ...catalog.recipes.map(({ definition }) => definition.metadata.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    for (const compiledPreset of catalog.presets) {
      expect(getManagedInferenceCompiledPreset(compiledPreset.definition.metadata.id)).toBe(
        compiledPreset,
      );
      const compiledRecipe = getManagedInferenceCompiledRecipe(
        compiledPreset.definition.spec.plan.recipeRef,
      );
      expect(compiledRecipe?.definition.spec.backend).toBe(
        compiledPreset.definition.spec.plan.backend,
      );
    }
    for (const compiledRecipe of catalog.recipes) {
      expect(getManagedInferenceCompiledRecipe(compiledRecipe.definition.metadata.id)).toBe(
        compiledRecipe,
      );
      expect(compiledRecipe.definitionDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    }
  });

  it("returns one deeply frozen catalog instance", () => {
    const first = loadManagedInferenceCatalog();
    const second = loadManagedInferenceCatalog();

    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    for (const { definition } of first.recipes) {
      expect(Object.isFrozen(definition.spec.runtime.environment)).toBe(true);
    }
  });
});
