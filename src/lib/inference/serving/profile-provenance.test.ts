// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { loadServingCatalog } from "./catalog-loader";
import {
  assertServingProfileProvenanceCurrent,
  parseServingProfileProvenance,
  servingProfileProvenance,
} from "./profile-provenance";

describe("serving profile provenance", () => {
  it("captures exact catalog, preset, recipe, model, and runtime identity", () => {
    const catalog = loadServingCatalog();
    const preset = catalog.presets[0]!;
    const provenance = servingProfileProvenance(catalog, preset.metadata.id);

    expect(provenance).toMatchObject({
      schemaVersion: 1,
      catalogDigest: catalog.catalogDigest,
      preset: { id: preset.metadata.id, digest: expect.stringMatching(/^sha256:/u) },
      recipe: { id: preset.spec.plan.recipeRef, digest: expect.stringMatching(/^sha256:/u) },
    });
    expect(parseServingProfileProvenance(provenance)).toEqual(provenance);
    expect(assertServingProfileProvenanceCurrent(provenance, catalog)).toEqual(provenance);
  });

  it("rejects malformed records and catalog drift", () => {
    const catalog = loadServingCatalog();
    const provenance = servingProfileProvenance(catalog, catalog.presets[0]!.metadata.id);

    expect(parseServingProfileProvenance({ ...provenance, catalogDigest: "latest" })).toBeNull();
    expect(() =>
      assertServingProfileProvenanceCurrent(provenance, {
        ...catalog,
        catalogDigest: `sha256:${"f".repeat(64)}`,
      }),
    ).toThrow("changed since onboarding started");
  });
});
