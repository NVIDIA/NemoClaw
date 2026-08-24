// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Registry of models the express vLLM install path knows how to serve.
 *
 * Each entry pins the model-specific `vllm serve` flags (reasoning parser,
 * tool-call parser, max model length, load format) and any required runtime
 * image/container overrides so the express path can swap models without
 * leaving the wrong recipe behind.
 *
 * Selection precedence in `installVllm`:
 *   1. `NEMOCLAW_VLLM_MODEL=<envValue-or-HF-id>` for automation overrides.
 *   2. Interactive picker over the per-platform subset (via
 *      `modelsForPlatform`), defaulting to the profile's `defaultModel`.
 *   3. Non-interactive runs without an override use the profile default
 *      directly, never the first registry entry.
 *
 * Gated entries (e.g. DeepSeek-R1 Distill Llama 70B) require the operator
 * to have accepted the model's licence on Hugging Face AND export a
 * compatible `HF_TOKEN`; `assertGatedModelAccess` enforces the token check
 * before the wizard pulls the model weights so the failure is fast and the
 * user knows exactly which token to provision.
 *
 * The registry is deliberately small and additive — extend it only when a
 * new checkpoint has its `vllm serve` flags, context length, memory
 * envelope, and tool-call behaviour validated.
 */

import net from "node:net";

import { isHostLocalInferenceServingRecipe } from "./serving/adapter-registry.js";
import { managedInferenceDigest } from "./serving/catalog-integrity.js";
import { loadManagedInferenceCatalog } from "./serving/catalog-loader.js";
import {
  hostLocalVllmDockerRunArguments,
  hostLocalVllmGpuMemoryUtilization,
  hostLocalVllmModelArguments,
} from "./serving/host-local-vllm-materialization.js";
import type {
  CompiledManagedInferenceCatalog,
  HostLocalInferenceServingRecipe,
  ManagedInferenceServingPreset,
  ServingArgument,
  ServingModelCapabilities,
  ServingStationPairOrchestration,
} from "./serving/types.js";

export type VllmPlatform = "spark" | "station" | "n1x" | "linux";
export const STATION_PAIR_OPTIONAL_ORCHESTRATION = "vllm.station-pair-optional/v1";
export const DUAL_STATION_VLLM_GPU_MEMORY_UTILIZATION = 0.9;
export const NEMOCLAW_VLLM_GPU_DEVICE_ENV = "NEMOCLAW_VLLM_GPU_DEVICE" as const;

const GPU_INDEX_PATTERN = /^\d+$/;
const GPU_UUID_PATTERN = /^GPU-[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}$/;

export function normalizeVllmGpuDevice(value: string): string {
  const candidate = value.trim();
  if (GPU_INDEX_PATTERN.test(candidate)) {
    const index = Number(candidate);
    if (Number.isSafeInteger(index)) return String(index);
  }
  if (GPU_UUID_PATTERN.test(candidate)) {
    return `GPU-${candidate.slice("GPU-".length).toLowerCase()}`;
  }
  throw new Error(
    "vLLM GPU device must be a non-negative GPU index or full GPU UUID reported by nvidia-smi",
  );
}

export function parseVllmGpuDevice(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return normalizeVllmGpuDevice(value);
  } catch {
    return null;
  }
}

export interface VllmServingCatalogIdentity {
  readonly catalogDigest: string;
  readonly presetId: string;
  readonly presetDigest: string;
  readonly recipeId: string;
  readonly recipeDigest: string;
}

export interface VllmRuntimeOverride {
  /** Model-specific runtime image, pinned by digest. */
  image: string;
  /** Compressed size of the selected platform manifest. */
  imageDownloadSizeBytes: number;
  /** Measured uncompressed layer size for the exact image digest, when known. */
  imageUnpackedSizeBytes?: number;
  /** Size of the pinned Hugging Face snapshot used for cache preflight. */
  modelDownloadSizeBytes?: number;
  /** Maximum time to wait for this model to become ready after launch. */
  loadTimeoutSec?: number;
  /** Additional `docker run` arguments required by this recipe. */
  dockerRunArgs?: readonly string[];
  /** Replace, rather than extend, the platform Docker arguments. */
  dockerRunArgsMode?: "append" | "replace";
  /** Maximum time allowed for the immutable image pull. */
  pullTimeoutSec?: number;
  /** Runtime-specific GPU floor, overriding the model-wide default. */
  minComputeCapability?: number;
  /** Minimum GPU or unified-memory capacity declared by the recipe. */
  minGpuMemoryBytes?: number;
  /** Fraction of one selected GPU that vLLM reserves during startup. */
  gpuMemoryUtilization?: number;
  /** Catalog identity that produced this runtime. */
  servingCatalog?: VllmServingCatalogIdentity;
  /** Catalog preset that declared this runtime, independent of receipt ownership. */
  catalogPresetId?: string;
  /** Allowlisted orchestration adapter selected by the catalog recipe. */
  orchestrationRef?: string;
  /** Typed data consumed only by the allowlisted Station-pair adapter. */
  stationPair?: ServingStationPairOrchestration;
}

/**
 * A runtime override qualified for a host platform and architecture.
 *
 * Entries are ordered from general to specific. The resolver selects the last
 * matching entry, which lets a conservative Linux baseline precede a
 * device-specific optimized runtime without making an ARM64 image the fallback
 * for an x86_64 host.
 */
export interface VllmRuntimeVariant extends VllmRuntimeOverride {
  /** Higher-priority variants override the general hardware baseline. */
  priority: number;
  /** NemoClaw platform profiles this runtime can serve. */
  platforms?: readonly VllmPlatform[];
  /** Node.js host architectures this image was built for. */
  architectures?: readonly NodeJS.Architecture[];
  /** Model arguments supplied by this recipe. */
  modelArgs: readonly string[];
  /** Recipe-specific context length. */
  maxModelLen: number;
  /** Immutable model revision supplied by this recipe. */
  revision: string;
  /** Served model name supplied by this recipe. */
  servedModelId: string;
  /** Recipe environment passed to the serving process. */
  serveEnv: Readonly<Record<string, string>>;
  /** Whether startup installs the fastsafetensors extra. */
  installFastSafetensors: boolean;
  /** Direct installs may opt into a fixed serving command. */
  fixedServeCommand?: true;
  /** Direct installs may opt into managed bearer authentication. */
  managedBearerAuth?: true;
  /** Catalog images do not receive an implicit remote-code flag. */
  trustRemoteCode: false;
  /** Preset selection policy used for automatic hardware defaults. */
  selection: "automatic" | "explicit-only";
  /** Whether the interactive model picker displays this variant. */
  interactive: boolean;
  /** Catalog preset that declared this runtime. */
  catalogPresetId: string;
}

export interface VllmModelDef {
  /** Hugging Face model id (also passed to `vllm serve`). */
  id: string;
  /** Human-readable label shown in wizard summaries. */
  label: string;
  /** Stable identifier accepted via `NEMOCLAW_VLLM_MODEL`. */
  envValue: string;
  /** Approximate full Hugging Face repository file size in bytes. */
  downloadSizeBytes: number;
  /** `--max-model-len` flag value. */
  maxModelLen: number;
  /** Immutable Hugging Face revision used for download and serving. */
  revision?: string;
  /** Stable model name exposed by the local OpenAI-compatible endpoint. */
  servedModelId?: string;
  /** Model-specific flags appended after the shared serving flags. */
  modelArgs: readonly string[];
  /** True when the upstream HF repo requires accepting a licence. */
  gated: boolean;
  /**
   * Platforms on which managed vLLM may serve this entry. Direct
   * `NEMOCLAW_VLLM_MODEL` overrides are checked against this list before an
   * image pull or model download.
   */
  platforms: readonly VllmPlatform[];
  /**
   * Optional narrower list for the interactive picker. This keeps a newly
   * added compatibility path explicit-only until it has completed broader
   * hardware qualification without blocking an intentional env override.
   */
  pickerPlatforms?: readonly VllmPlatform[];
  minComputeCapability?: number;
  /**
   * Environment variables exported immediately before `vllm serve` (e.g.
   * FlashInfer / MoE-backend selection, target SM arch). Joined as
   * `export K=V && …` so they apply to the serve process inside the
   * container shell.
   */
  serveEnv?: Readonly<Record<string, string>>;
  /** Runtime overrides for recipes that cannot use the platform image. */
  runtime?: VllmRuntimeOverride;
  /** Ordered, compatibility-qualified runtime overrides. */
  runtimeVariants?: readonly VllmRuntimeVariant[];
  /** Refuse the platform baseline when no runtime variant matches. */
  requireRuntimeVariant?: true;
  /** Whether startup must install vLLM's fastsafetensors extra. Defaults to true. */
  installFastSafetensors?: boolean;
  /** Disable remote model code for a runtime image that contains native model support. */
  trustRemoteCode?: false;
  /** Require the host-global managed bearer credential and a loopback-only listener. */
  managedBearerAuth?: true;
  /** Reject environment-provided model and serving-argument overrides. */
  fixedServeCommand?: true;
  /** Model behavior used by endpoint validation and agent compatibility checks. */
  capabilities?: ServingModelCapabilities;
  /** Allowlisted endpoint probe budget policy. */
  probePolicyRef?: string;
}

interface CatalogModelVariant {
  readonly id: string;
  readonly label: string;
  readonly envValue: string;
  readonly menuOrder: number;
  readonly downloadSizeBytes: number;
  readonly gated: boolean;
  readonly capabilities?: ServingModelCapabilities;
  readonly probePolicyRef?: string;
  readonly platform: VllmPlatform;
  readonly variant: VllmRuntimeVariant;
}

function argumentValue(arguments_: readonly ServingArgument[], name: string): string | undefined {
  const matches = arguments_.filter((argument) => argument.name === name);
  if (matches.length !== 1) return undefined;
  const value = matches[0]!.value;
  return value === undefined ? undefined : String(value);
}

function nodeArchitecture(architecture: string): NodeJS.Architecture {
  if (architecture === "amd64") return "x64";
  if (architecture === "arm64") return "arm64";
  throw new Error(`Managed vLLM recipe uses unsupported architecture ${architecture}.`);
}

function catalogModelVariant(
  catalogDigest: string,
  preset: ManagedInferenceServingPreset,
  recipe: HostLocalInferenceServingRecipe,
): CatalogModelVariant {
  const maxModelLen = Number(argumentValue(recipe.spec.serve.arguments, "--max-model-len"));
  if (!Number.isSafeInteger(maxModelLen) || maxModelLen <= 0) {
    throw new Error(`Managed vLLM recipe ${recipe.metadata.id} has no valid --max-model-len.`);
  }
  const gpuMemoryUtilization = hostLocalVllmGpuMemoryUtilization(recipe);
  const platform = preset.spec.plan.platform;
  if (!platform) {
    throw new Error(`Managed vLLM preset ${preset.metadata.id} has no platform.`);
  }
  const serveEnv = {
    ...recipe.spec.runtime.environment,
    HF_HOME: recipe.spec.runtime.modelCache.target,
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
  };
  const directInstall = recipe.spec.serve.directInstall;
  if (!directInstall) {
    throw new Error(`Managed vLLM recipe ${recipe.metadata.id} has no direct-install policy.`);
  }
  const servingCatalog = {
    catalogDigest,
    presetId: preset.metadata.id,
    presetDigest: managedInferenceDigest(preset),
    recipeId: recipe.metadata.id,
    recipeDigest: managedInferenceDigest(recipe),
  };
  return {
    id: recipe.spec.model.id,
    label: recipe.spec.model.displayName,
    envValue: recipe.spec.model.environmentValue,
    menuOrder: recipe.spec.model.menuOrder,
    downloadSizeBytes: recipe.spec.model.downloadSizeBytes,
    gated: recipe.spec.model.gated,
    capabilities: recipe.spec.model.capabilities,
    probePolicyRef: recipe.spec.model.probePolicyRef,
    platform,
    variant: {
      priority: preset.spec.priority,
      platforms: [platform],
      architectures: [nodeArchitecture(recipe.spec.runtime.architecture)],
      image: recipe.spec.runtime.image,
      imageDownloadSizeBytes: recipe.spec.runtime.imageDownloadSizeBytes,
      imageUnpackedSizeBytes: recipe.spec.runtime.imageUnpackedSizeBytes,
      modelDownloadSizeBytes: recipe.spec.model.downloadSizeBytes,
      loadTimeoutSec: recipe.spec.readiness.timeoutSeconds,
      pullTimeoutSec: recipe.spec.runtime.pullTimeoutSeconds,
      minComputeCapability:
        recipe.spec.runtime.minimumComputeCapability > 0
          ? recipe.spec.runtime.minimumComputeCapability
          : undefined,
      minGpuMemoryBytes: recipe.spec.runtime.minimumGpuMemoryBytes,
      gpuMemoryUtilization,
      dockerRunArgs: hostLocalVllmDockerRunArguments(recipe),
      dockerRunArgsMode: "replace",
      modelArgs: hostLocalVllmModelArguments(recipe),
      maxModelLen,
      revision: recipe.spec.model.revision,
      servedModelId: recipe.spec.model.servedName,
      serveEnv,
      installFastSafetensors: recipe.spec.model.installFastSafetensors,
      ...(directInstall.fixedArguments ? { fixedServeCommand: true as const } : {}),
      ...(directInstall.authentication === "bearer" ? { managedBearerAuth: true as const } : {}),
      trustRemoteCode: false,
      selection: preset.spec.selection === "automatic" ? "automatic" : "explicit-only",
      interactive: preset.spec.plan.interactive !== false,
      catalogPresetId: preset.metadata.id,
      orchestrationRef: recipe.spec.execution.orchestrationRef,
      stationPair: recipe.spec.execution.stationPair,
      ...(directInstall.catalogReceipt ? { servingCatalog } : {}),
    },
  };
}

function assertSameCatalogModel(left: CatalogModelVariant, right: CatalogModelVariant): void {
  const fields = [
    "id",
    "label",
    "envValue",
    "menuOrder",
    "downloadSizeBytes",
    "gated",
    "probePolicyRef",
  ] as const;
  const mismatch = fields.find((field) => left[field] !== right[field]);
  if (mismatch) {
    throw new Error(
      `Managed vLLM recipes for ${left.envValue} disagree on model field ${mismatch}.`,
    );
  }
  if (JSON.stringify(left.capabilities) !== JSON.stringify(right.capabilities)) {
    throw new Error(
      `Managed vLLM recipes for ${left.envValue} disagree on model field capabilities.`,
    );
  }
}

export function vllmModelsFromCatalog(
  catalog: CompiledManagedInferenceCatalog,
): readonly VllmModelDef[] {
  const recipes = new Map(catalog.recipes.map((recipe) => [recipe.metadata.id, recipe]));
  const variants = catalog.presets.flatMap((preset) => {
    if (preset.spec.selection === "disabled" || preset.spec.plan.backend !== "vllm") return [];
    const recipe = recipes.get(preset.spec.plan.recipeRef);
    if (!recipe || !isHostLocalInferenceServingRecipe(recipe)) return [];
    return [catalogModelVariant(catalog.catalogDigest, preset, recipe)];
  });
  const grouped = new Map<string, CatalogModelVariant[]>();
  for (const variant of variants) {
    const entries = grouped.get(variant.envValue) ?? [];
    if (entries[0]) assertSameCatalogModel(entries[0], variant);
    entries.push(variant);
    grouped.set(variant.envValue, entries);
  }
  return [...grouped.values()]
    .map((entries): VllmModelDef => {
      const ordered = [...entries].sort(
        (left, right) =>
          left.variant.priority - right.variant.priority ||
          left.variant.catalogPresetId.localeCompare(right.variant.catalogPresetId),
      );
      const base = ordered[0]!;
      const platformOrder: readonly VllmPlatform[] = ["spark", "station", "n1x", "linux"];
      const supportedPlatforms = new Set(ordered.map(({ platform }) => platform));
      const platforms = platformOrder.filter((platform) => supportedPlatforms.has(platform));
      const pickerPlatformSet = new Set(
        ordered.filter(({ variant }) => variant.interactive).map(({ platform }) => platform),
      );
      const pickerPlatforms = [
        ...platformOrder.filter((platform) => pickerPlatformSet.has(platform)),
      ];
      const runtime =
        ordered.length === 1
          ? {
              image: base.variant.image,
              imageDownloadSizeBytes: base.variant.imageDownloadSizeBytes,
              imageUnpackedSizeBytes: base.variant.imageUnpackedSizeBytes,
              modelDownloadSizeBytes: base.variant.modelDownloadSizeBytes,
              loadTimeoutSec: base.variant.loadTimeoutSec,
              dockerRunArgs: base.variant.dockerRunArgs,
              dockerRunArgsMode: base.variant.dockerRunArgsMode,
              pullTimeoutSec: base.variant.pullTimeoutSec,
              minComputeCapability: base.variant.minComputeCapability,
              minGpuMemoryBytes: base.variant.minGpuMemoryBytes,
              gpuMemoryUtilization: base.variant.gpuMemoryUtilization,
              orchestrationRef: base.variant.orchestrationRef,
              stationPair: base.variant.stationPair,
            }
          : undefined;
      const computeCapabilityFloors = ordered.flatMap(({ variant }) =>
        variant.minComputeCapability === undefined ? [] : [variant.minComputeCapability],
      );
      return {
        id: base.id,
        label: base.label,
        envValue: base.envValue,
        downloadSizeBytes: base.downloadSizeBytes,
        maxModelLen: base.variant.maxModelLen,
        revision: base.variant.revision,
        servedModelId: base.variant.servedModelId,
        modelArgs: base.variant.modelArgs,
        serveEnv: base.variant.serveEnv,
        gated: base.gated,
        platforms,
        pickerPlatforms,
        minComputeCapability:
          computeCapabilityFloors.length > 0 ? Math.min(...computeCapabilityFloors) : undefined,
        runtimeVariants: ordered.map(({ variant }) => variant),
        requireRuntimeVariant: true,
        ...(runtime ? { runtime } : {}),
        installFastSafetensors: base.variant.installFastSafetensors,
        fixedServeCommand: base.variant.fixedServeCommand,
        managedBearerAuth: base.variant.managedBearerAuth,
        trustRemoteCode: base.variant.trustRemoteCode,
        capabilities: base.capabilities,
        probePolicyRef: base.probePolicyRef,
      };
    })
    .sort((left, right) => {
      const leftOrder = grouped.get(left.envValue)![0]!.menuOrder;
      const rightOrder = grouped.get(right.envValue)![0]!.menuOrder;
      return leftOrder - rightOrder || left.envValue.localeCompare(right.envValue);
    });
}

export const VLLM_MODELS: readonly VllmModelDef[] = vllmModelsFromCatalog(
  loadManagedInferenceCatalog(),
);

const defaultVllmModel = VLLM_MODELS[0];
if (!defaultVllmModel) {
  throw new Error("Managed inference catalog has no host-local vLLM models.");
}
export const DEFAULT_VLLM_MODEL: VllmModelDef = defaultVllmModel;

/**
 * Rank a runtime platform declaration for a target host. Every specialized
 * NVIDIA appliance is still a Linux host, so a Linux declaration is the
 * baseline when no appliance-specific recipe exists. Exact declarations win.
 */
export function vllmPlatformSpecificity(
  platforms: readonly VllmPlatform[] | undefined,
  target: VllmPlatform,
): number {
  if (!platforms || platforms.length === 0) return 0;
  if (platforms.includes(target)) return 2;
  if (target !== "linux" && platforms.includes("linux")) return 1;
  return -1;
}

export function vllmModelForOrchestration(
  orchestrationRef: string,
  platform: VllmPlatform,
  architecture: NodeJS.Architecture = process.arch,
): VllmModelDef | undefined {
  const matches = VLLM_MODELS.filter((model) =>
    (model.runtimeVariants ?? []).some(
      (variant) =>
        variant.orchestrationRef === orchestrationRef &&
        vllmPlatformSpecificity(variant.platforms, platform) >= 0 &&
        (!variant.architectures || variant.architectures.includes(architecture)),
    ),
  );
  if (matches.length > 1) {
    throw new Error(
      `Managed vLLM catalog has ambiguous ${orchestrationRef} models for ${platform} on ${architecture}.`,
    );
  }
  return matches[0];
}

export function vllmModelUsesOrchestration(
  model: VllmModelDef,
  orchestrationRef: string,
  platform: VllmPlatform,
  architecture: NodeJS.Architecture = process.arch,
): boolean {
  return (model.runtimeVariants ?? []).some(
    (variant) =>
      variant.orchestrationRef === orchestrationRef &&
      vllmPlatformSpecificity(variant.platforms, platform) >= 0 &&
      (!variant.architectures || variant.architectures.includes(architecture)),
  );
}

export function vllmStationPairForOrchestration(
  model: VllmModelDef,
  orchestrationRef: string,
  platform: VllmPlatform,
  architecture: NodeJS.Architecture = process.arch,
): ServingStationPairOrchestration | undefined {
  const matches = (model.runtimeVariants ?? []).filter(
    (variant) =>
      variant.orchestrationRef === orchestrationRef &&
      vllmPlatformSpecificity(variant.platforms, platform) >= 0 &&
      (!variant.architectures || variant.architectures.includes(architecture)),
  );
  if (matches.length > 1) {
    throw new Error(
      `Managed vLLM catalog has ambiguous ${orchestrationRef} runtimes for ${model.envValue} on ${platform}/${architecture}.`,
    );
  }
  return matches[0]?.stationPair;
}

function defaultVllmCandidateForPlatform(
  platform: VllmPlatform,
  architecture: NodeJS.Architecture = process.arch,
): { readonly model: VllmModelDef; readonly variant: VllmRuntimeVariant } {
  const candidates = VLLM_MODELS.flatMap((model) =>
    (model.runtimeVariants ?? [])
      .filter(
        (variant) =>
          variant.selection === "automatic" &&
          vllmPlatformSpecificity(variant.platforms, platform) >= 0 &&
          (!variant.architectures || variant.architectures.includes(architecture)),
      )
      .map((variant) => ({ model, variant })),
  ).sort(
    (left, right) =>
      vllmPlatformSpecificity(right.variant.platforms, platform) -
        vllmPlatformSpecificity(left.variant.platforms, platform) ||
      right.variant.priority - left.variant.priority ||
      left.model.envValue.localeCompare(right.model.envValue),
  );
  if (candidates.length === 0) {
    throw new Error(`Managed vLLM catalog has no automatic ${platform} model for ${architecture}.`);
  }
  if (
    candidates[1] &&
    vllmPlatformSpecificity(candidates[1].variant.platforms, platform) ===
      vllmPlatformSpecificity(candidates[0]!.variant.platforms, platform) &&
    candidates[1].variant.priority === candidates[0]!.variant.priority
  ) {
    throw new Error(
      `Managed vLLM catalog has ambiguous automatic ${platform} models at priority ${String(candidates[0]!.variant.priority)}.`,
    );
  }
  return candidates[0]!;
}

export function defaultVllmModelForPlatform(
  platform: VllmPlatform,
  architecture: NodeJS.Architecture = process.arch,
): VllmModelDef {
  return defaultVllmCandidateForPlatform(platform, architecture).model;
}

export function defaultVllmRuntimeForPlatform(
  platform: VllmPlatform,
  architecture: NodeJS.Architecture = process.arch,
): VllmRuntimeVariant {
  return defaultVllmCandidateForPlatform(platform, architecture).variant;
}

/**
 * Subset of the registry that should appear in the interactive picker for a
 * given platform. Order matches registry order so callers can stably annotate
 * the recommended entry by id rather than position.
 */
export function modelsForPlatform(platform: VllmPlatform): readonly VllmModelDef[] {
  return VLLM_MODELS.filter((model) =>
    (model.pickerPlatforms ?? model.platforms).includes(platform),
  );
}

const HF_TOKEN_ENV_KEYS = ["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"] as const;
export const VLLM_EXTRA_ARGS_ENV = "NEMOCLAW_VLLM_EXTRA_ARGS_JSON";

/**
 * Look up the requested express-vLLM model from `NEMOCLAW_VLLM_MODEL`.
 * Returns `null` when the env var is empty so the caller can fall back to
 * the per-platform profile default (Station prefers DeepSeek V4 Flash, Spark
 * the Qwen3.6-35B-A3B NVFP4 checkpoint, and the generic Linux profile prefers
 * Nemotron-Nano-4B for VRAM headroom).
 *
 * Match is case-insensitive against either the `envValue` slug or the full
 * HF id. Throws when the env var names something not in the registry so the
 * user gets a single clear message instead of a downstream vLLM startup
 * failure.
 */
export function selectVllmModelFromEnv(env: NodeJS.ProcessEnv = process.env): VllmModelDef | null {
  const requested = String(env.NEMOCLAW_VLLM_MODEL ?? "")
    .trim()
    .toLowerCase();
  if (!requested) return null;
  const match = VLLM_MODELS.find(
    (model) => model.envValue.toLowerCase() === requested || model.id.toLowerCase() === requested,
  );
  if (match) return match;
  const choices = VLLM_MODELS.map((model) => `'${model.envValue}'`).join(", ");
  throw new Error(
    `Unknown NEMOCLAW_VLLM_MODEL='${env.NEMOCLAW_VLLM_MODEL}'. ` +
      `Recognised values: ${choices} (or the full Hugging Face model id).`,
  );
}

/**
 * Fail fast when a gated model is requested without a Hugging Face token.
 * The check runs before `vllm serve` starts pulling weights so we don't
 * burn 10+ minutes of bandwidth on a 401 the user will hit later.
 */
export function assertGatedModelAccess(
  model: VllmModelDef,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!model.gated) return;
  const hasToken = HF_TOKEN_ENV_KEYS.some((key) => String(env[key] ?? "").trim().length > 0);
  if (hasToken) return;
  throw new Error(
    `Model '${model.id}' is gated on Hugging Face. ` +
      `Accept the model's licence on its HF page, then export a token in one of: ` +
      `${HF_TOKEN_ENV_KEYS.join(", ")}.`,
  );
}

export type PreflightVllmModelResult = { ok: true } | { ok: false; message: string };

/**
 * Combined preflight for callers that hold a `NEMOCLAW_VLLM_MODEL` reference
 * but do not themselves invoke the vLLM installer — for example
 * `nemoclaw <name> connect`, which simply attaches to a running sandbox.
 *
 * The variable steers the express-vLLM install path, so on every other code
 * path the natural behaviour is to ignore it. Silent-ignore hides two real
 * user mistakes:
 *
 *   1. typos in the slug (`deepseek-r1-distill-70b` vs an old marketing
 *      name), surfaced later as the wrong model being served and a confused
 *      user; and
 *   2. requesting a gated model (DeepSeek-R1 Distill Llama 70B) without
 *      exporting `HF_TOKEN` / `HUGGING_FACE_HUB_TOKEN`, which downstream
 *      explodes as a 401 from Hugging Face partway through the pull.
 *
 * Running the same `selectVllmModelFromEnv` + `assertGatedModelAccess` checks
 * the installer uses gives the caller a single fail-fast surface and one
 * canonical message to print before any side effects. Returns
 * `{ ok: true }` when the variable is unset or resolves cleanly.
 */
export function preflightVllmModelEnv(
  env: NodeJS.ProcessEnv = process.env,
): PreflightVllmModelResult {
  try {
    parseVllmExtraServeArgs(env);
    const model = selectVllmModelFromEnv(env);
    if (!model) return { ok: true };
    assertGatedModelAccess(model, env);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export function parseVllmExtraServeArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = String(env[VLLM_EXTRA_ARGS_ENV] ?? "").trim();
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${VLLM_EXTRA_ARGS_ENV} must be a JSON array of vLLM serve argument strings: ${
        (err as Error).message
      }`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${VLLM_EXTRA_ARGS_ENV} must be a JSON array of strings.`);
  }

  return parsed.map((value, index) => {
    if (typeof value !== "string") {
      throw new Error(`${VLLM_EXTRA_ARGS_ENV}[${String(index)}] must be a string.`);
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new Error(`${VLLM_EXTRA_ARGS_ENV}[${String(index)}] must not be empty.`);
    }
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
      throw new Error(
        `${VLLM_EXTRA_ARGS_ENV}[${String(index)}] must not contain control characters.`,
      );
    }
    return trimmed;
  });
}

const VLLM_GPU_MEMORY_UTILIZATION_ARG = "--gpu-memory-utilization";

function validateVllmGpuMemoryUtilization(utilization: number): number {
  if (!Number.isFinite(utilization) || utilization <= 0 || utilization > 1) {
    throw new Error(
      `${VLLM_GPU_MEMORY_UTILIZATION_ARG} must be a decimal number greater than 0 and at most 1.`,
    );
  }
  return utilization;
}

function parseVllmGpuMemoryUtilization(value: string): number {
  if (!/^[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?)|(?:\.[0-9]+))(?:[eE][+-]?[0-9]+)?$/.test(value)) {
    throw new Error(
      `${VLLM_GPU_MEMORY_UTILIZATION_ARG} must be a decimal number greater than 0 and at most 1.`,
    );
  }
  return validateVllmGpuMemoryUtilization(Number(value));
}

/** Resolve the last operator override exactly as the appended vLLM argv does. */
export function resolveVllmGpuMemoryUtilization(
  recipeUtilization: number | undefined,
  extraServeArgs: readonly string[],
): number | undefined {
  let utilization =
    recipeUtilization === undefined
      ? undefined
      : validateVllmGpuMemoryUtilization(recipeUtilization);
  for (let index = 0; index < extraServeArgs.length; index += 1) {
    const argument = extraServeArgs[index]!;
    const separator = argument.indexOf("=");
    const option = separator < 0 ? argument : argument.slice(0, separator);
    const normalizedOption = option.replaceAll("_", "-");
    if (
      normalizedOption.length > 2 &&
      VLLM_GPU_MEMORY_UTILIZATION_ARG.startsWith(normalizedOption) &&
      normalizedOption !== VLLM_GPU_MEMORY_UTILIZATION_ARG
    ) {
      throw new Error(
        `GPU memory utilization overrides must use the full ${VLLM_GPU_MEMORY_UTILIZATION_ARG} option name.`,
      );
    }
    if (normalizedOption !== VLLM_GPU_MEMORY_UTILIZATION_ARG) continue;
    let value: string | undefined;
    if (separator < 0) {
      value = extraServeArgs[index + 1];
      if (value === undefined) {
        throw new Error(`${VLLM_GPU_MEMORY_UTILIZATION_ARG} requires a value.`);
      }
      index += 1;
    } else {
      value = argument.slice(separator + 1);
    }
    utilization = parseVllmGpuMemoryUtilization(value);
  }
  return utilization;
}

const SHARED_VLLM_ARGS: readonly string[] = [
  "--tensor-parallel-size",
  "1",
  "--pipeline-parallel-size",
  "1",
  "--data-parallel-size",
  "1",
  "--port",
  "8000",
  "--trust-remote-code",
] as const;

const FIXED_HOST_LOCAL_VLLM_ARGS: readonly string[] = [
  "--tensor-parallel-size",
  "1",
  "--pipeline-parallel-size",
  "1",
  "--data-parallel-size",
  "1",
  "--port",
  "8000",
] as const;

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function rewriteVllmArgs(
  args: readonly string[],
  overrides: Readonly<Record<string, string>>,
  omittedFlags: ReadonlySet<string> = new Set(),
): string[] {
  const result: string[] = [];
  const remainingOverrides = new Set(Object.keys(overrides));
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (omittedFlags.has(arg)) {
      if (index === args.length - 1) throw new Error(`Missing value for vLLM argument '${arg}'.`);
      index += 1;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(overrides, arg)) {
      if (index === args.length - 1) throw new Error(`Missing value for vLLM argument '${arg}'.`);
      result.push(arg, overrides[arg]);
      remainingOverrides.delete(arg);
      index += 1;
      continue;
    }
    result.push(arg);
  }
  if (remainingOverrides.size > 0) {
    throw new Error(`Cannot override missing vLLM argument '${[...remainingOverrides][0]}'.`);
  }
  return result;
}

export interface NemotronUltraDistributedServeOptions {
  /** Ray role: rank 0 owns the API and rank 1 is the worker. */
  nodeRank: 0 | 1;
  /** Routable head address used by both nodes for the Ray control plane. */
  masterAddr: string;
  /** Routable Ray head port. */
  masterPort: number;
  /** vLLM API port exposed by the Ray head. */
  apiPort: number;
  /** Routable address of the node running this command. */
  nodeAddr?: string;
}

/**
 * Build one side of the published two-Station Nemotron Ultra vLLM v0.25.1
 * Ray pipeline-parallel launch. Existing callers keep the single-node
 * registry command unless they opt into this role/address/port API.
 */
export function buildNemotronUltraDistributedServeCommand(
  options: NemotronUltraDistributedServeOptions,
): string {
  if (options.nodeRank !== 0 && options.nodeRank !== 1) {
    throw new Error("Nemotron Ultra distributed nodeRank must be 0 or 1.");
  }
  const masterAddr = options.masterAddr.trim();
  if (net.isIP(masterAddr) !== 4) {
    throw new Error("Nemotron Ultra distributed masterAddr must be a canonical IPv4 address.");
  }
  if (
    !Number.isInteger(options.masterPort) ||
    options.masterPort < 1 ||
    options.masterPort > 65535
  ) {
    throw new Error("Nemotron Ultra distributed masterPort must be an integer from 1 to 65535.");
  }
  if (!Number.isInteger(options.apiPort) || options.apiPort < 1024 || options.apiPort > 65535) {
    throw new Error("Nemotron Ultra distributed apiPort must be an integer from 1024 to 65535.");
  }
  const nodeAddr = (options.nodeAddr ?? masterAddr).trim();
  if (net.isIP(nodeAddr) !== 4) {
    throw new Error("Nemotron Ultra distributed nodeAddr must be a canonical IPv4 address.");
  }
  if (options.nodeRank === 0 && nodeAddr !== masterAddr) {
    throw new Error("Nemotron Ultra Ray head nodeAddr must match masterAddr.");
  }

  const model = vllmModelForOrchestration(STATION_PAIR_OPTIONAL_ORCHESTRATION, "station", "arm64");
  const stationPair = model
    ? vllmStationPairForOrchestration(
        model,
        STATION_PAIR_OPTIONAL_ORCHESTRATION,
        "station",
        "arm64",
      )
    : undefined;
  if (!model?.revision || !stationPair) {
    throw new Error(
      "Station-pair distributed serving requires a pinned revision and orchestration config.",
    );
  }

  const sharedArgs = rewriteVllmArgs(FIXED_HOST_LOCAL_VLLM_ARGS, {
    "--tensor-parallel-size": String(stationPair.tensorParallelSize),
    "--pipeline-parallel-size": String(stationPair.pipelineParallelSize),
    "--port": String(options.apiPort),
  });
  const modelArgs = rewriteVllmArgs(
    model.modelArgs,
    {
      "--max-num-seqs": "256",
      "--gpu-memory-utilization": String(DUAL_STATION_VLLM_GPU_MEMORY_UTILIZATION),
    },
    new Set([
      "--cpu-offload-gb",
      "--cpu-offload-params",
      "--kernel-config",
      "--speculative-config",
      "--default-chat-template-kwargs",
    ]),
  );
  const args = [
    ...sharedArgs,
    // Rank 0 binds only to the selected direct-attach RoCE address. This
    // keeps the API off the management network while still giving the
    // OpenShell route a host-reachable endpoint. The Ray worker exposes no API.
    "--host",
    masterAddr,
    "--distributed-executor-backend",
    "ray",
    "--kv-cache-dtype",
    "fp8",
    "--max-model-len",
    "262144",
    "--distributed-timeout-seconds",
    "7200",
    "--enable-prefix-caching",
    "--revision",
    model.revision,
    "--served-model-name",
    stationPair.servedName,
    ...modelArgs,
  ];
  const bootstrap = [
    "set -euo pipefail",
    'export PATH="$HOME/.local/bin:$PATH"',
    'python3 -m pip install --user --no-cache-dir "ray==2.56.0"',
  ];
  if (options.nodeRank === 1) {
    return [
      ...bootstrap,
      "python3 - <<'PY'",
      "import socket",
      "import time",
      `address = (${JSON.stringify(masterAddr)}, ${String(options.masterPort)})`,
      "deadline = time.time() + 3600",
      "while True:",
      "    try:",
      "        with socket.create_connection(address, timeout=5):",
      "            break",
      "    except OSError:",
      "        if time.time() >= deadline:",
      '            raise TimeoutError("Ray head did not become reachable within 3600 seconds")',
      "        time.sleep(5)",
      "PY",
      `exec ray start --address=${shellQuote(`${masterAddr}:${String(options.masterPort)}`)} --node-ip-address=${shellQuote(nodeAddr)} --num-gpus=1 --block`,
    ].join("\n");
  }
  return [
    ...bootstrap,
    `ray start --head --node-ip-address=${shellQuote(masterAddr)} --port=${String(options.masterPort)} --num-gpus=1`,
    "python3 - <<'PY'",
    "import time",
    "import ray",
    'ray.init(address="auto")',
    "deadline = time.time() + 3600",
    'while ray.cluster_resources().get("GPU", 0) < 2:',
    "    if time.time() >= deadline:",
    '        raise TimeoutError("peer DGX Station GPU did not join Ray within 3600 seconds")',
    "    time.sleep(5)",
    "print(ray.cluster_resources())",
    "PY",
    `exec vllm serve ${[model.id, ...args].map(shellQuote).join(" ")}`,
  ].join("\n");
}

/**
 * Build the `vllm serve` command line for the supplied model: the shared
 * serving flags merged with the model-specific args from the registry.
 *
 * By default the command is prefixed with the `pip install` that pulls the
 * `fastsafetensors` extra so existing express scripts keep working. A pinned
 * runtime that already contains everything its recipe needs may disable that
 * mutation with `installFastSafetensors: false`; a model may also prepend env
 * exports via `serveEnv`.
 */
export function buildVllmServeCommand(
  model: VllmModelDef,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const envPrefix =
    model.serveEnv && Object.keys(model.serveEnv).length > 0
      ? `${Object.entries(model.serveEnv)
          .map(([key, value]) => {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
              throw new Error(`Invalid vLLM serving environment variable name: ${key}`);
            }
            return `export ${key}=${shellQuote(value)}`;
          })
          .join(" && ")} && `
      : "";
  const args = [
    ...(model.fixedServeCommand || model.trustRemoteCode === false
      ? FIXED_HOST_LOCAL_VLLM_ARGS
      : SHARED_VLLM_ARGS),
    "--max-model-len",
    String(model.maxModelLen),
    ...(model.revision ? ["--revision", model.revision] : []),
    ...(model.servedModelId ? ["--served-model-name", model.servedModelId] : []),
    ...model.modelArgs,
  ];
  const extraArgs = model.fixedServeCommand ? [] : parseVllmExtraServeArgs(env);
  const setup =
    model.installFastSafetensors === false ? "" : "pip install vllm[fastsafetensors] && ";
  return `${envPrefix}${setup}vllm serve ${[model.id, ...args, ...extraArgs]
    .map(shellQuote)
    .join(" ")}`;
}
