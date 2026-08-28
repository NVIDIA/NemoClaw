// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import {
  assertOpenShellGatewayPortBinding,
  inspectSandboxPolicy,
  PolicyObservationError,
} from "../../adapters/openshell/policy-state";
import { assertPolicyRequirementContainment, parseOpenShellPolicy } from "../../policy/merge";
import { normalizePendingSandboxCreateVerification } from "../../state/registry-normalization";
import type { PendingSandboxCreateVerification } from "../../state/registry/types";
import type { SelectedDockerGpuRoute } from "../docker-gpu-route";
import type { VerifiedSandboxPolicyBoundary, VerifiedSandboxPolicyRegistration } from "../types";

export interface CreatedSandboxPolicyVerificationInput {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly lifecycleGeneration: string;
  readonly lifecycleLiveIdentityFingerprint: string;
  readonly policySourcePath: string;
  readonly route: SelectedDockerGpuRoute;
}

export interface CreatedSandboxPolicyVerificationDeps {
  readonly readFile?: typeof fs.readFileSync;
  readonly sleep?: (seconds: number) => void;
}

export interface CreatedSandboxPolicyRegistrationInput extends CreatedSandboxPolicyVerificationInput {
  readonly operation: string;
}

/** Flatten one verified create boundary into its bounded identity checkpoint. */
export function pendingSandboxCreateVerificationForBoundary(
  boundary: VerifiedSandboxPolicyBoundary,
): PendingSandboxCreateVerification {
  return {
    schemaVersion: 1,
    state: "verified-create",
    gatewayName: boundary.gatewayName,
    gatewayPort: boundary.gatewayPort,
    sandboxName: boundary.sandboxName,
    lifecycleGeneration: boundary.lifecycleGeneration,
    sandboxIdentityFingerprint: boundary.lifecycleLiveIdentityFingerprint,
    ...(boundary.createAttemptNonce ? { createAttemptNonce: boundary.createAttemptNonce } : {}),
    route: boundary.route,
  };
}

export function verifiedSandboxPolicyBoundaryFromPendingCheckpoint(
  value: unknown,
): Omit<VerifiedSandboxPolicyBoundary, "policySourcePath"> {
  const checkpoint = normalizePendingSandboxCreateVerification(value);
  if (!checkpoint) throw new Error("Verified sandbox create checkpoint is unavailable.");
  return {
    registration: {},
    sandboxName: checkpoint.sandboxName,
    gatewayName: checkpoint.gatewayName,
    gatewayPort: checkpoint.gatewayPort,
    lifecycleGeneration: checkpoint.lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: checkpoint.sandboxIdentityFingerprint,
    ...(checkpoint.createAttemptNonce ? { createAttemptNonce: checkpoint.createAttemptNonce } : {}),
    route: checkpoint.route,
  };
}

function readRequiredPolicy(
  input: CreatedSandboxPolicyVerificationInput & { readonly operation: string },
  deps: CreatedSandboxPolicyVerificationDeps,
) {
  try {
    return parseOpenShellPolicy((deps.readFile ?? fs.readFileSync)(input.policySourcePath, "utf8"))
      .policy;
  } catch {
    throw new PolicyObservationError(
      `Refusing to ${input.operation}: the required sandbox policy could not be read.`,
    );
  }
}

function observeCurrentPolicy(
  input: CreatedSandboxPolicyVerificationInput & { readonly operation: string },
  deps: CreatedSandboxPolicyVerificationDeps,
): VerifiedSandboxPolicyRegistration {
  assertOpenShellGatewayPortBinding({
    gatewayName: input.gatewayName,
    gatewayPort: input.gatewayPort,
  });
  const inspection = inspectSandboxPolicy({
    sandboxName: input.sandboxName,
    gatewayName: input.gatewayName,
  });
  try {
    assertPolicyRequirementContainment(inspection, readRequiredPolicy(input, deps));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PolicyObservationError(`Refusing to ${input.operation}: ${detail}.`);
  }
  return {};
}

export function verifyCreatedApfInterceptorPolicyRegistration(
  input: CreatedSandboxPolicyRegistrationInput,
  deps: CreatedSandboxPolicyVerificationDeps = {},
): VerifiedSandboxPolicyRegistration {
  return observeCurrentPolicy(input, deps);
}

export function verifyCreatedSandboxPolicyRegistration(
  input: CreatedSandboxPolicyRegistrationInput,
  deps: CreatedSandboxPolicyVerificationDeps = {},
): VerifiedSandboxPolicyRegistration {
  return observeCurrentPolicy(input, deps);
}

/** Re-read current policy requirements without comparing a prior identity. */
export function revalidateCreatedSandboxPolicyRegistration(
  input: CreatedSandboxPolicyRegistrationInput & {
    readonly registration: VerifiedSandboxPolicyRegistration;
  },
  deps: CreatedSandboxPolicyVerificationDeps = {},
): VerifiedSandboxPolicyRegistration {
  return observeCurrentPolicy(input, deps);
}
