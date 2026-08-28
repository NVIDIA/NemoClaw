// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import {
  assertOpenShellGatewayPortBinding,
  inspectSandboxPolicy,
  PolicyObservationError,
} from "../../adapters/openshell/policy-state";
import { assertPolicyRequirementContainment, parseOpenShellPolicy } from "../../policy/merge";

export interface LiveCreatedSandboxPolicyRequirementsInput {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly policySourcePath: string;
}

export interface LiveCreatedSandboxPolicyRequirementsDeps {
  readonly readFile?: typeof fs.readFileSync;
}

export interface LiveCreatedSandboxPolicyRequirementsCheck extends LiveCreatedSandboxPolicyRequirementsInput {
  readonly operation: string;
}

/** Verify a created sandbox against the current live OpenShell policy. */
export function verifyLiveCreatedSandboxPolicyRequirements(
  input: LiveCreatedSandboxPolicyRequirementsCheck,
  deps: LiveCreatedSandboxPolicyRequirementsDeps = {},
): void {
  assertOpenShellGatewayPortBinding({
    gatewayName: input.gatewayName,
    gatewayPort: input.gatewayPort,
  });
  const inspection = inspectSandboxPolicy({
    sandboxName: input.sandboxName,
    gatewayName: input.gatewayName,
  });
  let requiredPolicy: ReturnType<typeof parseOpenShellPolicy>["policy"];
  try {
    requiredPolicy = parseOpenShellPolicy(
      (deps.readFile ?? fs.readFileSync)(input.policySourcePath, "utf8"),
    ).policy;
  } catch {
    throw new PolicyObservationError(
      `Refusing to ${input.operation}: the required sandbox policy could not be read.`,
    );
  }
  try {
    assertPolicyRequirementContainment(inspection, requiredPolicy);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PolicyObservationError(`Refusing to ${input.operation}: ${detail}.`);
  }
}
