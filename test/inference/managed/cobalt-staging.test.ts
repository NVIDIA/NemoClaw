// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import catalogSchema from "../../../managed-inference/schemas/catalog.schema.json" with { type: "json" };
import modelSchema from "../../../managed-inference/schemas/model.schema.json" with { type: "json" };
import presetSchema from "../../../managed-inference/schemas/preset.schema.json" with { type: "json" };
import recipeSchema from "../../../managed-inference/schemas/recipe.schema.json" with { type: "json" };
import {
  getManagedInferenceServingCatalogRegistries,
  isHostLocalInferenceServingRecipe,
} from "../../../src/lib/inference/serving/adapter-registry.js";
import {
  materializeHostLocalVllmModel,
  materializeHostLocalVllmSelection,
} from "../../../src/lib/inference/serving/host-local-vllm-selection.js";
import { detectVllmProfile } from "../../../src/lib/inference/vllm.js";
import {
  HOST_LOCAL_VLLM_RUNTIME_RECEIPT_FILE,
  persistHostLocalVllmRuntimeReceipt,
} from "../../../src/lib/inference/serving/vllm-host-local-lifecycle.js";
import {
  buildVllmServeCommand,
  VLLM_EXTRA_ARGS_ENV,
} from "../../../src/lib/inference/vllm-models.js";
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

/** Compile the inactive documents through the production catalog consumer without promoting them. */
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

  it("materializes the fixed BF16 command with bounded media and direct tools", () => {
    const recipe = stagingCatalog().recipes[0]!;
    assert.ok(isHostLocalInferenceServingRecipe(recipe), "Expected host-local recipe");
    assert.ok(recipe.spec.serve.directInstall, "Expected fixed direct-install policy");
    const model = materializeHostLocalVllmModel(recipe, recipe.spec.serve.directInstall, "station");
    const command = buildVllmServeCommand(model, {
      [VLLM_EXTRA_ARGS_ENV]: '["--max-model-len","999999"]',
    });
    expect(model).toMatchObject({
      servedModelId: "cobalt",
      maxModelLen: 16384,
      managedBearerAuth: true,
      fixedServeCommand: true,
      installFastSafetensors: false,
      runtime: { gpuMemoryUtilization: 0.95 },
    });
    expect(model.runtime?.dockerRunArgs).toContain("34359738368b");
    expect(command).toContain("--max-model-len 16384");
    expect(command).toContain("--dtype bfloat16");
    expect(command).toContain("--trust-remote-code");
    expect(command).toContain("--async-scheduling");
    expect(command).toContain("--gpu-memory-utilization 0.95");
    expect(command).toContain("--max-num-seqs 2");
    expect(command).toContain("--enable-auto-tool-choice");
    expect(command).toContain("--tool-call-parser qwen3_coder");
    expect(command).toContain("--reasoning-parser nemotron_v3");
    expect(command).toContain('--limit-mm-per-prompt \'{"image":2,"video":0}\'');
    expect(command).toContain("--allowed-media-domains cobalt.invalid");
    expect(command).toContain("HF_HUB_OFFLINE=1");
    expect(command).not.toMatch(
      /999999|pip install|--allowed-local-media-path|--speculative-config/,
    );
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

  it("rejects inactive selection and materializes an enabled test copy with its receipt", () => {
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

    const selection = resolveManagedInferenceServing(
      { ...input, intent: { preset: PRESET_ID } },
      enabled,
    );
    assert.ok(selection.outcome === "selected", "Expected the enabled test preset to resolve");
    assert.ok(isHostLocalInferenceServingRecipe(selection.recipe));
    const baseProfile = detectVllmProfile({ platform: "station" });
    assert.ok(baseProfile);
    const materialized = materializeHostLocalVllmSelection(
      { ...selection, recipe: selection.recipe },
      baseProfile,
    );
    const serving = materialized.profile.servingCatalog;
    expect(serving).toEqual({
      catalogDigest: selection.catalogDigest,
      presetId: PRESET_ID,
      presetDigest: selection.presetDigest,
      recipeId: selection.recipe.metadata.id,
      recipeDigest: selection.recipeDigest,
    });
    expect(materialized.profile.defaultModel).toEqual(materialized.model);
    expect(materialized.model).toMatchObject({
      servedModelId: "cobalt",
      managedBearerAuth: true,
      fixedServeCommand: true,
      maxModelLen: 16384,
    });
    expect(buildVllmServeCommand(materialized.model)).toContain("--dtype bfloat16");
    expect(detectVllmProfile({ platform: "station" })?.defaultModel.envValue).not.toBe("cobalt");

    assert.ok(serving, "Expected catalog provenance for the runtime receipt");
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-cobalt-receipt-"));
    try {
      persistHostLocalVllmRuntimeReceipt(
        { containerId: "a".repeat(64), authFingerprint: "b".repeat(64), serving },
        directory,
      );
      expect(
        JSON.parse(
          readFileSync(path.join(directory, HOST_LOCAL_VLLM_RUNTIME_RECEIPT_FILE), "utf8"),
        ),
      ).toMatchObject({ serving });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
