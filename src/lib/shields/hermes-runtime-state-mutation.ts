// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AgentDefinition, AgentStateLockPlan } from "../agent/definition-types";
import type {
  RuntimeProviderBundleRegistry,
  RuntimeProviderStateMutationActivationProof,
  RuntimeProviderStateMutationContext,
  RuntimeProviderStateMutationFence,
  RuntimeProviderStateMutationProtectionPosture,
  RuntimeProviderStateMutationSurface,
} from "../onboard/runtime-provider/contract";
import {
  createFilePersistedEngineLifecycleStore,
  hasActivePersistedEngineStateMutationTarget,
  PERSISTED_ENGINE_LIFECYCLE_DIRECTORY,
} from "../onboard/runtime-provider/persisted-engine-lifecycle";
import { requireRuntimeProviderBundleForSandbox } from "../onboard/runtime-provider/registry";
import { prepareAgentDefinitionProtectionTransitionPlan } from "../onboard/runtime-provider/state-mutation";
import { resolveCurrentAgentDefinition } from "../sandbox/agent-config";
import type { SandboxEntry } from "../state/registry/types";

export const HERMES_RUNTIME_STATE_MUTATION_CAPABILITY_PATH =
  "/usr/local/share/nemoclaw/runtime-state-mutation-publisher-v1.json";

export const HERMES_RUNTIME_STATE_MUTATION_CAPABILITY =
  '{"schemaVersion":1,"protocol":"nemoclaw-runtime-state-mutation-publisher-v1","agent":"hermes","providerId":"docker","stateRoot":"/sandbox/.hermes","planSchemaVersion":2,"entrypoint":"/usr/local/lib/nemoclaw/runtime_state_mutation_hermes_publisher.py"}';

export const HERMES_RUNTIME_STATE_MUTATION_CAPABILITY_METADATA = "444 0 0 1 regular file";

type SupportedStateMutationSurface = Extract<
  RuntimeProviderStateMutationSurface,
  { readonly supported: true }
>;

export interface HermesRuntimeStateMutationCapabilityInspection {
  readonly content: string;
  readonly metadata: string;
}

export interface HermesRuntimeStateMutationResult {
  readonly fence: RuntimeProviderStateMutationFence;
  readonly proof: RuntimeProviderStateMutationActivationProof;
}

export interface HermesRuntimeStateMutationConfigTarget {
  readonly agentName?: string;
  readonly configPath: string;
  readonly configDir: string;
  readonly configFile?: string;
  readonly format?: string;
  readonly sensitiveFiles?: readonly string[];
  readonly stateLockPlan?: AgentStateLockPlan;
  readonly stateLockPlanInImage: boolean;
}

export interface HermesRuntimeStateMutationInput {
  readonly environment: NodeJS.ProcessEnv;
  readonly sandbox: SandboxEntry;
  readonly sandboxName: string;
  readonly configTarget: HermesRuntimeStateMutationConfigTarget;
  readonly target: RuntimeProviderStateMutationProtectionPosture;
  readonly rollback: RuntimeProviderStateMutationProtectionPosture;
  readonly providers?: RuntimeProviderBundleRegistry;
}

export function hermesRuntimeProviderPhaseBlocksMutation(
  phase: string | null,
  retainedClaim: boolean,
): boolean {
  return phase !== null && phase !== "Ready" && phase !== "Running" && !retainedClaim;
}

function currentRuntimeProviderBundles(): RuntimeProviderBundleRegistry {
  return (
    require("../onboard/runtime-provider/current") as typeof import("../onboard/runtime-provider/current")
  ).CURRENT_RUNTIME_PROVIDER_BUNDLES;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function combinedFailure(primary: unknown, recovery: unknown): Error {
  return new Error(
    `${errorMessage(primary)} Recovery of the retained runtime state-mutation fence failed: ${errorMessage(recovery)}`,
    { cause: primary },
  );
}

function completionDigest(
  outcome: "target-published" | "rollback-published" | "recovery-rollback-published",
  fence: RuntimeProviderStateMutationFence,
  proof: RuntimeProviderStateMutationActivationProof,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        outcome,
        intent: fence.intent,
        target: fence.target,
        rollback: fence.rollback,
        providerId: fence.providerId,
        sandboxName: fence.sandboxName,
        transactionId: fence.transactionId,
        lifecycleGeneration: fence.lifecycleGeneration,
        runtimeId: fence.runtimeId,
        planSha256: fence.planSha256,
        projectionSha256: fence.projectionSha256,
        nonce: fence.nonce,
        configurationGeneration: proof.configurationGeneration,
        listenerIdentity: proof.listenerIdentity,
        healthSha256: proof.healthSha256,
        activationProviderHandle: proof.providerHandle,
      }),
      "utf8",
    )
    .digest("hex");
}

const IMMUTABLE_FENCE_FIELDS: ReadonlyArray<keyof RuntimeProviderStateMutationFence> = [
  "schemaVersion",
  "intent",
  "providerId",
  "sandboxName",
  "transactionId",
  "lifecycleGeneration",
  "runtimeId",
  "runtimeStateSha256",
  "engineBindingSha256",
  "stateRoot",
  "mountNamespaceId",
  "stateRootDevice",
  "stateRootInode",
  "planSha256",
  "projectionSha256",
  "target",
  "rollback",
  "nonce",
  "providerHandle",
];

function exactFence(
  expected: RuntimeProviderStateMutationFence,
  actual: RuntimeProviderStateMutationFence,
): RuntimeProviderStateMutationFence {
  if (
    actual.phase !== "activation-proven" ||
    IMMUTABLE_FENCE_FIELDS.some((field) => actual[field] !== expected[field])
  ) {
    throw new Error("Runtime provider recovery returned a different state-mutation fence.");
  }
  return actual;
}

function rollbackAndRelease(
  surface: SupportedStateMutationSurface,
  context: RuntimeProviderStateMutationContext,
  fence: RuntimeProviderStateMutationFence,
  outcome: "rollback-published" | "recovery-rollback-published",
): HermesRuntimeStateMutationResult {
  surface.assertFenced(context, fence);
  surface.rollback(context, fence);
  surface.assertFenced(context, fence);
  const proof = surface.activate(context, fence);
  surface.release(context, fence, proof, completionDigest(outcome, fence, proof));
  return Object.freeze({ fence, proof });
}

function recoverPriorMutation(
  surface: SupportedStateMutationSurface,
  context: RuntimeProviderStateMutationContext,
): void {
  const recovered = surface.recover(context);
  if (recovered === null) return;
  recoverRetainedMutation(surface, context, recovered);
}

function recoverRetainedMutation(
  surface: SupportedStateMutationSurface,
  context: RuntimeProviderStateMutationContext,
  fence: RuntimeProviderStateMutationFence,
): HermesRuntimeStateMutationResult {
  if (fence.intent !== "protection-transition" || fence.target !== "locked") {
    return rollbackAndRelease(surface, context, fence, "recovery-rollback-published");
  }
  if (fence.phase === "rolled-back") {
    throw new Error(
      "A retained Hermes lock fence already published its mutable rollback; refusing to release mutable state.",
    );
  }
  surface.assertFenced(context, fence);
  if (fence.phase === "fenced") {
    surface.publish(context, fence);
    surface.assertFenced(context, fence);
  }
  const proof = surface.activate(context, fence);
  releaseTarget(surface, context, fence, proof);
  return Object.freeze({ fence, proof });
}

function exactRetainedFence(
  expected: RuntimeProviderStateMutationFence,
  actual: RuntimeProviderStateMutationFence,
): RuntimeProviderStateMutationFence {
  if (
    actual.phase !== "fenced" &&
    actual.phase !== "published" &&
    actual.phase !== "activation-proven"
  ) {
    throw new Error("Runtime provider recovery returned an invalid retained fence phase.");
  }
  if (IMMUTABLE_FENCE_FIELDS.some((field) => actual[field] !== expected[field])) {
    throw new Error("Runtime provider recovery returned a different state-mutation fence.");
  }
  return actual;
}

function recoverLockedActivationFailure(
  surface: SupportedStateMutationSurface,
  context: RuntimeProviderStateMutationContext,
  expectedFence: RuntimeProviderStateMutationFence,
  primary: unknown,
): HermesRuntimeStateMutationResult {
  let recovered: RuntimeProviderStateMutationFence | null;
  try {
    recovered = surface.recover(context);
  } catch (recoveryError) {
    throw combinedFailure(primary, recoveryError);
  }
  if (recovered === null) throw primary;
  try {
    return recoverRetainedMutation(surface, context, exactRetainedFence(expectedFence, recovered));
  } catch (recoveryError) {
    throw combinedFailure(primary, recoveryError);
  }
}

function recoverAcquireFailure(
  surface: SupportedStateMutationSurface,
  context: RuntimeProviderStateMutationContext,
  primary: unknown,
): never {
  try {
    const recovered = surface.recover(context);
    if (recovered !== null) {
      recoverRetainedMutation(surface, context, recovered);
    }
  } catch (recoveryError) {
    throw combinedFailure(primary, recoveryError);
  }
  throw primary;
}

function exactStringArray(
  actual: readonly string[] | undefined,
  expected: readonly string[],
): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((entry, index) => entry === expected[index])
  );
}

function assertCurrentHermesConfigTarget(
  target: HermesRuntimeStateMutationConfigTarget,
  agent: AgentDefinition,
): void {
  const config = agent.configPaths;
  const configPath = path.posix.join(config.dir, config.configFile);
  const sensitiveFiles = [
    path.posix.join(config.dir, ".config-hash"),
    ...config.shieldsFiles.map((entry) => path.posix.join(config.dir, entry)),
  ];
  if (
    target.agentName !== agent.name ||
    target.configDir !== config.dir ||
    target.configPath !== configPath ||
    target.configFile !== config.configFile ||
    target.format !== config.format ||
    !exactStringArray(target.sensitiveFiles, sensitiveFiles) ||
    target.stateLockPlanInImage !== agent.stateLockPlanInImage ||
    !isDeepStrictEqual(target.stateLockPlan, agent.stateLockPlan)
  ) {
    throw new Error(
      "Hermes runtime-provider state mutation target no longer matches the current AgentDefinition config projection.",
    );
  }
}

/** Read-only retained-claim probe for the named Hermes Shields consumer. */
export function hasActiveHermesRuntimeProviderStateMutation(
  sandboxName: string,
  stateDir: string,
): boolean {
  const lifecycleDirectory = path.join(stateDir, PERSISTED_ENGINE_LIFECYCLE_DIRECTORY);
  try {
    fs.lstatSync(lifecycleDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  return hasActivePersistedEngineStateMutationTarget(
    createFilePersistedEngineLifecycleStore(stateDir),
    sandboxName,
  );
}

function releaseTarget(
  surface: SupportedStateMutationSurface,
  context: RuntimeProviderStateMutationContext,
  fence: RuntimeProviderStateMutationFence,
  proof: RuntimeProviderStateMutationActivationProof,
): void {
  const digest = completionDigest("target-published", fence, proof);
  try {
    surface.release(context, fence, proof, digest);
    return;
  } catch (releaseError) {
    try {
      const recovered = surface.recover(context);
      if (recovered === null) return;
      surface.release(context, exactFence(fence, recovered), proof, digest);
      return;
    } catch (recoveryError) {
      throw combinedFailure(releaseError, recoveryError);
    }
  }
}

/**
 * Select the new protocol only for a current managed Hermes Docker image. The
 * fixed helper validates the same capability again after the durable runtime
 * claim is acquired, so this compatibility probe never grants authority.
 */
export function supportsHermesRuntimeProviderStateMutation(
  sandbox: SandboxEntry | null,
  capability: HermesRuntimeStateMutationCapabilityInspection | null,
  providers: RuntimeProviderBundleRegistry = currentRuntimeProviderBundles(),
): boolean {
  if (
    sandbox?.agent !== "hermes" ||
    sandbox.openshellDriver?.trim().toLowerCase() !== "docker" ||
    sandbox.workload?.kind !== "managed-image" ||
    !sandbox.lifecycleGeneration ||
    capability?.content !== HERMES_RUNTIME_STATE_MUTATION_CAPABILITY ||
    capability.metadata !== HERMES_RUNTIME_STATE_MUTATION_CAPABILITY_METADATA
  ) {
    return false;
  }
  const provider = requireRuntimeProviderBundleForSandbox(sandbox, providers);
  return provider.identity.id === "docker" && provider.stateMutation.supported === true;
}

/** Execute one complete Hermes protection transition under its provider fence. */
export function runHermesRuntimeProviderStateMutation(
  input: HermesRuntimeStateMutationInput,
): HermesRuntimeStateMutationResult | null {
  const agent = resolveCurrentAgentDefinition("hermes");
  const provider = requireRuntimeProviderBundleForSandbox(
    input.sandbox,
    input.providers ?? currentRuntimeProviderBundles(),
  );
  const surface = provider.stateMutation;
  if (surface.supported !== true || surface.providerId !== provider.identity.id) {
    throw new Error(
      `Runtime provider '${provider.identity.id}' does not support Hermes state mutation.`,
    );
  }
  const context: RuntimeProviderStateMutationContext = {
    environment: input.environment,
    sandbox: input.sandbox,
    sandboxName: input.sandboxName,
  };

  recoverPriorMutation(surface, context);
  assertCurrentHermesConfigTarget(input.configTarget, agent);
  const rollback =
    input.target === input.rollback
      ? input.target === "locked"
        ? "mutable"
        : "locked"
      : input.rollback;
  const plan = prepareAgentDefinitionProtectionTransitionPlan(agent, input.target, rollback);

  let fence: RuntimeProviderStateMutationFence;
  try {
    fence = surface.acquire({ ...context, plan });
  } catch (error) {
    return recoverAcquireFailure(surface, context, error);
  }

  try {
    surface.assertFenced(context, fence);
  } catch (error) {
    if (input.target === "locked") throw error;
    try {
      rollbackAndRelease(surface, context, fence, "rollback-published");
    } catch (rollbackError) {
      throw combinedFailure(error, rollbackError);
    }
    throw error;
  }

  try {
    surface.publish(context, fence);
    surface.assertFenced(context, fence);
  } catch (error) {
    if (input.target === "locked") throw error;
    try {
      rollbackAndRelease(surface, context, fence, "rollback-published");
    } catch (rollbackError) {
      throw combinedFailure(error, rollbackError);
    }
    throw error;
  }

  let proof: RuntimeProviderStateMutationActivationProof;
  try {
    proof = surface.activate(context, fence);
  } catch (error) {
    if (input.target === "locked") {
      return recoverLockedActivationFailure(surface, context, fence, error);
    }
    try {
      rollbackAndRelease(surface, context, fence, "rollback-published");
    } catch (rollbackError) {
      throw combinedFailure(error, rollbackError);
    }
    throw error;
  }
  releaseTarget(surface, context, fence, proof);
  return Object.freeze({ fence, proof });
}
