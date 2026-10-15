// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  VLLM_MODELS,
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
const MODEL_ID = "vllm.nemotron-3.5-super-vl-120b-a12b-nvfp4.v1";
const RECIPE_ID = "vllm.nemotron-3.5-super-vl-120b-a12b-nvfp4.station-arm64-single.v1";
const PRESET_ID = "vllm.dgx-station-gb300.single.nemotron-3.5-super-vl-120b-a12b-nvfp4";
const MODEL_ALIAS = "nemotron-3.5-super-vl-120b";
const SERVED_NAME = "nvidia-nemotron-3.5-super-vl-120b-a12b-nvfp4";
const SCHEMAS = {
  catalog: catalogSchema,
  model: modelSchema,
  preset: presetSchema,
  recipe: recipeSchema,
};

/** Compile the candidate documents through the production consumer without enabling selection. */
function candidateCatalog() {
  return managedInferenceCatalogFromServingCatalog(
    compileTrustedServingCatalog({
      sources: [
        `managed-inference/models/${MODEL_ID}.yaml`,
        `managed-inference/recipes/${RECIPE_ID}.yaml`,
        `managed-inference/presets/${PRESET_ID}.yaml`,
      ].map((file) => ({ path: file, contents: readFileSync(path.join(ROOT, file), "utf8") })),
      sourceRevision: "a".repeat(40),
      schemas: SCHEMAS,
      registries: getManagedInferenceServingCatalogRegistries(),
    }),
  );
}

describe("Super VL release preparation", () => {
  it("lists the disabled release candidate and rejects the retired Cobalt profile", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-super-vl-catalog-"));
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
      expect(profiles.find(({ id }) => id === PRESET_ID)).toMatchObject({
        model: "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4",
        supportState: "disabled",
        selectionMode: "disabled",
        compatible: false,
        incompatibilityReason: "Profile is disabled.",
      });
      expect(profiles.some(({ id }) => id === "vllm.dgx-station-gb300.single.cobalt")).toBe(false);
      expect(() => resolveServingProfileSelection(PRESET_ID, { catalog })).toThrow("is disabled");
      expect(
        resolveManagedInferenceServing(
          { readinessReports: [], topologyQualifications: [], intent: { preset: PRESET_ID } },
          catalog,
        ),
      ).toMatchObject({ outcome: "rejected", code: "requirements-not-met" });
      expect(() =>
        resolveServingProfileSelection("vllm.dgx-station-gb300.single.cobalt", { catalog }),
      ).toThrow("Unknown serving profile");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("compiles the candidate but reports it unavailable for onboarding", () => {
    expect(listServingProfiles(candidateCatalog(), { readinessReports: [] })).toMatchObject([
      { id: PRESET_ID, compatible: false, incompatibilityReason: "Profile is disabled." },
    ]);
  });

  it("materializes fixed MTP, cache, thinking and JSON-tool settings with bounded media", () => {
    const recipe = candidateCatalog().recipes[0]!;
    assert.ok(isHostLocalInferenceServingRecipe(recipe), "Expected host-local recipe");
    assert.ok(recipe.spec.serve.directInstall, "Expected fixed direct-install policy");
    const model = materializeHostLocalVllmModel(recipe, recipe.spec.serve.directInstall, "station");
    const command = buildVllmServeCommand(model, {
      [VLLM_EXTRA_ARGS_ENV]: '["--max-model-len","999999"]',
    });
    expect(model).toMatchObject({
      id: "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4",
      revision: "82d93699acd3be9e4617c53360fe5b3f5dbeb1b3",
      downloadSizeBytes: 75063319581,
      gated: false,
      servedModelId: SERVED_NAME,
      maxModelLen: 49152,
      managedBearerAuth: true,
      fixedServeCommand: true,
      installFastSafetensors: false,
      runtime: {
        gpuMemoryUtilization: 0.85,
        image:
          "vllm/vllm-openai@sha256:fd33bec1578f312a01547cc6b9691a5154c3e8bcfb76d2b35acb657bfc4eee8f",
        imageDownloadSizeBytes: 10690535076,
      },
    });
    expect(model.runtime?.dockerRunArgs).toContain("34359738368b");
    expect(command).toContain("--max-model-len 49152");
    expect(command).toContain("--tensor-parallel-size 1");
    expect(command).toContain("--async-scheduling");
    expect(command).toContain("--gpu-memory-utilization 0.85");
    expect(command).toContain("--max-num-seqs 1");
    expect(command).toContain("--max-num-batched-tokens 8192");
    expect(command).toContain("--mamba-backend flashinfer");
    expect(command).toContain("--kv-cache-dtype bfloat16");
    expect(command).toContain("--mamba-ssm-cache-dtype float16");
    expect(command).toContain("--enable-mamba-cache-stochastic-rounding");
    expect(command).toContain("--mamba-cache-philox-rounds 5");
    expect(command).toContain("--spec-method mtp");
    expect(command).toContain("--spec-tokens 3");
    expect(command).toContain("--enable-auto-tool-choice");
    expect(command).toContain("--tool-call-parser hermes");
    expect(command).toContain("--reasoning-parser nemotron_v3");
    const template = recipe.spec.serve.arguments.find(
      ({ name }) => name === "--chat-template",
    )?.value;
    assert.equal(typeof template, "string");
    expect(createHash("sha256").update(String(template)).digest("hex")).toBe(
      "ec468fff5625ccc22545b51c06f013b403c14c097dc971d74871651a0f821c76",
    );
    // Execute only the shell's argument parsing, never the model launcher or its bootstrap.
    const shellArguments = execFileSync(
      "/bin/sh",
      ["-c", `set -- ${command.slice(command.indexOf("python3 "))}; printf '%s\\0' "$@"`],
      { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" },
    ).split("\0");
    expect(shellArguments[shellArguments.indexOf("--chat-template") + 1]).toBe(template);
    expect(command).not.toContain("/opt/cobalt/chat_template.jinja");
    expect(command).toContain("--tool-strict-level parameter");
    expect(command).toContain("--default-chat-template-kwargs '{\"enable_thinking\":true}'");
    expect(command).toContain('--limit-mm-per-prompt \'{"image":8,"video":0}\'');
    expect(command).toContain("--allowed-media-domains cobalt.invalid");
    expect(command).toContain("HF_HUB_OFFLINE=1");
    expect(command).toContain("reviewed model metadata digest mismatch");
    expect(command).toContain("--trust-remote-code");
    expect(command).toContain("--code-revision");
    expect(command).not.toMatch(
      /999999|pip install|--allowed-local-media-path|--dtype |--parallel-tool-calls/,
    );
  });

  it("keeps template shell syntax literal when constructing the guarded command", () => {
    const recipe = candidateCatalog().recipes[0]!;
    assert.ok(isHostLocalInferenceServingRecipe(recipe));
    assert.ok(recipe.spec.serve.directInstall);
    const model = materializeHostLocalVllmModel(recipe, recipe.spec.serve.directInstall, "station");
    const template = "{% set x = '$(printf substituted)' %}\n{{ \"`printf substituted`\" }}";
    const command = buildVllmServeCommand({ ...model, modelArgs: ["--chat-template", template] });
    const args = execFileSync(
      "/bin/sh",
      ["-c", `set -- ${command.slice(command.indexOf("python3 "))}; printf '%s\\0' "$@"`],
      { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" },
    ).split("\0");
    expect(args[args.indexOf("--chat-template") + 1]).toBe(template);
  });

  it.each([PRESET_ID, "NVIDIA Nemotron 3.5 Super VL NVFP4 on one DGX Station"])(
    "rejects explicit selection by %s while release fields are unresolved",
    (candidate) => {
      expect(() =>
        resolveServingProfileSelection(candidate, { catalog: candidateCatalog() }),
      ).toThrow(`Serving profile '${PRESET_ID}' is disabled.`);
    },
  );

  it("rejects the disabled preset before evaluating hardware requirements", () => {
    expect(
      resolveManagedInferenceServing(
        { readinessReports: [], topologyQualifications: [], intent: { preset: PRESET_ID } },
        candidateCatalog(),
      ),
    ).toMatchObject({
      outcome: "rejected",
      code: "requirements-not-met",
      message: `Managed inference preset ${PRESET_ID} is disabled.`,
    });
  });

  it("rejects inactive selection and materializes an enabled test copy with its receipt", () => {
    const catalog = candidateCatalog();
    const input = {
      readinessReports: [
        { nodeId: "station", report: readinessReportForPreset(catalog.presets[0]!) },
      ],
      topologyQualifications: [],
    };
    expect(resolveManagedInferenceServing(input, catalog)).toMatchObject({ outcome: "no-match" });
    expect(
      resolveManagedInferenceServing({ ...input, intent: { vllmModel: MODEL_ALIAS } }, catalog),
    ).toMatchObject({
      outcome: "rejected",
      code: "requirements-not-met",
      message: `No managed vLLM profile defines model ${MODEL_ALIAS}.`,
    });

    // A synthetic enabled copy proves the rejection above is not caused by missing hardware evidence.
    const enabled = {
      ...catalog,
      presets: catalog.presets.map((preset) => ({
        ...preset,
        metadata: { ...preset.metadata, supportState: "experimental" as const },
        spec: { ...preset.spec, selection: "explicit-only" as const },
      })),
    };
    expect(resolveManagedInferenceServing(input, enabled)).toMatchObject({ outcome: "no-match" });
    expect(
      resolveManagedInferenceServing(
        { readinessReports: [], topologyQualifications: [], intent: { preset: PRESET_ID } },
        enabled,
      ),
    ).toMatchObject({ outcome: "rejected", code: "requirements-not-met" });

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
      servedModelId: SERVED_NAME,
      managedBearerAuth: true,
      fixedServeCommand: true,
      maxModelLen: 49152,
    });
    expect(buildVllmServeCommand(materialized.model)).toContain("--spec-method mtp");
    expect(detectVllmProfile({ platform: "station" })?.defaultModel.envValue).not.toBe(MODEL_ALIAS);
    expect(VLLM_MODELS.some(({ envValue }) => envValue === MODEL_ALIAS)).toBe(false);
    expect(VLLM_MODELS.some(({ envValue }) => envValue === "nemotron-3-ultra-550b-a55b")).toBe(
      true,
    );

    assert.ok(serving, "Expected catalog provenance for the runtime receipt");
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-super-vl-receipt-"));
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
