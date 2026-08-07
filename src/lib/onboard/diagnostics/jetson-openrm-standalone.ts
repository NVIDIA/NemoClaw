// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxGpuProofResult } from "../../state/registry";
import { createDockerGpuDiagnosticRedactor } from "../docker-gpu-diagnostic-redaction";
import type { DockerGpuPatchDeps } from "../docker-gpu-patch-types";
import { createDockerGpuSandboxCreatePatch } from "../docker-gpu-sandbox-create";
import { createOpenshellCliHelpers } from "../openshell-cli";
import { createDirectSandboxGpuVerifier } from "../sandbox-gpu-preflight";

const SANDBOX_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const CUINIT_801_PATTERN = /cuInit\(0\)=801/u;
const RECREATE_TIMEOUT_SECS = 180;
const OPENRM_POLICY_PROOF_ENV = "NEMOCLAW_DIAGNOSE_JETSON_OPENRM_POLICY";

type SandboxPatch = Pick<
  ReturnType<typeof createDockerGpuSandboxCreatePatch>,
  | "ensureApplied"
  | "rollbackManagedStartupAfterCreateFailure"
  | "verifyGpuOrExit"
  | "waitForSupervisorReconnectIfNeeded"
>;

type StandaloneProofDeps = {
  createPatch?: (options: Parameters<typeof createDockerGpuSandboxCreatePatch>[0]) => SandboxPatch;
  createVerifier?: typeof createDirectSandboxGpuVerifier;
  runCaptureOpenshell?: NonNullable<DockerGpuPatchDeps["runCaptureOpenshell"]>;
  runOpenshell?: NonNullable<DockerGpuPatchDeps["runOpenshell"]>;
};

function compactText(value: string): string {
  return String(value).replace(/\s+/gu, " ").trim();
}

function liveOpenShellRunners(): Pick<
  ReturnType<typeof createOpenshellCliHelpers>,
  "runCaptureOpenshell" | "runOpenshell"
> {
  let cachedBinary: string | null = null;
  const helpers = createOpenshellCliHelpers({
    getCachedBinary: () => cachedBinary,
    setCachedBinary: (binary) => {
      cachedBinary = binary;
    },
    getGatewayPort: () => 0,
    getDockerDriverGatewayEndpoint: () => "",
  });
  return {
    runCaptureOpenshell: helpers.runCaptureOpenshell,
    runOpenshell: helpers.runOpenshell,
  };
}

/**
 * Run the production Jetson Docker recreation, OpenShell CUDA proof, and
 * OpenRM policy matrix without entering the onboarding state machine. The
 * production rollback path restores the original container on every exit.
 */
export async function runStandaloneJetsonOpenRmPolicyProof(
  sandboxName: string,
  deps: StandaloneProofDeps = {},
): Promise<void> {
  if (!SANDBOX_NAME_PATTERN.test(sandboxName)) {
    throw new Error(`Invalid sandbox name: ${sandboxName}`);
  }

  const liveRunners = deps.runOpenshell && deps.runCaptureOpenshell ? null : liveOpenShellRunners();
  const run = deps.runOpenshell ?? liveRunners?.runOpenshell;
  const capture = deps.runCaptureOpenshell ?? liveRunners?.runCaptureOpenshell;
  if (!run || !capture) throw new Error("OpenShell command runners are unavailable.");
  const createVerifier = deps.createVerifier ?? createDirectSandboxGpuVerifier;
  const redactor = createDockerGpuDiagnosticRedactor();
  const verifyGpu = createVerifier({
    runOpenshell: run,
    compactText,
    redact: (value) => redactor.redactText(String(value ?? "")),
    detectNvidiaPlatform: () => "jetson",
  });
  const createPatch = deps.createPatch ?? createDockerGpuSandboxCreatePatch;
  const patch = createPatch({
    route: "compatibility",
    sandboxName,
    timeoutSecs: RECREATE_TIMEOUT_SECS,
    backend: "jetson",
    preserveJetsonDeviceGroupMembership: true,
    deps: {
      runCaptureOpenshell: capture,
      runOpenshell: run,
    },
  });

  let proof: SandboxGpuProofResult | null = null;
  let expectedBoundaryFailure = false;
  let rollbackFailure: unknown = null;
  const previousPolicyProofSetting = process.env[OPENRM_POLICY_PROOF_ENV];
  try {
    await patch.ensureApplied();
    patch.waitForSupervisorReconnectIfNeeded();
    process.env[OPENRM_POLICY_PROOF_ENV] = "1";
    try {
      proof = await patch.verifyGpuOrExit(verifyGpu);
    } catch (error) {
      rollbackFailure =
        error && typeof error === "object"
          ? (error as { managedBootstrapRollbackError?: unknown }).managedBootstrapRollbackError
          : null;
      if (rollbackFailure) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (!CUINIT_801_PATTERN.test(message)) throw error;
      expectedBoundaryFailure = true;
    }
  } finally {
    if (previousPolicyProofSetting === undefined) {
      delete process.env[OPENRM_POLICY_PROOF_ENV];
    } else {
      process.env[OPENRM_POLICY_PROOF_ENV] = previousPolicyProofSetting;
    }
    await patch.rollbackManagedStartupAfterCreateFailure();
    if (!rollbackFailure) {
      console.log("  ✓ Original sandbox container restored after the standalone proof.");
    }
  }

  if (expectedBoundaryFailure) {
    console.log(
      "  ✓ Reproduced the cuInit(0)=801 OpenShell boundary; use the policy matrix above as the result.",
    );
    return;
  }
  if (proof?.status === "verified" && proof.cudaVerified) {
    console.log(
      "  ✓ CUDA already passes through OpenShell; the cuInit(0)=801 boundary did not reproduce.",
    );
    return;
  }
  throw new Error("The standalone run did not execute a conclusive CUDA proof.");
}
