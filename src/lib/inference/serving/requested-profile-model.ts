// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadServingCatalog } from "./catalog-loader.js";
import { NEMOCLAW_SERVING_PRESET_ENV } from "./managed-cluster-discovery.js";
import type { CompiledServingCatalog } from "./types.js";

/** The identifiers under which a running endpoint can report a requested profile's model. */
export interface RequestedServingProfileModel {
  readonly presetId: string;
  readonly backend: string;
  /** Alias the recipe pins with --served-model-name, so what /v1/models reports. */
  readonly servedName: string;
  /** Weights the recipe downloads, so what a reporting endpoint gives as the root. */
  readonly modelId: string;
}

export function servingProfileModel(
  catalog: CompiledServingCatalog,
  presetId: string,
): RequestedServingProfileModel | null {
  const presets = catalog.presets.filter(({ metadata }) => metadata.id === presetId);
  if (presets.length !== 1) return null;
  const recipes = catalog.recipes.filter(
    ({ metadata }) => metadata.id === presets[0]!.spec.plan.recipeRef,
  );
  if (recipes.length !== 1) return null;
  const spec = recipes[0]!.spec;
  const servedName = typeof spec.model.servedName === "string" ? spec.model.servedName.trim() : "";
  return servedName
    ? { presetId, backend: spec.backend, servedName, modelId: spec.model.id }
    : null;
}

/**
 * Model the serving profile requested for this run declares.
 *
 * Provider selection reads the preset from the environment rather than from the
 * resolved provenance, so this reads the same place. `--profile` sets that
 * variable for the run, but an operator can also export it directly, in which
 * case no flag validation has run against it — hence the backend on the result,
 * which callers use to reject a preset their own selection cannot serve.
 *
 * Returns null rather than throwing. An unreadable catalog then leaves the
 * caller's model check unarmed instead of stopping onboarding.
 */
export function resolveRequestedServingProfileModel(
  env: NodeJS.ProcessEnv = process.env,
  catalog?: CompiledServingCatalog,
): RequestedServingProfileModel | null {
  const presetId = String(env[NEMOCLAW_SERVING_PRESET_ENV] ?? "").trim();
  if (!presetId) return null;
  try {
    return servingProfileModel(catalog ?? loadServingCatalog(), presetId);
  } catch {
    return null;
  }
}
