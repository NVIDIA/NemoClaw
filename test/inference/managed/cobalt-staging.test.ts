// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import catalogSchema from "../../../managed-inference/schemas/catalog.schema.json" with { type: "json" };
import modelSchema from "../../../managed-inference/schemas/model.schema.json" with { type: "json" };
import presetSchema from "../../../managed-inference/schemas/preset.schema.json" with { type: "json" };
import recipeSchema from "../../../managed-inference/schemas/recipe.schema.json" with { type: "json" };
import { getManagedInferenceServingCatalogRegistries } from "../../../src/lib/inference/serving/adapter-registry.js";
import { compileTrustedServingCatalog } from "../../../src/lib/inference/serving/catalog.js";
import {
  managedInferenceCatalogFromServingCatalog,
  parseCompiledManagedInferenceCatalogJson,
} from "../../../src/lib/inference/serving/catalog-loader.js";
import { generateServingCatalog } from "../../../src/lib/inference/serving/generate-catalog.js";
import {
  listServingProfiles,
  resolveServingProfileSelection,
} from "../../../src/lib/inference/serving/profile-list.js";
import { resolveManagedInferenceServing } from "../../../src/lib/inference/serving/resolver.js";
import { readinessReportForPreset } from "../../../src/lib/inference/serving/readiness-report.test-support.js";

const ROOT = path.join(import.meta.dirname, "../../..");
const PRESET_ID = "vllm.dgx-station-gb300.single.cobalt";
const SCHEMAS = {
  catalog: catalogSchema,
  model: modelSchema,
  preset: presetSchema,
  recipe: recipeSchema,
};

function stagingCatalog() {
  return managedInferenceCatalogFromServingCatalog(
    compileTrustedServingCatalog({
      sources: ["model", "recipe", "preset"].map((kind) => ({
        path: `managed-inference/${kind}s/cobalt.yaml`,
        contents: readFileSync(
          path.join(ROOT, "managed-inference/staging/cobalt", `${kind}.yaml`),
          "utf8",
        ),
      })),
      sourceRevision: "a".repeat(40),
      schemas: SCHEMAS,
      registries: getManagedInferenceServingCatalogRegistries(),
    }),
  );
}

describe("inactive Cobalt staging", () => {
  it("generates a production catalog that cannot discover or select Cobalt", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-cobalt-catalog-"));
    try {
      const outputPath = generateServingCatalog({
        rootDir: ROOT,
        outputPath: path.join(directory, "catalog.json"),
      });
      const catalog = parseCompiledManagedInferenceCatalogJson(
        readFileSync(outputPath, "utf8"),
        SCHEMAS,
      );
      const profiles = listServingProfiles(catalog, { readinessReports: [] });
      expect(profiles.length).toBeGreaterThan(0);
      expect(profiles.some(({ id }) => id === PRESET_ID)).toBe(false);
      expect(() => resolveServingProfileSelection(PRESET_ID, { catalog })).toThrow(
        "Unknown serving profile",
      );
      expect(
        resolveManagedInferenceServing(
          { readinessReports: [], topologyQualifications: [], intent: { preset: PRESET_ID } },
          catalog,
        ),
      ).toMatchObject({ outcome: "rejected", code: "unknown-preset" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("compiles staging but reports it unavailable for onboarding", () => {
    expect(listServingProfiles(stagingCatalog(), { readinessReports: [] })).toMatchObject([
      { id: PRESET_ID, compatible: false, incompatibilityReason: "Profile is disabled." },
    ]);
  });

  it.each([PRESET_ID, "Cobalt on one DGX Station"])(
    "rejects explicit selection by %s even when staging is compiled",
    (candidate) => {
      expect(() =>
        resolveServingProfileSelection(candidate, { catalog: stagingCatalog() }),
      ).toThrow(`Serving profile '${PRESET_ID}' is disabled.`);
    },
  );

  it("rejects the staged preset before evaluating hardware requirements", () => {
    expect(
      resolveManagedInferenceServing(
        { readinessReports: [], topologyQualifications: [], intent: { preset: PRESET_ID } },
        stagingCatalog(),
      ),
    ).toMatchObject({
      outcome: "rejected",
      code: "requirements-not-met",
      message: `Managed inference preset ${PRESET_ID} is disabled.`,
    });
  });

  it("does not select staging automatically or through its model alias", () => {
    const catalog = stagingCatalog();
    const input = {
      readinessReports: [
        { nodeId: "station", report: readinessReportForPreset(catalog.presets[0]!) },
      ],
      topologyQualifications: [],
    };
    expect(resolveManagedInferenceServing(input, catalog)).toMatchObject({ outcome: "no-match" });
    expect(
      resolveManagedInferenceServing({ ...input, intent: { vllmModel: "cobalt" } }, catalog),
    ).toMatchObject({
      outcome: "rejected",
      code: "requirements-not-met",
      message: "No managed vLLM profile defines model cobalt.",
    });

    // A synthetic enabled copy proves the rejection above is not caused by missing hardware evidence.
    const enabled = {
      ...catalog,
      presets: catalog.presets.map((preset) => ({
        ...preset,
        metadata: { ...preset.metadata, supportState: "experimental" as const },
        spec: { ...preset.spec, selection: "automatic" as const },
      })),
    };
    expect(resolveManagedInferenceServing(input, enabled)).toMatchObject({ outcome: "selected" });
  });
});
