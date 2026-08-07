// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxEntry } from "../state/registry/types";
import type { CuaAppliedPolicyIdentity, CuaRuntimeReadiness } from "./contract";
import { isCuaQualificationEnabled } from "./feature";
import { observeCuaLiveAppliedPolicy, observeCuaLiveInference } from "./lifecycle-readiness";
import {
  type CuaRuntimeReadinessContext,
  validateCurrentCuaRuntimeReadiness,
} from "./runtime-readiness";

export interface ValidatedCuaState {
  readiness: CuaRuntimeReadiness | null;
}
export interface ObservedCuaInferenceRoute {
  provider: string | null;
  model: string | null;
  providerAuthorityDigest?: string;
  openshellDigest?: string;
}

export interface CuaStateValidationDeps {
  validateRuntimeReadiness?: typeof validateCurrentCuaRuntimeReadiness;
  liveAppliedPolicy?: CuaAppliedPolicyIdentity | null;
}

export type CuaStateObservation = "not-applicable" | "failed" | "verified";

export interface ObservedValidatedCuaState extends ValidatedCuaState {
  observation: CuaStateObservation;
  failure?: "inference" | "policy";
}

export interface CuaStateObservationDeps {
  observeLiveInference?: (entry: SandboxEntry) => ObservedCuaInferenceRoute;
  observeLiveAppliedPolicy?: (entry: SandboxEntry) => CuaAppliedPolicyIdentity;
  validation?: CuaStateValidationDeps;
}

/** Keep status and doctor behind the exact, default-off qualification boundary. */
export function isCuaPublicStateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isCuaQualificationEnabled(env);
}

export function buildCuaRuntimeReadinessValidationContext(
  entry: SandboxEntry,
  env: NodeJS.ProcessEnv,
  liveInference: ObservedCuaInferenceRoute | null,
  liveAppliedPolicy: CuaAppliedPolicyIdentity | null,
): CuaRuntimeReadinessContext {
  return {
    agentName: entry.agent,
    recordedInference: entry,
    ...(liveInference
      ? {
          liveInference: {
            ...entry,
            provider: liveInference.provider,
            model: liveInference.model,
          },
          liveProviderAuthorityDigest: liveInference.providerAuthorityDigest,
          ...(liveInference.openshellDigest
            ? { expectedOpenshellDigest: liveInference.openshellDigest }
            : {}),
        }
      : {}),
    ...(liveAppliedPolicy ? { liveAppliedPolicy } : {}),
    acceptance: "candidate-qualification",
    env,
  };
}

/** Validate only candidate install readiness; no lifecycle authority is projected. */
export function getValidatedCuaState(
  entry: SandboxEntry | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  liveInference: ObservedCuaInferenceRoute | null = null,
  liveAppliedPolicy: CuaAppliedPolicyIdentity | null = null,
  deps: CuaStateValidationDeps = {},
): ValidatedCuaState {
  if (
    !entry ||
    !isCuaQualificationEnabled(env) ||
    entry.agent !== "nemocua" ||
    !entry.cuaRuntimeReadiness
  ) {
    return { readiness: null };
  }
  try {
    const readiness = (deps.validateRuntimeReadiness ?? validateCurrentCuaRuntimeReadiness)(
      entry.cuaRuntimeReadiness,
      buildCuaRuntimeReadinessValidationContext(entry, env, liveInference, liveAppliedPolicy),
    );
    return { readiness: readiness.status === "candidate" ? readiness : null };
  } catch {
    return { readiness: null };
  }
}

/** Re-observe provider and policy authority before projecting candidate readiness. */
export function getObservedValidatedCuaState(
  entry: SandboxEntry | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  deps: CuaStateObservationDeps = {},
): ObservedValidatedCuaState {
  if (
    !entry ||
    !isCuaQualificationEnabled(env) ||
    entry.agent !== "nemocua" ||
    !entry.cuaRuntimeReadiness
  ) {
    return { observation: "not-applicable", readiness: null };
  }

  let liveInference: ObservedCuaInferenceRoute;
  try {
    liveInference = deps.observeLiveInference
      ? deps.observeLiveInference(entry)
      : observeCuaLiveInference(entry, { env });
  } catch {
    return { observation: "failed", failure: "inference", readiness: null };
  }

  let liveAppliedPolicy: CuaAppliedPolicyIdentity;
  try {
    liveAppliedPolicy = deps.observeLiveAppliedPolicy
      ? deps.observeLiveAppliedPolicy(entry)
      : (deps.validation?.liveAppliedPolicy ?? observeCuaLiveAppliedPolicy(entry, { env }));
  } catch {
    return { observation: "failed", failure: "policy", readiness: null };
  }

  return {
    observation: "verified",
    ...getValidatedCuaState(entry, env, liveInference, liveAppliedPolicy, deps.validation),
  };
}
