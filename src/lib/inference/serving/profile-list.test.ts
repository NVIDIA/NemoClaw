// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { loadServingCatalog } from "./catalog-loader";
import { listServingProfiles, renderServingProfiles } from "./profile-list";

describe("serving profile discovery", () => {
  it("lists every compiled preset with stable selection metadata (#8384)", () => {
    const catalog = loadServingCatalog();
    const entries = listServingProfiles(catalog, {
      evaluateCompatibility: (_catalog, preset) =>
        preset.metadata.id === catalog.presets[0]?.metadata.id
          ? { compatible: true, incompatibilityReason: null }
          : { compatible: false, incompatibilityReason: "Test host requirement is not met." },
    });

    expect(entries.map(({ id }) => id)).toEqual(
      [...catalog.presets].map(({ metadata }) => metadata.id).sort(),
    );
    for (const entry of entries) {
      expect(entry).toMatchObject({
        id: expect.any(String),
        displayName: expect.any(String),
        backend: expect.any(String),
        model: expect.any(String),
        topology: expect.any(String),
        selectionMode: expect.stringMatching(/^(automatic|explicit-only|disabled)$/u),
        supportState: expect.stringMatching(/^(supported|experimental|disabled)$/u),
        compatible: expect.any(Boolean),
      });
      expect(
        entry.compatible ? entry.incompatibilityReason : typeof entry.incompatibilityReason,
      ).toBe(entry.compatible ? null : "string");
    }
    expect(entries.some(({ compatible }) => compatible)).toBe(true);
    expect(entries.some(({ compatible }) => !compatible)).toBe(true);
  });

  it("renders IDs, selection state, support state, and compatibility (#8384)", () => {
    const output = renderServingProfiles([
      {
        id: "vllm.spark.example",
        displayName: "Example profile",
        backend: "vllm",
        model: "example/model",
        topology: "single-host",
        selectionMode: "explicit-only",
        supportState: "experimental",
        estimatedImageDownloadBytes: 2 * 1024 ** 3,
        estimatedModelDownloadBytes: 3 * 1024 ** 3,
        compatible: false,
        incompatibilityReason: "Host requirement is not met.",
      },
    ]);

    expect(output).toContain("vllm.spark.example  Example profile");
    expect(output).toContain("selection=explicit-only support=experimental");
    expect(output).toContain("image=2.0 GiB model-download=3.0 GiB");
    expect(output).toContain("incompatible: Host requirement is not met.");
  });
});
