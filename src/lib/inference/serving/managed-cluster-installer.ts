// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isAffirmativeAnswer } from "../../onboard/prompt-helpers.js";
import type { VllmProfile } from "../vllm.js";
import { ensureManagedVllmApiKey } from "../vllm-api-key.js";
import { assertGatedModelAccess, VLLM_EXTRA_ARGS_ENV, type VllmModelDef } from "../vllm-models.js";
import { imageStorageRequirementBytes, modelStorageRequirementBytes } from "../vllm-storage.js";
import {
  type ManagedInferenceResolution,
  type ManagedInferenceResolverInput,
  type ManagedInferenceServingRecipe,
} from "./types.js";
import {
  claimManagedClusterManagedServingCapability,
  type ManagedClusterConfirmedManagedServingCapability,
  type ManagedClusterDetectedManagedServingCapability,
  type ManagedClusterHostObservation,
  type ManagedClusterStorageCapacityObservation,
  NEMOCLAW_MANAGED_CLUSTER_PEERS_ENV,
  NEMOCLAW_SERVING_PRESET_ENV,
  probeManagedClusterManagedServingCapability,
  revalidateManagedClusterManagedServingCapability,
} from "./managed-cluster-discovery.js";
import {
  type CreateManagedClusterVllmExecutorOptions,
  createManagedClusterVllmExecutor,
  type ManagedClusterExecutorStageNode,
} from "./managed-cluster-executor.js";
import {
  cleanupManagedClusterManagedVllm,
  type StartManagedClusterVllmResult,
  startAutomaticManagedClusterVllm,
} from "./managed-cluster-lifecycle.js";
import {
  type ManagedClusterVllmPlan,
  managedClusterHeadRole,
  materializeManagedClusterVllmPlan,
} from "./managed-cluster-materialize.js";
import {
  type PersistManagedClusterVllmRuntimeReceiptInput,
  persistManagedClusterVllmRuntimeReceipt,
} from "./managed-cluster-runtime-receipt.js";
import { clearManagedVllmSshBinding } from "./managed-cluster-ssh-binding.js";
import type { ManagedClusterTopologyOutput } from "./managed-cluster-topology.js";
import { assertNoManagedDistributedVllmRuntimeReceipts } from "./managed-runtime-receipts.js";
import { resolveManagedInferenceServing } from "./resolver.js";

export interface ManagedClusterInstallerOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly nonInteractive: boolean;
  readonly platform: VllmProfile["platform"];
  readonly promptFn: (question: string) => Promise<string>;
  readonly beforeInstall?: (modelId: string) => void;
}

export interface ManagedClusterInstallerEffects {
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

export type ManagedClusterInstallerResult =
  | { readonly kind: "not-selected" }
  | { readonly kind: "handled"; readonly result: { readonly ok: boolean } };

interface ManagedClusterInstallerDeps {
  readonly probeCapability: typeof probeManagedClusterManagedServingCapability;
  readonly revalidateCapability: typeof revalidateManagedClusterManagedServingCapability;
  readonly claimCapability: typeof claimManagedClusterManagedServingCapability;
  readonly resolveSelection: (
    input: ManagedInferenceResolverInput<ManagedClusterTopologyOutput>,
  ) => ManagedInferenceResolution<ManagedClusterTopologyOutput>;
  readonly materializePlan: typeof materializeManagedClusterVllmPlan;
  readonly createExecutor: typeof createManagedClusterVllmExecutor;
  readonly start: typeof startAutomaticManagedClusterVllm;
  readonly cleanup: typeof cleanupManagedClusterManagedVllm;
  readonly persistReceipt: typeof persistManagedClusterVllmRuntimeReceipt;
  readonly ensureApiKey: typeof ensureManagedVllmApiKey;
  readonly assertNoRuntimeReceipts: typeof assertNoManagedDistributedVllmRuntimeReceipts;
  readonly clearBinding: typeof clearManagedVllmSshBinding;
  readonly assertGatedModelAccess: typeof assertGatedModelAccess;
  readonly log: (line?: string) => void;
  readonly error: (line: string) => void;
  readonly warn: (line: string) => void;
}

const DEFAULT_DEPS: ManagedClusterInstallerDeps = {
  probeCapability: probeManagedClusterManagedServingCapability,
  revalidateCapability: revalidateManagedClusterManagedServingCapability,
  claimCapability: claimManagedClusterManagedServingCapability,
  resolveSelection: resolveManagedInferenceServing,
  materializePlan: materializeManagedClusterVllmPlan,
  createExecutor: createManagedClusterVllmExecutor,
  start: startAutomaticManagedClusterVllm,
  cleanup: cleanupManagedClusterManagedVllm,
  persistReceipt: persistManagedClusterVllmRuntimeReceipt,
  ensureApiKey: ensureManagedVllmApiKey,
  assertNoRuntimeReceipts: assertNoManagedDistributedVllmRuntimeReceipts,
  clearBinding: clearManagedVllmSshBinding,
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
  host: ManagedClusterHostObservation,
  label: string,
  recipe: ManagedInferenceServingRecipe,
): SelectedRecipeAdmissionFailure | null {
  const requirements = new Map<string, bigint>();
  const available = new Map<string, bigint>();
  const add = (capacity: ManagedClusterStorageCapacityObservation, required: bigint): boolean => {
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
  capability: ManagedClusterDetectedManagedServingCapability,
  recipe: ManagedInferenceServingRecipe,
): SelectedRecipeAdmissionFailure | null {
  const apiPort = recipeApiPort(recipe);
  if (apiPort === null) {
    return { code: "runtime-unknown", reason: "The selected recipe serving port is invalid." };
  }
  for (const [index, host] of [capability.local, ...capability.peers].entries()) {
    const label = index === 0 ? "Local DGX Spark" : `Managed cluster peer ${String(index)}`;
    const occupied = host.runtimeSnapshot.listeningPorts.find(
      (port) => port === apiPort || port === recipe.spec.execution.rendezvousPort,
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
  plan: ManagedClusterVllmPlan,
  recipe: ManagedInferenceServingRecipe,
): VllmProfile {
  const head = managedClusterHeadRole(plan);
  return {
    name: recipe.metadata.displayName ?? recipe.metadata.id,
    platform: "spark",
    image: head.image,
    imageDownloadSizeBytes: head.runtime.imageDownloadSizeBytes,
    defaultModel: managedModel(plan, recipe),
    containerName: head.containerName,
    dockerRunFlags: [],
    pullTimeoutSec: recipe.spec.runtime.pullTimeoutSeconds,
    loadTimeoutSec: Math.ceil(plan.readiness.timeoutMs / 1000),
    modelDownloadSizeBytes: head.preparation.modelDownloadSizeBytes,
  };
}

function managedModel(
  plan: ManagedClusterVllmPlan,
  recipe: ManagedInferenceServingRecipe,
): VllmModelDef {
  return {
    id: plan.model.id,
    label: recipe.metadata.displayName ?? recipe.metadata.id,
    envValue: plan.model.servedName,
    downloadSizeBytes: managedClusterHeadRole(plan).preparation.modelDownloadSizeBytes,
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
  const clusterIntent =
    String(env[NEMOCLAW_MANAGED_CLUSTER_PEERS_ENV] ?? "").trim() ||
    String(env[NEMOCLAW_SERVING_PRESET_ENV] ?? "").trim();
  if (clusterIntent) return false;
  return Boolean(
    String(env.NEMOCLAW_VLLM_MODEL ?? "").trim() || String(env[VLLM_EXTRA_ARGS_ENV] ?? "").trim(),
  );
}

function printSummary(
  capability: ManagedClusterDetectedManagedServingCapability,
  plan: ManagedClusterVllmPlan,
  deps: ManagedClusterInstallerDeps,
): void {
  const rails = capability.topology.output.rails
    .map(({ endpoints }) =>
      endpoints
        .map(({ address, prefixLength }) => `${address}/${String(prefixLength)}`)
        .join(" to "),
    )
    .join(", ");
  const head = managedClusterHeadRole(plan);
  deps.log();
  deps.log(`  vLLM (${String(plan.roles.length)}-node DGX Spark cluster, experimental):`);
  deps.log(`    Serving profile: ${plan.presetId}`);
  deps.log(`    Recipe: ${plan.recipeId}`);
  deps.log(`    Image: ${head.image}`);
  deps.log(`    Model: ${plan.model.id}@${plan.model.revision}`);
  deps.log(`    Served model: ${plan.model.servedName}`);
  deps.log(
    `    Topology: ${[capability.local, ...capability.peers]
      .map(({ hostname }) => hostname)
      .join(" + ")}`,
  );
  deps.log(`    Direct rails: ${rails}`);
  deps.log(
    `    RoCEv2 GIDs: ${capability.topology.output.rails
      .map(({ endpoints }) => endpoints.map(({ roceGid }) => String(roceGid.index)).join("/"))
      .join(", ")}`,
  );
  deps.log(
    `    Model caches: ${[capability.local, ...capability.peers]
      .map(({ storage }) => storage.huggingFace.cacheRoot)
      .join(", ")}`,
  );
  deps.log("    Launch order: descending worker ranks, then head");
  deps.log("    Restart policy: none; a stopped cluster requires explicit cleanup");
  deps.log("    Experimental: physical end-to-end validation is pending");
}

function resolutionFailure(
  resolution: Exclude<
    ManagedInferenceResolution<ManagedClusterTopologyOutput>,
    { outcome: "selected" }
  >,
  selectionIntent: ManagedClusterDetectedManagedServingCapability["selectionIntent"],
  allowAutomaticFallback: boolean,
  deps: ManagedClusterInstallerDeps,
): ManagedClusterInstallerResult {
  if (
    allowAutomaticFallback &&
    selectionIntent === "automatic" &&
    resolution.outcome === "no-match"
  ) {
    return { kind: "not-selected" };
  }
  deps.error(`  Managed-cluster vLLM setup unavailable: ${resolution.message}`);
  return { kind: "handled", result: { ok: false } };
}

function admissionFailure(
  failure: SelectedRecipeAdmissionFailure,
  selectionIntent: ManagedClusterDetectedManagedServingCapability["selectionIntent"],
  allowAutomaticFallback: boolean,
  deps: ManagedClusterInstallerDeps,
): ManagedClusterInstallerResult {
  if (
    allowAutomaticFallback &&
    selectionIntent === "automatic" &&
    (failure.code === "storage-unavailable" || failure.code === "storage-insufficient")
  ) {
    return { kind: "not-selected" };
  }
  deps.error(`  Managed-cluster vLLM setup stopped: ${failure.reason}`);
  return { kind: "handled", result: { ok: false } };
}

function receiptInput(
  capability: ManagedClusterConfirmedManagedServingCapability,
  plan: ManagedClusterVllmPlan,
  started: Extract<StartManagedClusterVllmResult, { ok: true }>,
): PersistManagedClusterVllmRuntimeReceiptInput {
  const hosts = new Map(
    [capability.local, ...capability.peers].map((host) => [host.nodeId, host] as const),
  );
  return {
    plan,
    apiKeyFingerprint: started.apiKeyFingerprint,
    nodes: plan.roles.map((rolePlan) => {
      const host = hosts.get(rolePlan.nodeId)!;
      const owned = started.containers.find(({ nodeId }) => nodeId === rolePlan.nodeId)!;
      const transport = capability.sshBindings.find(({ nodeId }) => nodeId === rolePlan.nodeId);
      return {
        nodeId: rolePlan.nodeId,
        cacheRoot: host.storage.huggingFace.cacheRoot,
        containerId: owned.containerId,
        ...(transport
          ? { sshBinding: transport.binding, discoveryStatePath: transport.statePath }
          : {}),
      };
    }),
  };
}

/** Select and run the automatic managed cluster profile without changing the legacy DGX Spark path. */
export async function tryInstallManagedClusterManagedVllm(
  options: ManagedClusterInstallerOptions,
  effects: ManagedClusterInstallerEffects,
  overrides: Partial<ManagedClusterInstallerDeps> = {},
): Promise<ManagedClusterInstallerResult> {
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
    deps.error(`  Managed-cluster vLLM setup stopped: ${detected.reason}`);
    return { kind: "handled", result: { ok: false } };
  }

  let confirmedBinding: ManagedClusterConfirmedManagedServingCapability | null = null;
  let retainBinding = false;
  try {
    // Explicit legacy model/argument intent keeps the single-host DGX Spark path, but
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

    let previewPlan: ManagedClusterVllmPlan;
    try {
      previewPlan = deps.materializePlan(previewResolution);
    } catch (error) {
      deps.error(`  Managed-cluster vLLM setup stopped: ${(error as Error).message}`);
      return { kind: "handled", result: { ok: false } };
    }
    try {
      deps.assertGatedModelAccess(managedModel(previewPlan, previewResolution.recipe), env);
    } catch (error) {
      deps.error(`  Managed-cluster vLLM setup stopped: ${(error as Error).message}`);
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
      deps.error(`  Managed-cluster vLLM setup stopped: ${revalidated.reason}`);
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
      deps.error("  Managed-cluster vLLM setup stopped: the selected profile changed.");
      return { kind: "handled", result: { ok: false } };
    }

    const confirmation = deps.claimCapability(revalidated);
    if (confirmation.kind !== "ready") {
      deps.error(`  Managed-cluster vLLM setup stopped: ${confirmation.reason}`);
      return { kind: "handled", result: { ok: false } };
    }
    confirmedBinding = confirmation;
    const resolution = {
      ...revalidatedResolution,
      topologyQualification: confirmation.topology,
    };

    let plan: ManagedClusterVllmPlan;
    try {
      plan = deps.materializePlan(resolution);
    } catch (error) {
      deps.error(`  Managed-cluster vLLM setup stopped: ${(error as Error).message}`);
      return { kind: "handled", result: { ok: false } };
    }
    if (
      plan.presetId !== previewPlan.presetId ||
      plan.recipeId !== previewPlan.recipeId ||
      plan.model.id !== previewPlan.model.id ||
      plan.model.revision !== previewPlan.model.revision ||
      plan.model.servedName !== previewPlan.model.servedName ||
      plan.roles.length !== previewPlan.roles.length ||
      plan.roles.some((role, index) => role.image !== previewPlan.roles[index]?.image)
    ) {
      deps.error("  Managed-cluster vLLM setup stopped: the presented serving plan changed.");
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

    const hosts = new Map(
      [confirmation.local, ...confirmation.peers].map((host) => [host.nodeId, host] as const),
    );
    const stageNode: ManagedClusterExecutorStageNode = async (_request, target) => {
      const host = hosts.get(target.nodeId)!;
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
    const executorOptions: CreateManagedClusterVllmExecutorOptions = {
      plan,
      nodes: plan.roles.map((rolePlan) => {
        const host = hosts.get(rolePlan.nodeId)!;
        const binding = confirmation.sshBindings.find(({ nodeId }) => nodeId === rolePlan.nodeId);
        return {
          nodeId: rolePlan.nodeId,
          modelCacheRoot: host.storage.huggingFace.cacheRoot,
          ...(binding ? { sshBinding: binding.binding } : {}),
        };
      }),
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
        const expected = new Set(started.containers.map(({ containerId }) => containerId));
        if (
          cleanup.ok &&
          cleanup.removedContainerIds.length === expected.size &&
          new Set(cleanup.removedContainerIds).size === expected.size &&
          cleanup.removedContainerIds.every((id) => expected.has(id))
        ) {
          retainBinding = false;
        } else {
          deps.warn(
            `  vLLM rollback warning: ${cleanup.ok ? "exact cluster cleanup was incomplete" : cleanup.reason}`,
          );
        }
      }
      deps.error(
        `  vLLM install failed: could not persist managed cluster cleanup ownership: ${(error as Error).message}`,
      );
      return { kind: "handled", result: { ok: false } };
    }

    deps.log(
      `  ✓ vLLM ready across ${String(plan.roles.length)} DGX Spark systems at ${started.baseUrl}`,
    );
    return { kind: "handled", result: { ok: true } };
  } catch (error) {
    deps.error(`  Managed-cluster vLLM setup failed closed: ${(error as Error).message}`);
    return { kind: "handled", result: { ok: false } };
  } finally {
    if (confirmedBinding && retainBinding) {
      deps.warn(
        `  vLLM rollback warning: retained managed cluster SSH ownership state at ${confirmedBinding.sshBindings
          .map(({ statePath }) => statePath)
          .join(
            ", ",
          )} because exact container rollback is incomplete. Resolve the related runtime state before retrying setup or uninstall.`,
      );
    } else if (confirmedBinding) {
      for (const { statePath } of confirmedBinding.sshBindings) {
        try {
          deps.clearBinding(statePath);
        } catch (error) {
          deps.warn(
            `  vLLM cleanup warning: temporary managed cluster SSH state could not be retired: ${(error as Error).message}`,
          );
        }
      }
    }
  }
}
