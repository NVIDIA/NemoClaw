// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { loadServingCatalog } from "./catalog-loader";
import {
  resolveRequestedServingProfileModel,
  servingProfileModel,
} from "./requested-profile-model";

describe("requested serving profile model", () => {
  it("reports both names the shipped catalog gives a profile", () => {
    const catalog = loadServingCatalog();
    const preset = catalog.presets[0]!;
    const recipe = catalog.recipes.find(
      ({ metadata }) => metadata.id === preset.spec.plan.recipeRef,
    )!;

    expect(servingProfileModel(catalog, preset.metadata.id)).toEqual({
      presetId: preset.metadata.id,
      backend: recipe.spec.backend,
      servedName: recipe.spec.model.servedName,
      modelId: recipe.spec.model.id,
    });
  });

  it("returns null for a profile the catalog does not carry", () => {
    expect(servingProfileModel(loadServingCatalog(), "vllm.absent.profile")).toBeNull();
  });

  it("reads the preset the current run requested", () => {
    const catalog = loadServingCatalog();
    const preset = catalog.presets[0]!;

    expect(
      resolveRequestedServingProfileModel({ NEMOCLAW_SERVING_PRESET: preset.metadata.id }, catalog),
    ).toEqual(servingProfileModel(catalog, preset.metadata.id));
  });

  it("returns null when no profile was requested", () => {
    expect(resolveRequestedServingProfileModel({}, loadServingCatalog())).toBeNull();
    expect(resolveRequestedServingProfileModel({ NEMOCLAW_SERVING_PRESET: "  " })).toBeNull();
  });

  it("does not fail a selection when the catalog cannot be read", () => {
    expect(
      resolveRequestedServingProfileModel({ NEMOCLAW_SERVING_PRESET: "any" }, {
        get presets(): never {
          throw new Error("catalog unreadable");
        },
      } as never),
    ).toBeNull();
  });
});
