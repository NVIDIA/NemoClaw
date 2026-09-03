// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { loadServingCatalog } from "./catalog-loader";
import {
  listServingProfiles,
  renderServingProfiles,
  resolveServingProfileSelection,
} from "./profile-list";

describe("serving profile discovery", () => {
  it(
    "lists every compiled preset with stable selection metadata (#8384)",
    { timeout: 30_000 },
    () => {
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
      entries.forEach((entry) => {
        expect(entry).toMatchObject({
          id: expect.any(String),
          displayName: expect.any(String),
          backend: expect.any(String),
          model: expect.any(String),
          topology: expect.any(String),
          selectionMode: expect.stringMatching(/^(automatic|explicit-only|disabled)$/u),
          supportState: expect.stringMatching(/^(supported|experimental|disabled)$/u),
          validationLevel: expect.stringMatching(/^(schema|software|hardware)$/u),
          compatible: expect.any(Boolean),
        });
        expect(
          entry.compatible ? entry.incompatibilityReason : typeof entry.incompatibilityReason,
        ).toBe(entry.compatible ? null : "string");
      });
      expect(entries.some(({ compatible }) => compatible)).toBe(true);
      expect(entries.some(({ compatible }) => !compatible)).toBe(true);
    },
  );

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
        validationLevel: "hardware",
        validationEvidence: "test-evidence",
        estimatedImageDownloadBytes: 2 * 1024 ** 3,
        estimatedModelDownloadBytes: 3 * 1024 ** 3,
        compatible: false,
        incompatibilityReason: "Host requirement is not met.",
      },
    ]);

    expect(output).toContain("vllm.spark.example  Example profile");
    expect(output).toContain("selection=explicit-only support=experimental");
    expect(output).toContain("validation=hardware:test-evidence");
    expect(output).toContain("image=2.0 GiB model-download=3.0 GiB");
    expect(output).toContain("incompatible: Host requirement is not met.");
  });

  it("reuses one immutable readiness snapshot across every profile evaluation", () => {
    const catalog = loadServingCatalog();
    const readinessReports = [] as const;
    const observed: unknown[] = [];

    listServingProfiles(catalog, {
      readinessReports,
      evaluateCompatibility: (_catalog, _preset, _recipe, reports) => {
        observed.push(reports);
        return { compatible: true, incompatibilityReason: null };
      },
    });

    expect(observed).toHaveLength(catalog.presets.length);
    expect(observed.every((reports) => reports === readinessReports)).toBe(true);
  });

  it("escapes an untrusted profile candidate in diagnostics (#8384)", () => {
    const candidate = "unknown\n\u001b[31mprofile";

    expect(() => resolveServingProfileSelection(candidate)).toThrowError(
      'Unknown serving profile "unknown\\n\\u001b[31mprofile".',
    );
  });

  it("rejects an ambiguous display name and directs users to stable IDs (#8384)", () => {
    const catalog = loadServingCatalog();
    const ambiguousName = "Duplicated profile name";
    const ambiguousCatalog = {
      ...catalog,
      presets: catalog.presets.map((preset, index) =>
        index < 2
          ? { ...preset, metadata: { ...preset.metadata, displayName: ambiguousName } }
          : preset,
      ),
    };

    expect(() =>
      resolveServingProfileSelection(ambiguousName, { catalog: ambiguousCatalog }),
    ).toThrowError(
      'Serving profile name "Duplicated profile name" is ambiguous; select a stable profile ID.',
    );
  });

  it("rejects a disabled profile before compatibility evaluation (#8384)", () => {
    const catalog = loadServingCatalog();
    const selected = catalog.presets[0]!;
    const disabledCatalog = {
      ...catalog,
      presets: catalog.presets.map((preset) =>
        preset.metadata.id === selected.metadata.id
          ? { ...preset, spec: { ...preset.spec, selection: "disabled" as const } }
          : preset,
      ),
    };

    expect(() =>
      resolveServingProfileSelection(selected.metadata.id, { catalog: disabledCatalog }),
    ).toThrowError(`Serving profile '${selected.metadata.id}' is disabled.`);
  });
});
