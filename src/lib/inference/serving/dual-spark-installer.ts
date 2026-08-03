// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isAffirmativeAnswer } from "../../onboard/prompt-helpers.js";
import type { VllmProfile } from "../vllm.js";
import { ensureManagedVllmApiKey } from "../vllm-api-key.js";
import type { VllmModelDef } from "../vllm-models.js";
import { VLLM_EXTRA_ARGS_ENV } from "../vllm-models.js";
import { clearDualStationSshBinding } from "../vllm-station-ssh-binding.js";
import {
  DUAL_SPARK_PRESET_ID,
  type ManagedInferenceResolution,
  type ManagedInferenceResolverInput,
} from "./catalog-types.js";
import {
  confirmDualSparkManagedServingCapability,
  type DualSparkConfirmedManagedServingCapability,
  type DualSparkDetectedManagedServingCapability,
  NEMOCLAW_DGX_SPARK_PEER_ENV,
  NEMOCLAW_SERVING_PRESET_ENV,
  probeDualSparkManagedServingCapability,
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
  DUAL_SPARK_VLLM_HEAD_CONTAINER_NAME,
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
  readonly confirmCapability: typeof confirmDualSparkManagedServingCapability;
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
  readonly log: (line?: string) => void;
  readonly error: (line: string) => void;
  readonly warn: (line: string) => void;
}

const DEFAULT_DEPS: DualSparkInstallerDeps = {
  probeCapability: probeDualSparkManagedServingCapability,
  confirmCapability: confirmDualSparkManagedServingCapability,
  resolveSelection: resolveManagedInferenceServing,
  materializePlan: materializeDualSparkVllmPlan,
  createExecutor: createDualSparkVllmExecutor,
  start: startAutomaticDualSparkVllm,
  cleanup: cleanupDualSparkManagedVllm,
  persistReceipt: persistDualSparkVllmRuntimeReceipt,
  ensureApiKey: ensureManagedVllmApiKey,
  assertNoRuntimeReceipts: assertNoManagedDistributedVllmRuntimeReceipts,
  clearBinding: clearDualStationSshBinding,
  log: (line = "") => console.log(line),
  error: (line) => console.error(line),
  warn: (line) => console.warn(line),
};

function managedProfile(plan: DualSparkVllmPlan): VllmProfile {
  return {
    name: "Two DGX Sparks",
    platform: "spark",
    image: plan.roles.head.image,
    imageDownloadSizeBytes: plan.roles.head.runtime.imageDownloadSizeBytes,
    defaultModel: managedModel(plan),
    containerName: DUAL_SPARK_VLLM_HEAD_CONTAINER_NAME,
    dockerRunFlags: [],
    pullTimeoutSec: 12 * 60 * 60,
    loadTimeoutSec: Math.ceil(plan.readiness.timeoutMs / 1000),
    modelDownloadSizeBytes: plan.roles.head.preparation.modelDownloadSizeBytes,
  };
}

function managedModel(plan: DualSparkVllmPlan): VllmModelDef {
  return {
    id: plan.model.id,
    label: "DeepSeek V4 Flash 0731",
    envValue: plan.model.servedName,
    downloadSizeBytes: plan.roles.head.preparation.modelDownloadSizeBytes,
    maxModelLen: 1_048_576,
    revision: plan.model.revision,
    servedModelId: plan.model.servedName,
    modelArgs: [],
    gated: false,
    platforms: ["spark"],
    installFastSafetensors: false,
  };
}

function selectionIntent(
  capability: DualSparkDetectedManagedServingCapability,
  env: NodeJS.ProcessEnv,
) {
  const configuredPreset = String(env[NEMOCLAW_SERVING_PRESET_ENV] ?? "").trim();
  const configuredModel = String(env.NEMOCLAW_VLLM_MODEL ?? "").trim();
  const extraArguments = String(env[VLLM_EXTRA_ARGS_ENV] ?? "").trim();
  return {
    ...(configuredPreset || capability.selectionIntent === "explicit"
      ? { preset: configuredPreset || DUAL_SPARK_PRESET_ID }
      : {}),
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
  deps: DualSparkInstallerDeps,
): DualSparkInstallerResult {
  deps.error(`  Two-Spark managed vLLM setup unavailable: ${resolution.message}`);
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
  const configuredPreset = String(env[NEMOCLAW_SERVING_PRESET_ENV] ?? "").trim();
  if (configuredPreset && configuredPreset !== DUAL_SPARK_PRESET_ID) {
    deps.error(
      `  Managed vLLM setup stopped: ${NEMOCLAW_SERVING_PRESET_ENV} selects unsupported profile ${configuredPreset}.`,
    );
    return { kind: "handled", result: { ok: false } };
  }

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
      intent: selectionIntent(detected, env),
    });
    if (previewResolution.outcome !== "selected") {
      return resolutionFailure(previewResolution, deps);
    }

    let previewPlan: DualSparkVllmPlan;
    try {
      previewPlan = deps.materializePlan(previewResolution);
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

    const confirmation = deps.confirmCapability(detected, { env });
    if (confirmation.kind !== "ready") {
      deps.error(`  Two-Spark managed vLLM setup stopped: ${confirmation.reason}`);
      return { kind: "handled", result: { ok: false } };
    }
    confirmedBinding = confirmation;

    const resolution = deps.resolveSelection({
      readinessReports: confirmation.readiness,
      topologyQualifications: [confirmation.topology],
      intent: selectionIntent(confirmation, env),
    });
    if (resolution.outcome !== "selected") return resolutionFailure(resolution, deps);

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

    const profile = managedProfile(plan);
    const model = managedModel(plan);
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
