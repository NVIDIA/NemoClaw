// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  RuntimeProviderNativeArtifactBootstrapOperations,
  RuntimeProviderNativeArtifactBootstrapPlan,
  RuntimeProviderNativeArtifactReadinessEvidence,
  RuntimeProviderNativeArtifactVerifyAndCreateOutcome,
} from "./contract";

export const MXC_NATIVE_ARTIFACT_CONTROL_PLANE_CONTRACT_VERSION = 1 as const;

/**
 * Trusted OpenShell boundary for the inactive MXC candidate.
 *
 * `verifyAndCreate` must hold one stable artifact authority while it verifies the exact artifact
 * and executable digests and creates the sandbox. A caller that measures paths and launches in a
 * later operation does not satisfy this contract.
 */
export interface MxcNativeArtifactControlPlane {
  readonly contractVersion: typeof MXC_NATIVE_ARTIFACT_CONTROL_PLANE_CONTRACT_VERSION;
  readonly providerId: "mxc";
  verifyAndCreate(
    plan: RuntimeProviderNativeArtifactBootstrapPlan,
  ): Promise<RuntimeProviderNativeArtifactVerifyAndCreateOutcome>;
  verifyReadiness(
    plan: RuntimeProviderNativeArtifactBootstrapPlan,
  ): Promise<RuntimeProviderNativeArtifactReadinessEvidence>;
}

export class MxcNativeArtifactControlPlaneError extends Error {
  constructor(message: string) {
    super(`Invalid MXC native artifact control plane: ${message}`);
    this.name = "MxcNativeArtifactControlPlaneError";
  }
}

/** Bind the accepted OpenShell control-plane boundary to one inactive provider bundle. */
export function createMxcNativeArtifactBootstrapOperations(
  controlPlane: MxcNativeArtifactControlPlane,
): RuntimeProviderNativeArtifactBootstrapOperations {
  if (controlPlane?.providerId !== "mxc") {
    throw new MxcNativeArtifactControlPlaneError("provider identity does not match 'mxc'");
  }
  if (controlPlane.contractVersion !== MXC_NATIVE_ARTIFACT_CONTROL_PLANE_CONTRACT_VERSION) {
    throw new MxcNativeArtifactControlPlaneError("contract version is unsupported");
  }
  if (
    typeof controlPlane.verifyAndCreate !== "function" ||
    typeof controlPlane.verifyReadiness !== "function"
  ) {
    throw new MxcNativeArtifactControlPlaneError(
      "atomic verify-and-create and readiness operations are required",
    );
  }
  const verifyAndCreate = controlPlane.verifyAndCreate.bind(controlPlane);
  const verifyReadiness = controlPlane.verifyReadiness.bind(controlPlane);
  return Object.freeze({
    verifyAndCreate: (plan: RuntimeProviderNativeArtifactBootstrapPlan) => verifyAndCreate(plan),
    verifyReadiness: (plan: RuntimeProviderNativeArtifactBootstrapPlan) => verifyReadiness(plan),
  });
}
