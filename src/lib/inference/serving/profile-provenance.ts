// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import type {
  CompiledServingCatalog,
  ServingProfileProvenance,
  ServingRecipe,
  ServingSupportState,
} from "./types";

export type { ServingProfileProvenance } from "./types";

const SHA256 = /^sha256:[a-f0-9]{64}$/u;

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function modelDownloadBytes(recipe: ServingRecipe): number | null {
  if (
    "downloadSizeBytes" in recipe.spec.model &&
    typeof recipe.spec.model.downloadSizeBytes === "number"
  ) {
    return recipe.spec.model.downloadSizeBytes;
  }
  const sizes = recipe.spec.model.files?.map((file) =>
    "sizeBytes" in file && typeof file.sizeBytes === "number" ? file.sizeBytes : null,
  );
  return sizes?.length && sizes.every((size): size is number => size !== null)
    ? sizes.reduce((total, size) => total + size, 0)
    : null;
}

function definitionDigest(
  catalog: CompiledServingCatalog,
  kind: "ServingPreset" | "ServingRecipe",
  id: string,
): string {
  const matches = catalog.sources.filter((source) => source.kind === kind && source.id === id);
  if (matches.length !== 1 || !SHA256.test(matches[0]!.digest)) {
    throw new Error(`Serving ${kind} ${id} does not have one immutable catalog digest.`);
  }
  return matches[0]!.digest;
}

function supportState(
  selection: string,
  declared: ServingSupportState | undefined,
): ServingSupportState {
  return selection === "disabled" ? "disabled" : (declared ?? "experimental");
}

export function servingProfileProvenance(
  catalog: CompiledServingCatalog,
  presetId: string,
): ServingProfileProvenance {
  const presets = catalog.presets.filter(({ metadata }) => metadata.id === presetId);
  if (presets.length !== 1) throw new Error(`Serving profile ${presetId} is unavailable.`);
  const preset = presets[0]!;
  const recipes = catalog.recipes.filter(
    ({ metadata }) => metadata.id === preset.spec.plan.recipeRef,
  );
  if (recipes.length !== 1) {
    throw new Error(`Serving profile ${presetId} does not resolve one recipe.`);
  }
  const recipe = recipes[0]!;
  if (recipe.spec.backend !== preset.spec.plan.backend) {
    throw new Error(`Serving profile ${presetId} does not match its recipe backend.`);
  }
  const runtime = recipe.spec.runtime;
  return {
    schemaVersion: 1,
    catalogDigest: catalog.catalogDigest,
    preset: {
      id: preset.metadata.id,
      digest: definitionDigest(catalog, "ServingPreset", preset.metadata.id),
      displayName: preset.metadata.displayName ?? preset.metadata.id,
      supportState: supportState(preset.spec.selection, preset.metadata.supportState),
    },
    recipe: {
      id: recipe.metadata.id,
      digest: definitionDigest(catalog, "ServingRecipe", recipe.metadata.id),
      backend: recipe.spec.backend,
    },
    model: { id: recipe.spec.model.id, revision: recipe.spec.model.revision },
    runtimeImage:
      runtime && typeof runtime.image === "string" && runtime.image.length > 0
        ? runtime.image
        : null,
    estimatedImageDownloadBytes:
      runtime && typeof runtime.imageDownloadSizeBytes === "number"
        ? runtime.imageDownloadSizeBytes
        : null,
    estimatedModelDownloadBytes: modelDownloadBytes(recipe),
  };
}

export function parseServingProfileProvenance(value: unknown): ServingProfileProvenance | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const preset = input.preset;
  const recipe = input.recipe;
  const model = input.model;
  if (
    !exactKeys(input, [
      "catalogDigest",
      "estimatedImageDownloadBytes",
      "estimatedModelDownloadBytes",
      "model",
      "preset",
      "recipe",
      "runtimeImage",
      "schemaVersion",
    ]) ||
    input.schemaVersion !== 1 ||
    typeof input.catalogDigest !== "string" ||
    !SHA256.test(input.catalogDigest) ||
    !preset ||
    typeof preset !== "object" ||
    Array.isArray(preset) ||
    !recipe ||
    typeof recipe !== "object" ||
    Array.isArray(recipe) ||
    !model ||
    typeof model !== "object" ||
    Array.isArray(model)
  ) {
    return null;
  }
  const p = preset as Record<string, unknown>;
  const r = recipe as Record<string, unknown>;
  const m = model as Record<string, unknown>;
  const support = p.supportState;
  const imageBytes = input.estimatedImageDownloadBytes;
  const modelBytes = input.estimatedModelDownloadBytes;
  if (
    !exactKeys(p, ["digest", "displayName", "id", "supportState"]) ||
    !exactKeys(r, ["backend", "digest", "id"]) ||
    !exactKeys(m, ["id", "revision"]) ||
    typeof p.id !== "string" ||
    typeof p.digest !== "string" ||
    !SHA256.test(p.digest) ||
    typeof p.displayName !== "string" ||
    (support !== "supported" && support !== "experimental" && support !== "disabled") ||
    typeof r.id !== "string" ||
    typeof r.digest !== "string" ||
    !SHA256.test(r.digest) ||
    typeof r.backend !== "string" ||
    typeof m.id !== "string" ||
    typeof m.revision !== "string" ||
    (input.runtimeImage !== null && typeof input.runtimeImage !== "string") ||
    (imageBytes !== null && (!Number.isSafeInteger(imageBytes) || (imageBytes as number) < 0)) ||
    (modelBytes !== null && (!Number.isSafeInteger(modelBytes) || (modelBytes as number) < 0))
  ) {
    return null;
  }
  return structuredClone(value) as ServingProfileProvenance;
}

export function assertServingProfileProvenanceCurrent(
  recorded: ServingProfileProvenance,
  catalog: CompiledServingCatalog,
): ServingProfileProvenance {
  const parsed = parseServingProfileProvenance(recorded);
  if (!parsed) throw new Error("Recorded serving profile provenance is malformed.");
  const current = servingProfileProvenance(catalog, parsed.preset.id);
  if (!isDeepStrictEqual(current, parsed)) {
    throw new Error(
      `Serving profile ${parsed.preset.id} changed since onboarding started; run a fresh onboarding instead of silently changing the recipe.`,
    );
  }
  return parsed;
}
