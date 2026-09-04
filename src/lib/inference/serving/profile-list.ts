// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";

import { getBuildIdentity } from "../../core/version.js";
import { createHostReadinessReport } from "../../readiness/host.js";
import { loadServingCatalog, managedInferenceCatalogFromServingCatalog } from "./catalog-loader.js";
import { resolveManagedInferenceServing } from "./resolver.js";
import type {
  CompiledServingCatalog,
  ManagedInferenceReadinessSource,
  ServingPreset,
  ServingRecipe,
  ServingSelectionPolicy,
  ServingSupportState,
} from "./types.js";

export interface ServingProfileListEntry {
  readonly id: string;
  readonly displayName: string;
  readonly backend: string;
  readonly model: string;
  readonly topology: string;
  readonly selectionMode: ServingSelectionPolicy;
  readonly supportState: ServingSupportState;
  readonly validationLevel?: "schema" | "software" | "hardware" | "unverified";
  readonly validationEvidence?: string | null;
  readonly estimatedImageDownloadBytes: number | null;
  readonly estimatedModelDownloadBytes: number | null;
  readonly compatible: boolean;
  readonly incompatibilityReason: string | null;
}

function recipeForPreset(
  catalog: CompiledServingCatalog,
  preset: ServingPreset,
): ServingRecipe | undefined {
  return catalog.recipes.find(({ metadata }) => metadata.id === preset.spec.plan.recipeRef);
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

function topologyLabel(recipe: ServingRecipe): string {
  const executionHosts = recipe.spec.execution.nodeCount;
  const runtimeHosts =
    recipe.spec.runtime && "hosts" in recipe.spec.runtime ? recipe.spec.runtime.hosts : undefined;
  const hosts = executionHosts ?? runtimeHosts ?? 1;
  return hosts === 1 ? "single-host" : `${String(hosts)}-host`;
}

function supportState(preset: ServingPreset): ServingSupportState {
  if (preset.spec.selection === "disabled") return "disabled";
  return preset.metadata.supportState ?? "experimental";
}

function compatibility(
  catalog: CompiledServingCatalog,
  preset: ServingPreset,
  recipe: ServingRecipe,
  readinessReports: readonly ManagedInferenceReadinessSource[],
): { compatible: boolean; incompatibilityReason: string | null } {
  if (preset.spec.selection === "disabled" || supportState(preset) === "disabled") {
    return { compatible: false, incompatibilityReason: "Profile is disabled." };
  }
  if (recipe.spec.backend !== "vllm") {
    return {
      compatible: false,
      incompatibilityReason: `Backend ${recipe.spec.backend} is not available through Express onboarding yet.`,
    };
  }
  // Managed vLLM installation still invokes the Docker-backed installer.
  // Keep Docker readiness authoritative here until onboarding starts vLLM
  // through the selected runtime provider's host-local operation.
  const resolution = resolveManagedInferenceServing(
    {
      readinessReports,
      topologyQualifications: [],
      intent: { preset: preset.metadata.id },
    },
    managedInferenceCatalogFromServingCatalog(catalog),
  );
  return resolution.outcome === "selected"
    ? { compatible: true, incompatibilityReason: null }
    : { compatible: false, incompatibilityReason: resolution.message };
}

export interface ListServingProfilesOptions {
  readonly evaluateCompatibility?: typeof compatibility;
  readonly readinessReports?: readonly ManagedInferenceReadinessSource[];
}

export interface ResolveServingProfileOptions {
  readonly catalog?: CompiledServingCatalog;
  readonly listProfiles?: (catalog: CompiledServingCatalog) => ServingProfileListEntry[];
}

export class ServingProfileSelectionError extends Error {}

function renderSelectionCandidate(candidate: string): string {
  return JSON.stringify(candidate);
}

export function resolveServingProfileSelection(
  candidate: string,
  options: ResolveServingProfileOptions = {},
): string {
  const catalog = options.catalog ?? loadServingCatalog();
  const matches = catalog.presets.filter(
    ({ metadata }) => metadata.id === candidate || metadata.displayName === candidate,
  );
  if (matches.length === 0) {
    throw new ServingProfileSelectionError(
      `Unknown serving profile ${renderSelectionCandidate(candidate)}. Run 'nemoclaw profiles list'.`,
    );
  }
  if (matches.length > 1) {
    throw new ServingProfileSelectionError(
      `Serving profile name ${renderSelectionCandidate(candidate)} is ambiguous; select a stable profile ID.`,
    );
  }
  const selected = matches[0]!;
  if (selected.spec.selection === "disabled" || selected.metadata.supportState === "disabled") {
    throw new ServingProfileSelectionError(
      `Serving profile '${selected.metadata.id}' is disabled.`,
    );
  }
  const profile = (options.listProfiles ?? listServingProfiles)(catalog).find(
    ({ id }) => id === selected.metadata.id,
  );
  if (!profile?.compatible) {
    throw new ServingProfileSelectionError(
      `Serving profile '${selected.metadata.id}' is incompatible: ${profile?.incompatibilityReason ?? "compatibility could not be evaluated"}.`,
    );
  }
  return selected.metadata.id;
}

export function listServingProfiles(
  catalog: CompiledServingCatalog = loadServingCatalog(),
  options: ListServingProfilesOptions = {},
): ServingProfileListEntry[] {
  const readinessReports = options.readinessReports ?? [
    {
      nodeId: os.hostname(),
      report: createHostReadinessReport(getBuildIdentity()),
    },
  ];
  return [...catalog.presets]
    .sort((left, right) => left.metadata.id.localeCompare(right.metadata.id))
    .map((preset) => {
      const recipe = recipeForPreset(catalog, preset);
      if (!recipe) {
        return {
          id: preset.metadata.id,
          displayName: preset.metadata.displayName ?? preset.metadata.id,
          backend: preset.spec.plan.backend,
          model: "unknown",
          topology: "unknown",
          selectionMode: preset.spec.selection,
          supportState: supportState(preset),
          validationLevel: preset.metadata.validation?.level ?? "unverified",
          validationEvidence: preset.metadata.validation?.evidence ?? null,
          estimatedImageDownloadBytes: null,
          estimatedModelDownloadBytes: null,
          compatible: false,
          incompatibilityReason: `Recipe ${preset.spec.plan.recipeRef} is unavailable.`,
        };
      }
      const runtime = recipe.spec.runtime;
      const imageDownloadBytes =
        runtime && "imageDownloadSizeBytes" in runtime
          ? (runtime.imageDownloadSizeBytes ?? null)
          : null;
      return {
        id: preset.metadata.id,
        displayName: preset.metadata.displayName ?? preset.metadata.id,
        backend: recipe.spec.backend,
        model: recipe.spec.model.id,
        topology: topologyLabel(recipe),
        selectionMode: preset.spec.selection,
        supportState: supportState(preset),
        validationLevel: preset.metadata.validation?.level ?? "unverified",
        validationEvidence: preset.metadata.validation?.evidence ?? null,
        estimatedImageDownloadBytes: imageDownloadBytes,
        estimatedModelDownloadBytes: modelDownloadBytes(recipe),
        ...(options.evaluateCompatibility ?? compatibility)(
          catalog,
          preset,
          recipe,
          readinessReports,
        ),
      };
    });
}

function formatBytes(value: number | null): string {
  if (value === null) return "unknown";
  return `${(value / 1024 ** 3).toFixed(1)} GiB`;
}

export function renderServingProfiles(entries: readonly ServingProfileListEntry[]): string {
  if (entries.length === 0) return "No serving profiles are installed.";
  return entries
    .map((entry) => {
      const availability = entry.compatible
        ? "compatible"
        : `incompatible: ${entry.incompatibilityReason ?? "unknown reason"}`;
      return [
        `${entry.id}  ${entry.displayName}`,
        `  backend=${entry.backend} model=${entry.model} topology=${entry.topology}`,
        `  selection=${entry.selectionMode} support=${entry.supportState} validation=${entry.validationLevel ?? "unverified"}${entry.validationEvidence ? `:${entry.validationEvidence}` : ""} image=${formatBytes(entry.estimatedImageDownloadBytes)} model-download=${formatBytes(entry.estimatedModelDownloadBytes)}`,
        `  ${availability}`,
      ].join("\n");
    })
    .join("\n\n");
}
