// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { loadManagedInferenceCatalog } from "./catalog.js";
import {
  DUAL_SPARK_PRESET_ID,
  DUAL_SPARK_RECIPE_ID,
  DUAL_SPARK_TOPOLOGY_QUALIFICATION_ID,
} from "./catalog-types.js";

describe("managed inference catalog", () => {
  it("loads the immutable two-Spark recipe from compiled JSON", () => {
    const catalog = loadManagedInferenceCatalog();
    const recipe = catalog.recipes[0]?.definition;
    const preset = catalog.presets[0]?.definition;

    expect(catalog.catalogDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(recipe?.metadata.id).toBe(DUAL_SPARK_RECIPE_ID);
    expect(recipe?.spec.model).toMatchObject({
      id: "deepseek-ai/DeepSeek-V4-Flash-0731",
      revision: "9e165c30e2704aec5d9d593cce3eebd58bbef1cb",
      downloadSizeBytes: 166_898_661_074,
      preparationRef: "deepseek-v4-flash-0731/v1",
    });
    expect(recipe?.spec.runtime).toMatchObject({
      image:
        "ghcr.io/anemll/dspark-vllm-gx10@sha256:a83948492cf13df455170fb42885f5ef4db54fefe0feff0f841ecbff464ac9d8",
      imageDownloadSizeBytes: 9_787_537_825,
    });
    expect(recipe?.spec.execution).toMatchObject({
      materializerRef: "vllm.dual-dgx-spark/v1",
      lifecycleRef: "vllm.dual-dgx-spark/v1",
      nodeCount: 2,
      tensorParallelSize: 2,
    });
    expect(preset?.metadata.id).toBe(DUAL_SPARK_PRESET_ID);
    expect(preset?.spec.requirements.all).toContainEqual({
      topologyQualification: {
        id: DUAL_SPARK_TOPOLOGY_QUALIFICATION_ID,
        schemaVersion: 1,
        status: "qualified",
      },
    });
  });

  it("returns one deeply frozen catalog instance", () => {
    const first = loadManagedInferenceCatalog();
    const second = loadManagedInferenceCatalog();

    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.recipes[0]?.definition.spec.runtime.environment)).toBe(true);
  });
});
