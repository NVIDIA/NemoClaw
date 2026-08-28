// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import {
  assertOpenShellGatewayPortBinding,
  inspectSandboxPolicy,
  PolicyObservationError,
} from "../../adapters/openshell/policy-state";
import { assertPolicyRequirementContainment, parseOpenShellPolicy } from "../../policy/merge";
import type { SelectedDockerGpuRoute } from "../docker-gpu-route";

export interface CreatedSandboxPolicyRequirementsInput {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly lifecycleGeneration: string;
  readonly lifecycleLiveIdentityFingerprint: string;
  readonly policySourcePath: string;
  readonly route: SelectedDockerGpuRoute;
}

export interface CreatedSandboxPolicyRequirementsDeps {
  readonly readFile?: typeof fs.readFileSync;
  readonly sleep?: (seconds: number) => void;
}

export interface CreatedSandboxPolicyRequirementsCheck extends CreatedSandboxPolicyRequirementsInput {
  readonly operation: string;
}

function readRequiredPolicy(
  input: CreatedSandboxPolicyRequirementsInput & { readonly operation: string },
  deps: CreatedSandboxPolicyRequirementsDeps,
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
  input: CreatedSandboxPolicyRequirementsInput & { readonly operation: string },
  deps: CreatedSandboxPolicyRequirementsDeps,
): void {
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
}

export function verifyCreatedApfInterceptorPolicyRequirements(
  input: CreatedSandboxPolicyRequirementsCheck,
  deps: CreatedSandboxPolicyRequirementsDeps = {},
): void {
  observeCurrentPolicy(input, deps);
}

export function verifyCreatedSandboxPolicyRequirements(
  input: CreatedSandboxPolicyRequirementsCheck,
  deps: CreatedSandboxPolicyRequirementsDeps = {},
): void {
  observeCurrentPolicy(input, deps);
}

/** Re-read current policy requirements without comparing a prior policy identity. */
export function verifyCurrentCreatedSandboxPolicyRequirements(
  input: CreatedSandboxPolicyRequirementsCheck,
  deps: CreatedSandboxPolicyRequirementsDeps = {},
): void {
  observeCurrentPolicy(input, deps);
}
