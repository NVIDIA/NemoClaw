// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import path from "node:path";

import { getBuildIdentity } from "../../core/version.js";
import { createHostReadinessReport } from "../../readiness/host.js";
import type { VllmProfile } from "../vllm.js";
import type { VllmModelDef } from "../vllm-models.js";
import { VLLM_EXTRA_ARGS_ENV } from "../vllm-models.js";
import {
  HOST_LOCAL_VLLM_LIFECYCLE_REF,
  HOST_LOCAL_VLLM_MATERIALIZER_REF,
  isHostLocalInferenceServingRecipe,
} from "./adapter-registry.js";
import { resolveManagedInferenceServing } from "./resolver.js";
import type {
  HostLocalInferenceServingRecipe,
  ResolvedHostLocalInferenceSelection,
} from "./types.js";

const MATERIALIZER_OWNED_ARGUMENTS = new Set([
  "--host",
  "--port",
  "--revision",
  "--served-model-name",
  "--max-model-len",
  "--tensor-parallel-size",
  "--pipeline-parallel-size",
  "--data-parallel-size",
]);

export interface MaterializedHostLocalVllmSelection {
  readonly profile: VllmProfile;
  readonly model: VllmModelDef;
  readonly presetId: string;
  readonly recipeId: string;
}

export type HostLocalVllmSelectionResult =
  | { readonly kind: "not-selected" }
  | { readonly kind: "rejected"; readonly reason: string }
  | ({ readonly kind: "selected" } & MaterializedHostLocalVllmSelection);

function positiveIntegerArgument(
  selection: ResolvedHostLocalInferenceSelection,
  name: string,
): number {
  const matches = selection.recipe.spec.serve?.arguments?.filter(
    (argument) => argument.name === name,
  );
  const value = matches?.length === 1 ? matches[0]!.value : undefined;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`host-local vLLM recipe must define one positive ${name}`);
  }
  return parsed;
}

function modelArguments(selection: ResolvedHostLocalInferenceSelection): string[] {
  return (selection.recipe.spec.serve?.arguments ?? []).flatMap(({ name, value }) => {
    if (MATERIALIZER_OWNED_ARGUMENTS.has(name)) return [];
    return value === undefined ? [name] : [name, String(value)];
  });
}

function dockerRunArguments(recipe: HostLocalInferenceServingRecipe): string[] {
  const { devices, sharedMemoryBytes, temporaryFilesystems, ulimits } = recipe.spec.runtime;
  const memlock = ulimits.memlock === "unlimited" ? -1 : ulimits.memlock;
  return [
    "--gpus",
    recipe.spec.runtime.gpuRequest,
    "--ipc",
    recipe.spec.runtime.ipcMode,
    "--mount",
    `type=bind,source=${path.join(os.homedir(), ".cache", "huggingface")},target=${recipe.spec.runtime.modelCache.target}`,
    "--shm-size",
    `${String(sharedMemoryBytes)}b`,
    "--ulimit",
    `memlock=${String(memlock)}`,
    "--ulimit",
    `stack=${String(ulimits.stackBytes)}`,
    ...devices.flatMap((device) => ["--device", device]),
    ...temporaryFilesystems.flatMap(({ target, sizeBytes, mode, options }) => [
      "--tmpfs",
      `${target}:${[...options, `size=${String(sizeBytes)}`, `mode=${mode}`].join(",")}`,
    ]),
  ];
}

export function materializeHostLocalVllmSelection(
  selection: ResolvedHostLocalInferenceSelection,
  baseProfile: VllmProfile,
): MaterializedHostLocalVllmSelection {
  const { recipe, preset } = selection;
  if (
    recipe.spec.backend !== "vllm" ||
    recipe.spec.execution.materializerRef !== HOST_LOCAL_VLLM_MATERIALIZER_REF ||
    recipe.spec.execution.lifecycleRef !== HOST_LOCAL_VLLM_LIFECYCLE_REF
  ) {
    throw new Error("selected serving preset is not a host-local vLLM recipe");
  }
  if (baseProfile.platform !== "spark") {
    throw new Error("host-local vLLM serving presets are currently qualified only for DGX Spark");
  }
  const runtime = recipe.spec.runtime;
  const servedModelId = recipe.spec.model.servedName;
  if (
    !runtime?.image ||
    !runtime.imageDownloadSizeBytes ||
    !runtime.pullTimeoutSeconds ||
    !servedModelId ||
    !recipe.spec.model.downloadSizeBytes ||
    recipe.spec.model.gated === undefined ||
    recipe.spec.model.installFastSafetensors === undefined ||
    !recipe.spec.readiness?.timeoutSeconds
  ) {
    throw new Error("host-local vLLM recipe is missing required runtime or model fields");
  }
  const serveEnvironment = { ...runtime.environment };
  const model: VllmModelDef = {
    id: recipe.spec.model.id,
    label: recipe.metadata.displayName ?? recipe.metadata.id,
    envValue: preset.metadata.id,
    downloadSizeBytes: recipe.spec.model.downloadSizeBytes,
    maxModelLen: positiveIntegerArgument(selection, "--max-model-len"),
    revision: recipe.spec.model.revision,
    servedModelId,
    modelArgs: modelArguments(selection),
    gated: recipe.spec.model.gated,
    platforms: ["spark"],
    ...(Object.keys(serveEnvironment).length > 0 ? { serveEnv: serveEnvironment } : {}),
    runtime: {
      image: runtime.image,
      imageDownloadSizeBytes: runtime.imageDownloadSizeBytes,
      modelDownloadSizeBytes: recipe.spec.model.downloadSizeBytes,
      loadTimeoutSec: recipe.spec.readiness.timeoutSeconds,
      pullTimeoutSec: runtime.pullTimeoutSeconds,
      dockerRunArgs: dockerRunArguments(recipe),
      dockerRunArgsMode: "replace",
    },
    installFastSafetensors: recipe.spec.model.installFastSafetensors,
    managedBearerAuth: true,
    fixedServeCommand: true,
  };
  return {
    presetId: preset.metadata.id,
    recipeId: recipe.metadata.id,
    model,
    profile: {
      ...baseProfile,
      image: runtime.image,
      imageDownloadSizeBytes: runtime.imageDownloadSizeBytes,
      imageUnpackedSizeBytes: undefined,
      pullTimeoutSec: runtime.pullTimeoutSeconds,
      loadTimeoutSec: recipe.spec.readiness.timeoutSeconds,
      modelDownloadSizeBytes: recipe.spec.model.downloadSizeBytes,
      defaultModel: model,
      servingCatalog: {
        catalogDigest: selection.catalogDigest,
        presetId: preset.metadata.id,
        presetDigest: selection.presetDigest,
        recipeId: recipe.metadata.id,
        recipeDigest: selection.recipeDigest,
      },
    },
  };
}

export function resolveHostLocalVllmSelection(
  baseProfile: VllmProfile,
  env: NodeJS.ProcessEnv = process.env,
): HostLocalVllmSelectionResult {
  const presetId = String(env.NEMOCLAW_SERVING_PRESET ?? "").trim();
  if (!presetId) return { kind: "not-selected" };
  if (String(env.NEMOCLAW_VLLM_MODEL ?? "").trim()) {
    return {
      kind: "rejected",
      reason: "NEMOCLAW_SERVING_PRESET conflicts with NEMOCLAW_VLLM_MODEL",
    };
  }
  if (String(env[VLLM_EXTRA_ARGS_ENV] ?? "").trim()) {
    return {
      kind: "rejected",
      reason: `NEMOCLAW_SERVING_PRESET conflicts with ${VLLM_EXTRA_ARGS_ENV}`,
    };
  }
  const report = createHostReadinessReport(getBuildIdentity());
  const resolution = resolveManagedInferenceServing({
    readinessReports: [{ nodeId: os.hostname(), report }],
    topologyQualifications: [],
    intent: { preset: presetId },
  });
  if (resolution.outcome !== "selected") {
    return { kind: "rejected", reason: resolution.message };
  }
  if ("topologyQualification" in resolution) {
    return { kind: "rejected", reason: `Serving preset ${presetId} requires a managed topology.` };
  }
  if (!isHostLocalInferenceServingRecipe(resolution.recipe)) {
    return {
      kind: "rejected",
      reason: `Serving preset ${presetId} is not a host-local vLLM preset.`,
    };
  }
  try {
    const vllmResolution: ResolvedHostLocalInferenceSelection = {
      outcome: "selected",
      selection: resolution.selection,
      catalogDigest: resolution.catalogDigest,
      presetDigest: resolution.presetDigest,
      recipeDigest: resolution.recipeDigest,
      preset: resolution.preset,
      recipe: resolution.recipe,
    };
    return { kind: "selected", ...materializeHostLocalVllmSelection(vllmResolution, baseProfile) };
  } catch (error) {
    return { kind: "rejected", reason: (error as Error).message };
  }
}
