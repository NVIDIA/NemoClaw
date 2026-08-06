// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import type { SandboxEntry } from "../state/registry/types";
import {
  type CuaAppliedPolicyIdentity,
  type CuaRuntimeReadiness,
  type CuaSecurityAttestation,
  type CuaTargetAttachment,
  getCuaRuntimeReadinessDigest,
} from "./contract";
import { isCuaFrameworkEnabled, isCuaQualificationEnabled } from "./feature";
import { observeCuaLiveAppliedPolicy, observeCuaLiveInference } from "./lifecycle-readiness";
import { type CuaReconciliationState, parseCuaReconciliationState } from "./reconciliation";
import {
  type CuaRuntimeReadinessContext,
  validateCurrentCuaRuntimeReadiness,
} from "./runtime-readiness";
import { parseCuaSecurityAttestation, parseCuaTargetAttachment } from "./schema";
import { cuaSecurityAttestationMatches } from "./security-lifecycle";

export interface ValidatedCuaState {
  readiness: CuaRuntimeReadiness | null;
  target: CuaTargetAttachment | null;
  security: CuaSecurityAttestation | null;
}

export interface ObservedCuaInferenceRoute {
  provider: string | null;
  model: string | null;
  providerAuthorityDigest?: string;
}

export interface CuaStateValidationDeps {
  buildContext?: typeof buildCuaRuntimeReadinessValidationContext;
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
  getValidatedState?: typeof getValidatedCuaState;
  validation?: CuaStateValidationDeps;
}

/** Keep status and doctor behind the same default-off public-state boundary. */
export function isCuaPublicStateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isCuaFrameworkEnabled(env);
}

/** Parse the private cleanup journal only when CUA public state is enabled. */
export function getCuaReconciliationForProjection(
  entry: SandboxEntry | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): CuaReconciliationState | null {
  if (!isCuaFrameworkEnabled(env) || !entry?.cuaReconciliation) return null;
  return parseCuaReconciliationState(entry.cuaReconciliation);
}

function withoutActiveTask(target: CuaTargetAttachment): CuaTargetAttachment {
  return target.activeTask ? { ...target, activeTask: null } : target;
}

/** Build the validation context shared by public state consumers. */
export function buildCuaRuntimeReadinessValidationContext(
  entry: SandboxEntry,
  env: NodeJS.ProcessEnv,
  liveInference: ObservedCuaInferenceRoute | null,
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
        }
      : {}),
    acceptance: isCuaQualificationEnabled(env) ? "candidate-qualification" : "final",
    env,
  };
}

/** Validate every public projection at its read boundary; never expose raw durable CUA state. */
export function getValidatedCuaState(
  entry: SandboxEntry | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  liveInference: ObservedCuaInferenceRoute | null = null,
  deps: CuaStateValidationDeps = {},
): ValidatedCuaState {
  if (
    !entry ||
    !isCuaFrameworkEnabled(env) ||
    !entry.cuaRuntimeReadiness ||
    entry.cuaReconciliation
  ) {
    return { readiness: null, target: null, security: null };
  }

  let readiness: CuaRuntimeReadiness;
  try {
    const context = (deps.buildContext ?? buildCuaRuntimeReadinessValidationContext)(
      entry,
      env,
      liveInference,
    );
    readiness = (deps.validateRuntimeReadiness ?? validateCurrentCuaRuntimeReadiness)(
      entry.cuaRuntimeReadiness,
      context,
    );
  } catch {
    return { readiness: null, target: null, security: null };
  }
  if (
    readiness.status !== "available" &&
    !(readiness.status === "candidate" && isCuaQualificationEnabled(env))
  ) {
    return { readiness: null, target: null, security: null };
  }

  if (!entry.cuaTarget) return { readiness, target: null, security: null };
  try {
    const target = parseCuaTargetAttachment(entry.cuaTarget);
    if (target.runtimeReadinessDigest !== getCuaRuntimeReadinessDigest(readiness)) {
      return { readiness, target: null, security: null };
    }
    if (!target.target || !entry.cuaSecurityAttestation) {
      return { readiness, target: withoutActiveTask(target), security: null };
    }
    try {
      const security = parseCuaSecurityAttestation(entry.cuaSecurityAttestation);
      const securityMatches =
        deps.liveAppliedPolicy !== null &&
        deps.liveAppliedPolicy !== undefined &&
        cuaSecurityAttestationMatches(security, readiness, target.target, deps.liveAppliedPolicy);
      if (!securityMatches) {
        return { readiness, target: withoutActiveTask(target), security: null };
      }
      const authorizedTarget =
        !target.activeTask ||
        isDeepStrictEqual(target.activeTask.appliedPolicy, deps.liveAppliedPolicy)
          ? target
          : withoutActiveTask(target);
      return { readiness, target: authorizedTarget, security };
    } catch {
      return { readiness, target: withoutActiveTask(target), security: null };
    }
  } catch {
    return { readiness, target: null, security: null };
  }
}

/** Re-observe provider authority before exposing any validated public CUA state. */
export function getObservedValidatedCuaState(
  entry: SandboxEntry | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  deps: CuaStateObservationDeps = {},
): ObservedValidatedCuaState {
  const unavailable: ValidatedCuaState = { readiness: null, target: null, security: null };
  if (
    !entry ||
    !isCuaFrameworkEnabled(env) ||
    entry.agent !== "nemocua" ||
    !entry.cuaRuntimeReadiness ||
    entry.cuaReconciliation
  ) {
    return { observation: "not-applicable", ...unavailable };
  }

  let liveInference: ObservedCuaInferenceRoute;
  try {
    liveInference = deps.observeLiveInference
      ? deps.observeLiveInference(entry)
      : observeCuaLiveInference(entry, { env });
  } catch {
    return { observation: "failed", failure: "inference", ...unavailable };
  }

  let liveAppliedPolicy: CuaAppliedPolicyIdentity;
  try {
    liveAppliedPolicy = deps.observeLiveAppliedPolicy
      ? deps.observeLiveAppliedPolicy(entry)
      : (deps.validation?.liveAppliedPolicy ?? observeCuaLiveAppliedPolicy(entry, { env }));
  } catch {
    return { observation: "failed", failure: "policy", ...unavailable };
  }

  return {
    observation: "verified",
    ...(deps.getValidatedState ?? getValidatedCuaState)(entry, env, liveInference, {
      ...deps.validation,
      liveAppliedPolicy,
    }),
  };
}
