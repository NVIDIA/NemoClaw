// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import {
  assertOpenShellGatewayPortBinding,
  captureSandboxBasePolicy,
  inspectOpenShellSandboxPolicyReadiness,
  inspectSandboxPolicy,
  PolicyObservationError,
} from "../../adapters/openshell/policy-state";
import { assertPolicyRequirementContainment, parseOpenShellPolicy } from "../../policy/merge";

const POLICY_READINESS_MAX_OBSERVATIONS = 5;
const POLICY_READINESS_POLL_INTERVAL_MS = 1_000;

function sleepForPolicyConvergence(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export interface LiveCreatedSandboxPolicyRequirementsInput {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly lifecycleLiveIdentityFingerprint: string;
  readonly policySourcePath: string;
}

export interface LiveCreatedSandboxPolicyRequirementsDeps {
  readonly captureBasePolicy?: typeof captureSandboxBasePolicy;
  readonly readFile?: (path: string, encoding: "utf8") => string;
  readonly inspectPolicy?: typeof inspectSandboxPolicy;
  readonly inspectPolicyReadiness?: typeof inspectOpenShellSandboxPolicyReadiness;
  readonly sleep?: (milliseconds: number) => void;
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
  const inspectPolicy = deps.inspectPolicy ?? inspectSandboxPolicy;
  const inspectPolicyReadiness =
    deps.inspectPolicyReadiness ?? inspectOpenShellSandboxPolicyReadiness;
  const captureBasePolicy = deps.captureBasePolicy ?? captureSandboxBasePolicy;
  const assertBasePolicyRequirements = (
    inspection: ReturnType<typeof inspectSandboxPolicy>,
  ): void => {
    const basePolicy = parseOpenShellPolicy(
      captureBasePolicy(input.sandboxName, input.gatewayName),
    ).policy;
    assertPolicyRequirementContainment(
      { ...inspection, effectivePolicy: basePolicy },
      requiredPolicy,
    );
  };
  let lastFailure = "the exact sandbox policy did not converge";
  let ready = false;
  for (let attempt = 0; attempt < POLICY_READINESS_MAX_OBSERVATIONS; attempt += 1) {
    ready = (() => {
      const before = inspectPolicy({
        sandboxName: input.sandboxName,
        gatewayName: input.gatewayName,
      });
      try {
        assertBasePolicyRequirements(before);
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : String(error);
        return false;
      }
      const readiness = inspectPolicyReadiness({
        sandboxName: input.sandboxName,
        gatewayName: input.gatewayName,
        sandboxIdentityFingerprint: input.lifecycleLiveIdentityFingerprint,
        policyVersion: before.policyIdentity.activeVersion,
      });
      if (readiness.state !== "ready") {
        lastFailure =
          readiness.reason === "sandbox-not-ready"
            ? "the exact sandbox is not Ready"
            : "the observed policy version is not active";
        return false;
      }
      const after = inspectPolicy({
        sandboxName: input.sandboxName,
        gatewayName: input.gatewayName,
      });
      if (
        after.policyIdentity.hash !== before.policyIdentity.hash ||
        after.policyIdentity.activeVersion !== before.policyIdentity.activeVersion
      ) {
        lastFailure = "the live OpenShell policy changed during verification";
        return false;
      }
      try {
        assertBasePolicyRequirements(after);
        return true;
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : String(error);
        return false;
      }
    })();
    if (ready) break;
    if (attempt + 1 < POLICY_READINESS_MAX_OBSERVATIONS) {
      (deps.sleep ?? sleepForPolicyConvergence)(POLICY_READINESS_POLL_INTERVAL_MS);
    }
  }
  if (!ready) {
    throw new PolicyObservationError(`Refusing to ${input.operation}: ${lastFailure}.`);
  }
}
