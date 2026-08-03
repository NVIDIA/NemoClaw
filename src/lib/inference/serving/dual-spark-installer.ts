// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isAffirmativeAnswer } from "../../onboard/prompt-helpers.js";
import type { VllmProfile } from "../vllm.js";
import { ensureManagedVllmApiKey } from "../vllm-api-key.js";
import { assertGatedModelAccess, type VllmModelDef, VLLM_EXTRA_ARGS_ENV } from "../vllm-models.js";
import { clearDualStationSshBinding } from "../vllm-station-ssh-binding.js";
import { imageStorageRequirementBytes, modelStorageRequirementBytes } from "../vllm-storage.js";
import {
  type ManagedInferenceResolution,
  type ManagedInferenceResolverInput,
  type ManagedInferenceServingRecipe,
} from "./catalog-types.js";
import {
  claimDualSparkManagedServingCapability,
  type DualSparkConfirmedManagedServingCapability,
  type DualSparkDetectedManagedServingCapability,
  type DualSparkHostObservation,
  type DualSparkStorageCapacityObservation,
  NEMOCLAW_DGX_SPARK_PEER_ENV,
  NEMOCLAW_SERVING_PRESET_ENV,
  probeDualSparkManagedServingCapability,
  revalidateDualSparkManagedServingCapability,
} from "./dual-spark-discovery.js";
import {
  type CreateDualSparkVllmExecutorOptions,
  createDualSparkVllmExecutor,
  type DualSparkExecutorStageNode,
} from "./dual-spark-executor.js";
import {
  cleanupDualSparkManagedVllm,
  type StartDualSparkVllmResult,
  startAutomaticDualSparkVllm,
} from "./dual-spark-lifecycle.js";
import {
  DUAL_SPARK_VLLM_MASTER_PORT,
  type DualSparkVllmPlan,
  materializeDualSparkVllmPlan,
} from "./dual-spark-materialize.js";
import type { DualSparkTopologyOutput } from "./dual-spark-topology.js";
import { assertNoManagedDistributedVllmRuntimeReceipts } from "./managed-runtime-receipts.js";
import { resolveManagedInferenceServing } from "./resolver.js";
import {
  type PersistDualSparkVllmRuntimeReceiptInput,
  persistDualSparkVllmRuntimeReceipt,
} from "./spark-runtime-receipt.js";

export interface DualSparkInstallerOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly nonInteractive: boolean;
  readonly platform: VllmProfile["platform"];
  readonly promptFn: (question: string) => Promise<string>;
  readonly beforeInstall?: (modelId: string) => void;
}

export interface DualSparkInstallerEffects {
  readonly prerequisites: () => { ok: boolean; reason?: string };
  readonly pullImage: (
    profile: VllmProfile,
    dockerEnv: Record<string, string>,
  ) => Promise<{ ok: boolean; reason?: string }>;
  readonly downloadModel: (
    profile: VllmProfile,
    model: VllmModelDef,
    dockerEnv: Record<string, string>,
    target: { hostCacheDir: string; userIdentity: string },
  ) => Promise<{ ok: boolean; reason?: string }>;
  readonly printDownloadAuthentication: (nonInteractive: boolean) => void;
}

export type DualSparkInstallerResult =
  | { readonly kind: "not-selected" }
  | { readonly kind: "handled"; readonly result: { readonly ok: boolean } };

interface DualSparkInstallerDeps {
  readonly probeCapability: typeof probeDualSparkManagedServingCapability;
  readonly revalidateCapability: typeof revalidateDualSparkManagedServingCapability;
  readonly claimCapability: typeof claimDualSparkManagedServingCapability;
  readonly resolveSelection: (
    input: ManagedInferenceResolverInput<DualSparkTopologyOutput>,
  ) => ManagedInferenceResolution<DualSparkTopologyOutput>;
  readonly materializePlan: typeof materializeDualSparkVllmPlan;
  readonly createExecutor: typeof createDualSparkVllmExecutor;
  readonly start: typeof startAutomaticDualSparkVllm;
  readonly cleanup: typeof cleanupDualSparkManagedVllm;
  readonly persistReceipt: typeof persistDualSparkVllmRuntimeReceipt;
  readonly ensureApiKey: typeof ensureManagedVllmApiKey;
  readonly assertNoRuntimeReceipts: typeof assertNoManagedDistributedVllmRuntimeReceipts;
  readonly clearBinding: typeof clearDualStationSshBinding;
  readonly assertGatedModelAccess: typeof assertGatedModelAccess;
  readonly log: (line?: string) => void;
  readonly error: (line: string) => void;
  readonly warn: (line: string) => void;
}

const DEFAULT_DEPS: DualSparkInstallerDeps = {
  probeCapability: probeDualSparkManagedServingCapability,
  revalidateCapability: revalidateDualSparkManagedServingCapability,
  claimCapability: claimDualSparkManagedServingCapability,
  resolveSelection: resolveManagedInferenceServing,
  materializePlan: materializeDualSparkVllmPlan,
  createExecutor: createDualSparkVllmExecutor,
  start: startAutomaticDualSparkVllm,
  cleanup: cleanupDualSparkManagedVllm,
  persistReceipt: persistDualSparkVllmRuntimeReceipt,
  ensureApiKey: ensureManagedVllmApiKey,
  assertNoRuntimeReceipts: assertNoManagedDistributedVllmRuntimeReceipts,
  clearBinding: clearDualStationSshBinding,
  assertGatedModelAccess,
  log: (line = "") => console.log(line),
  error: (line) => console.error(line),
  warn: (line) => console.warn(line),
};

const VLLM_WRITABLE_ALLOWANCE_BYTES = 816_000_000n;

type SelectedRecipeAdmissionFailure = {
  readonly code:
    | "runtime-conflict"
    | "runtime-unknown"
    | "storage-unavailable"
    | "storage-insufficient";
  readonly reason: string;
};

function recipeApiPort(recipe: ManagedInferenceServingRecipe): number | null {
  const ports = recipe.spec.serve.arguments
    .filter(({ name }) => name === "--port")
    .map(({ value }) => Number(value));
  return ports.length === 1 &&
    Number.isSafeInteger(ports[0]) &&
    ports[0]! > 0 &&
    ports[0]! <= 65_535
    ? ports[0]!
    : null;
}

function selectedHostStorageFailure(
  host: DualSparkHostObservation,
  label: string,
  recipe: ManagedInferenceServingRecipe,
): SelectedRecipeAdmissionFailure | null {
  const requirements = new Map<string, bigint>();
  const available = new Map<string, bigint>();
  const add = (capacity: DualSparkStorageCapacityObservation, required: bigint): boolean => {
    if (capacity.filesystemId === null || capacity.availableBytes === null) return false;
    requirements.set(
      capacity.filesystemId,
      (requirements.get(capacity.filesystemId) ?? 0n) + required,
    );
    const bytes = BigInt(capacity.availableBytes);
    const prior = available.get(capacity.filesystemId);
    available.set(capacity.filesystemId, prior === undefined || bytes < prior ? bytes : prior);
    return true;
  };
  if (
    !add(
      host.storage.huggingFace,
      modelStorageRequirementBytes(recipe.spec.model.downloadSizeBytes) +
        VLLM_WRITABLE_ALLOWANCE_BYTES,
    ) ||
    !add(
      host.storage.docker,
      imageStorageRequirementBytes(recipe.spec.runtime.imageDownloadSizeBytes),
    )
  ) {
    return {
      code: "storage-unavailable",
      reason: `${label} cache or Docker filesystem capacity could not be proven.`,
    };
  }
  for (const [filesystemId, required] of requirements) {
    if ((available.get(filesystemId) ?? -1n) < required) {
      return {
        code: "storage-insufficient",
        reason: `${label} filesystem ${filesystemId} lacks capacity for the selected image, model, staging, and writable allowance.`,
      };
    }
  }
  return null;
}

function selectedRecipeAdmissionFailure(
  capability: DualSparkDetectedManagedServingCapability,
  recipe: ManagedInferenceServingRecipe,
): SelectedRecipeAdmissionFailure | null {
  const apiPort = recipeApiPort(recipe);
  if (apiPort === null) {
    return { code: "runtime-unknown", reason: "The selected recipe serving port is invalid." };
  }
  for (const [host, label] of [
    [capability.local, "Local DGX Spark"],
    [capability.peer, "Peer DGX Spark"],
  ] as const) {
    const occupied = host.runtimeSnapshot.listeningPorts.find(
      (port) => port === apiPort || port === DUAL_SPARK_VLLM_MASTER_PORT,
    );
    if (occupied !== undefined) {
      return {
        code: "runtime-conflict",
        reason: `${label} port ${String(occupied)} is already in use; its listener was not changed.`,
      };
    }
    const storage = selectedHostStorageFailure(host, label, recipe);
    if (storage) return storage;
  }
  return null;
}

function structuredArguments(recipe: ManagedInferenceServingRecipe): string[] {
  return recipe.spec.serve.arguments.flatMap(({ name, value }) =>
    value === undefined ? [name] : [name, String(value)],
  );
}

function requiredPositiveIntegerArgument(
  recipe: ManagedInferenceServingRecipe,
  name: string,
): number {
  const matches = recipe.spec.serve.arguments.filter((argument) => argument.name === name);
  const value = matches.length === 1 ? Number(matches[0]?.value) : Number.NaN;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Selected serving recipe must define one positive ${name} argument.`);
  }
  return value;
}

function managedProfile(
  plan: DualSparkVllmPlan,
  recipe: ManagedInferenceServingRecipe,
): VllmProfile {
  return {
    name: recipe.metadata.displayName,
    platform: "spark",
    image: plan.roles.head.image,
    imageDownloadSizeBytes: plan.roles.head.runtime.imageDownloadSizeBytes,
    defaultModel: managedModel(plan, recipe),
    containerName: plan.roles.head.containerName,
    dockerRunFlags: [],
    pullTimeoutSec: recipe.spec.runtime.pullTimeoutSeconds,
    loadTimeoutSec: Math.ceil(plan.readiness.timeoutMs / 1000),
    modelDownloadSizeBytes: plan.roles.head.preparation.modelDownloadSizeBytes,
  };
}

function managedModel(
  plan: DualSparkVllmPlan,
  recipe: ManagedInferenceServingRecipe,
): VllmModelDef {
  return {
    id: plan.model.id,
    label: recipe.metadata.displayName,
    envValue: plan.model.servedName,
    downloadSizeBytes: plan.roles.head.preparation.modelDownloadSizeBytes,
    maxModelLen: requiredPositiveIntegerArgument(recipe, "--max-model-len"),
    revision: plan.model.revision,
    servedModelId: plan.model.servedName,
    modelArgs: structuredArguments(recipe),
    gated: recipe.spec.model.gated,
    platforms: ["spark"],
    installFastSafetensors: recipe.spec.model.installFastSafetensors,
  };
}

function selectionIntent(env: NodeJS.ProcessEnv) {
  const configuredPreset = String(env[NEMOCLAW_SERVING_PRESET_ENV] ?? "").trim();
  const configuredModel = String(env.NEMOCLAW_VLLM_MODEL ?? "").trim();
  const extraArguments = String(env[VLLM_EXTRA_ARGS_ENV] ?? "").trim();
  return {
    ...(configuredPreset ? { preset: configuredPreset } : {}),
    ...(configuredModel ? { vllmModel: configuredModel } : {}),
    ...(extraArguments ? { vllmExtraArguments: [extraArguments] } : {}),
  };
}

function automaticIntentDefersToLegacy(env: NodeJS.ProcessEnv): boolean {
  const pairIntent =
    String(env[NEMOCLAW_DGX_SPARK_PEER_ENV] ?? "").trim() ||
    String(env[NEMOCLAW_SERVING_PRESET_ENV] ?? "").trim();
  if (pairIntent) return false;
  return Boolean(
    String(env.NEMOCLAW_VLLM_MODEL ?? "").trim() || String(env[VLLM_EXTRA_ARGS_ENV] ?? "").trim(),
  );
}

function printSummary(
  capability: DualSparkDetectedManagedServingCapability,
  plan: DualSparkVllmPlan,
  deps: DualSparkInstallerDeps,
): void {
  const rails = capability.topology.output.rails
    .map(
      ({ head, worker }) =>
        `${head.address}/${String(head.prefixLength)} to ${worker.address}/${String(worker.prefixLength)}`,
    )
    .join(", ");
  deps.log();
  deps.log("  vLLM (two DGX Sparks, experimental):");
  deps.log(`    Serving profile: ${plan.presetId}`);
  deps.log(`    Recipe: ${plan.recipeId}`);
  deps.log(`    Image: ${plan.roles.head.image}`);
  deps.log(`    Model: ${plan.model.id}@${plan.model.revision}`);
  deps.log(`    Served model: ${plan.model.servedName}`);
  deps.log(`    Topology: ${capability.local.hostname} + ${capability.peer.hostname}`);
  deps.log(`    Direct rails: ${rails}`);
  deps.log(
    `    RoCEv2 GIDs: ${capability.topology.output.rails
      .map(({ head, worker }) => `${String(head.roceGid.index)}/${String(worker.roceGid.index)}`)
      .join(", ")}`,
  );
  deps.log(
    `    Model caches: ${capability.local.storage.huggingFace.cacheRoot}, ${capability.peer.storage.huggingFace.cacheRoot}`,
  );
  deps.log("    Launch order: worker first, then head");
  deps.log("    Restart policy: none; a stopped pair requires explicit cleanup");
  deps.log("    Experimental: physical two-node end-to-end validation is pending");
}

function resolutionFailure(
  resolution: Exclude<ManagedInferenceResolution<DualSparkTopologyOutput>, { outcome: "selected" }>,
  selectionIntent: DualSparkDetectedManagedServingCapability["selectionIntent"],
  allowAutomaticFallback: boolean,
  deps: DualSparkInstallerDeps,
): DualSparkInstallerResult {
  if (
    allowAutomaticFallback &&
    selectionIntent === "automatic" &&
    resolution.outcome === "no-match"
  ) {
    return { kind: "not-selected" };
  }
  deps.error(`  Two-Spark managed vLLM setup unavailable: ${resolution.message}`);
  return { kind: "handled", result: { ok: false } };
}

function admissionFailure(
  failure: SelectedRecipeAdmissionFailure,
  selectionIntent: DualSparkDetectedManagedServingCapability["selectionIntent"],
  allowAutomaticFallback: boolean,
  deps: DualSparkInstallerDeps,
): DualSparkInstallerResult {
  if (
    allowAutomaticFallback &&
    selectionIntent === "automatic" &&
    (failure.code === "storage-unavailable" || failure.code === "storage-insufficient")
  ) {
    return { kind: "not-selected" };
  }
  deps.error(`  Two-Spark managed vLLM setup stopped: ${failure.reason}`);
  return { kind: "handled", result: { ok: false } };
}

function receiptInput(
  capability: DualSparkConfirmedManagedServingCapability,
  plan: DualSparkVllmPlan,
  started: Extract<StartDualSparkVllmResult, { ok: true }>,
): PersistDualSparkVllmRuntimeReceiptInput {
  return {
    plan,
    peerSshBinding: capability.peerSshBinding,
    localCacheRoot: capability.local.storage.huggingFace.cacheRoot,
    peerCacheRoot: capability.peer.storage.huggingFace.cacheRoot,
    apiKeyFingerprint: started.apiKeyFingerprint,
    headContainerId: started.headContainerId,
    workerContainerId: started.workerContainerId,
  };
}

/** Select and run the automatic two-Spark profile without changing the legacy Spark path. */
export async function tryInstallDualSparkManagedVllm(
  options: DualSparkInstallerOptions,
  effects: DualSparkInstallerEffects,
  overrides: Partial<DualSparkInstallerDeps> = {},
): Promise<DualSparkInstallerResult> {
  if (options.platform !== "spark") return { kind: "not-selected" };
  const env = options.env ?? process.env;
  const deferToLegacy = automaticIntentDefersToLegacy(env);

  const deps = { ...DEFAULT_DEPS, ...overrides };
  try {
    deps.assertNoRuntimeReceipts();
  } catch (error) {
    deps.error(`  Managed vLLM setup stopped: ${(error as Error).message}`);
    return { kind: "handled", result: { ok: false } };
  }

  const detected = deps.probeCapability({ env });
  if (detected.kind === "not-selected" && detected.code === "no-match") {
    return { kind: "not-selected" };
  }
  if (detected.kind !== "ready") {
    deps.error(`  Two-Spark managed vLLM setup stopped: ${detected.reason}`);
    return { kind: "handled", result: { ok: false } };
  }

  let confirmedBinding: DualSparkConfirmedManagedServingCapability | null = null;
  let retainBinding = false;
  try {
    // Explicit legacy model/argument intent keeps the single-Spark path, but
    // only after read-only discovery has proved that doing so will not overlap
    // a related distributed runtime or ambiguous binding.
    if (deferToLegacy) return { kind: "not-selected" };

    const previewResolution = deps.resolveSelection({
      readinessReports: detected.readiness,
      topologyQualifications: [detected.topology],
      intent: selectionIntent(env),
    });
    if (previewResolution.outcome !== "selected") {
      return resolutionFailure(previewResolution, detected.selectionIntent, true, deps);
    }
    const previewAdmission = selectedRecipeAdmissionFailure(detected, previewResolution.recipe);
    if (previewAdmission) {
      return admissionFailure(previewAdmission, detected.selectionIntent, true, deps);
    }

    let previewPlan: DualSparkVllmPlan;
    try {
      previewPlan = deps.materializePlan(previewResolution);
    } catch (error) {
      deps.error(`  Two-Spark managed vLLM setup stopped: ${(error as Error).message}`);
      return { kind: "handled", result: { ok: false } };
    }
    try {
      deps.assertGatedModelAccess(managedModel(previewPlan, previewResolution.recipe), env);
    } catch (error) {
      deps.error(`  Two-Spark managed vLLM setup stopped: ${(error as Error).message}`);
      return { kind: "handled", result: { ok: false } };
    }
    printSummary(detected, previewPlan, deps);
    effects.printDownloadAuthentication(options.nonInteractive);
    deps.log();

    const proceed =
      options.nonInteractive || isAffirmativeAnswer(await options.promptFn("  Continue? [y/N]: "));
    if (!proceed) return { kind: "handled", result: { ok: false } };

    try {
      deps.assertNoRuntimeReceipts();
    } catch (error) {
      deps.error(`  Managed vLLM setup stopped: ${(error as Error).message}`);
      return { kind: "handled", result: { ok: false } };
    }

    const revalidated = deps.revalidateCapability(detected, { env });
    if (revalidated.kind !== "ready") {
      deps.error(`  Two-Spark managed vLLM setup stopped: ${revalidated.reason}`);
      return { kind: "handled", result: { ok: false } };
    }

    const revalidatedResolution = deps.resolveSelection({
      readinessReports: revalidated.readiness,
      topologyQualifications: [revalidated.topology],
      intent: selectionIntent(env),
    });
    if (revalidatedResolution.outcome !== "selected") {
      return resolutionFailure(revalidatedResolution, revalidated.selectionIntent, false, deps);
    }
    const revalidatedAdmission = selectedRecipeAdmissionFailure(
      revalidated,
      revalidatedResolution.recipe,
    );
    if (revalidatedAdmission) {
      return admissionFailure(revalidatedAdmission, revalidated.selectionIntent, false, deps);
    }
    if (
      revalidatedResolution.presetDigest !== previewResolution.presetDigest ||
      revalidatedResolution.recipeDigest !== previewResolution.recipeDigest
    ) {
      deps.error("  Two-Spark managed vLLM setup stopped: the selected profile changed.");
      return { kind: "handled", result: { ok: false } };
    }

    const confirmation = deps.claimCapability(revalidated);
    if (confirmation.kind !== "ready") {
      deps.error(`  Two-Spark managed vLLM setup stopped: ${confirmation.reason}`);
      return { kind: "handled", result: { ok: false } };
    }
    confirmedBinding = confirmation;
    const resolution = {
      ...revalidatedResolution,
      topologyQualification: confirmation.topology,
    };

    let plan: DualSparkVllmPlan;
    try {
      plan = deps.materializePlan(resolution);
    } catch (error) {
      deps.error(`  Two-Spark managed vLLM setup stopped: ${(error as Error).message}`);
      return { kind: "handled", result: { ok: false } };
    }
    if (
      plan.presetId !== previewPlan.presetId ||
      plan.recipeId !== previewPlan.recipeId ||
      plan.model.id !== previewPlan.model.id ||
      plan.model.revision !== previewPlan.model.revision ||
      plan.model.servedName !== previewPlan.model.servedName ||
      plan.roles.head.image !== previewPlan.roles.head.image
    ) {
      deps.error("  Two-Spark managed vLLM setup stopped: the presented serving plan changed.");
      return { kind: "handled", result: { ok: false } };
    }

    const profile = managedProfile(plan, resolution.recipe);
    const model = managedModel(plan, resolution.recipe);
    options.beforeInstall?.(plan.model.servedName);

    const prerequisites = effects.prerequisites();
    if (!prerequisites.ok) {
      deps.error(`  vLLM install failed: ${prerequisites.reason ?? "prerequisites unavailable"}`);
      return { kind: "handled", result: { ok: false } };
    }

    let apiKey: string;
    try {
      apiKey = deps.ensureApiKey();
    } catch (error) {
      deps.error(`  vLLM install failed: ${(error as Error).message}`);
      return { kind: "handled", result: { ok: false } };
    }

    const hosts = {
      head: confirmation.local,
      worker: confirmation.peer,
    } as const;
    const stageNode: DualSparkExecutorStageNode = async (_request, target) => {
      const host = hosts[target.role];
      deps.log(`  ==> Staging pinned vLLM image and model on ${host.hostname}`);
      const pull = await effects.pullImage(profile, { ...target.dockerEnv });
      if (!pull.ok) return pull;
      return await effects.downloadModel(
        profile,
        model,
        { ...target.dockerEnv },
        {
          hostCacheDir: target.modelCacheRoot,
          userIdentity: `${String(host.uid)}:${String(host.gid)}`,
        },
      );
    };
    const executorOptions: CreateDualSparkVllmExecutorOptions = {
      plan,
      peerSshBinding: confirmation.peerSshBinding,
      localCacheRoot: confirmation.local.storage.huggingFace.cacheRoot,
      peerCacheRoot: confirmation.peer.storage.huggingFace.cacheRoot,
      stageNode,
    };
    const executor = deps.createExecutor(executorOptions);
    retainBinding = true;
    const started = await deps.start(plan, apiKey, executor);
    if (!started.ok) {
      retainBinding = started.rollbackErrors.length > 0;
      deps.error(`  vLLM install failed: ${started.reason}`);
      for (const warning of started.rollbackErrors)
        deps.warn(`  vLLM rollback warning: ${warning}`);
      return { kind: "handled", result: { ok: false } };
    }

    try {
      deps.persistReceipt(receiptInput(confirmation, plan, started));
      retainBinding = false;
    } catch (error) {
      if (!started.reusedExisting) {
        const cleanup = await deps.cleanup(plan, apiKey, executor);
        const expected = new Set([started.headContainerId, started.workerContainerId]);
        if (
          cleanup.ok &&
          cleanup.removedContainerIds.length === expected.size &&
          new Set(cleanup.removedContainerIds).size === expected.size &&
          cleanup.removedContainerIds.every((id) => expected.has(id))
        ) {
          retainBinding = false;
        } else {
          deps.warn(
            `  vLLM rollback warning: ${cleanup.ok ? "exact pair cleanup was incomplete" : cleanup.reason}`,
          );
        }
      }
      deps.error(
        `  vLLM install failed: could not persist managed two-Spark cleanup ownership: ${(error as Error).message}`,
      );
      return { kind: "handled", result: { ok: false } };
    }

    deps.log(`  ✓ vLLM ready across two DGX Sparks at ${started.baseUrl}`);
    return { kind: "handled", result: { ok: true } };
  } catch (error) {
    deps.error(`  Two-Spark managed vLLM setup failed closed: ${(error as Error).message}`);
    return { kind: "handled", result: { ok: false } };
  } finally {
    if (confirmedBinding && retainBinding) {
      deps.warn(
        `  vLLM rollback warning: retained two-Spark SSH ownership state at ${confirmedBinding.peerSshBindingStatePath} because exact container rollback is incomplete. Resolve the related runtime state before retrying setup or uninstall.`,
      );
    } else if (confirmedBinding) {
      try {
        deps.clearBinding(confirmedBinding.peerSshBindingStatePath);
      } catch (error) {
        deps.warn(
          `  vLLM cleanup warning: temporary two-Spark SSH state could not be retired: ${(error as Error).message}`,
        );
      }
    }
  }
}
