// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  assertNativeRuntimeQualificationEvidence,
  type CompiledNativeRuntimeQualification,
  createNativeRuntimeQualificationReporterRecord,
  type NativeRuntimeQualificationEvidence,
  type NativeRuntimeQualificationProtectedRun,
  type NativeRuntimeQualificationProtectedRunBinding,
  type VerifiedNativeRuntimeQualificationEvidence,
  verifyNativeRuntimeQualificationReporterArtifacts,
} from "../../test/e2e/registry/activation-qualification.ts";

export interface AuthenticatedNativeRuntimeQualificationJob {
  /** GitHub Actions job ID read by the protected controller. */
  readonly id: number;
  /** Controller-owned root of the downloaded artifact for this exact job. */
  readonly artifactRoot: string;
}

export type AuthenticatedNativeRuntimeQualificationRun = Omit<
  NativeRuntimeQualificationProtectedRun,
  "jobId"
> & {
  /** Jobs authenticated for this run through the GitHub control plane. */
  readonly jobs: readonly AuthenticatedNativeRuntimeQualificationJob[];
};

export interface TrustedNativeRuntimeQualificationControllerInput {
  readonly definition: CompiledNativeRuntimeQualification;
  readonly evidence: readonly NativeRuntimeQualificationEvidence[];
  /**
   * Control-plane records supplied by the protected controller after it has
   * authenticated the workflow run and jobs. Never derive these from worker
   * evidence or downloaded artifact contents.
   */
  readonly authenticatedRuns: readonly AuthenticatedNativeRuntimeQualificationRun[];
}

function controllerBindings(
  runs: readonly AuthenticatedNativeRuntimeQualificationRun[],
): NativeRuntimeQualificationProtectedRunBinding[] {
  if (!Array.isArray(runs) || runs.length === 0) {
    throw new Error("Native runtime qualification requires authenticated controller runs");
  }
  return runs.flatMap(({ jobs, ...run }) => {
    if (!Array.isArray(jobs) || jobs.length === 0) {
      throw new Error("Native runtime qualification authenticated run has no jobs");
    }
    return jobs.map((job) => ({
      artifactRoot: job.artifactRoot,
      protectedRun: { ...run, jobId: job.id },
    }));
  });
}

/**
 * Trusted-controller acceptance boundary for native-runtime qualification.
 *
 * This adapter deliberately offers no caller-supplied binding argument. It
 * constructs bindings only from authenticated run/job state, re-hashes every
 * referenced artifact, and returns evidence only after the canonical
 * acceptance assertion succeeds. The later activation workflow may call this
 * adapter; defining it here does not activate a runtime provider.
 */
export function verifyNativeRuntimeQualificationFromTrustedController({
  definition,
  evidence,
  authenticatedRuns,
}: TrustedNativeRuntimeQualificationControllerInput): VerifiedNativeRuntimeQualificationEvidence {
  const reporter = createNativeRuntimeQualificationReporterRecord(
    definition,
    evidence,
    controllerBindings(authenticatedRuns),
  );
  const verified = verifyNativeRuntimeQualificationReporterArtifacts(definition, reporter);
  assertNativeRuntimeQualificationEvidence(definition, verified);
  return verified;
}
