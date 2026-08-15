// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  NATIVE_RUNTIME_QUALIFICATION_PRODUCER_WORKFLOW,
  NATIVE_RUNTIME_QUALIFICATION_PROTECTED_REPOSITORY,
  PODMAN_PROTECTED_HOST_LOCAL_INFERENCE_QUALIFICATION,
  type NativeRuntimeQualificationDefinition,
  type NativeRuntimeQualificationEvidenceEnvelope,
  type NativeRuntimeQualificationExpectedSource,
  type NativeRuntimeQualificationProtectedRun,
} from "../e2e/registry/native-runtime-qualification";

export const NATIVE_QUALIFICATION_HEAD_SHA = "a".repeat(40);
export const NATIVE_QUALIFICATION_BASE_SHA = "b".repeat(40);
export const NATIVE_QUALIFICATION_ARTIFACT_SHA256 = "c".repeat(64);
export const NATIVE_QUALIFICATION_RECEIPT_CONTENT = '{"qualified":true}\n';
export const NATIVE_QUALIFICATION_RECEIPT_SHA256 = createHash("sha256")
  .update(NATIVE_QUALIFICATION_RECEIPT_CONTENT)
  .digest("hex");
const IMAGE_DIGEST = `sha256:${"d".repeat(64)}`;

export function nativeQualificationReceiptReader(): Buffer {
  return Buffer.from(NATIVE_QUALIFICATION_RECEIPT_CONTENT, "utf8");
}

export function nativeQualificationExpectedSource(): NativeRuntimeQualificationExpectedSource {
  return {
    repository: NATIVE_RUNTIME_QUALIFICATION_PROTECTED_REPOSITORY,
    workflow: NATIVE_RUNTIME_QUALIFICATION_PRODUCER_WORKFLOW,
    pullRequestNumber: 9143,
    candidateRepository: NATIVE_RUNTIME_QUALIFICATION_PROTECTED_REPOSITORY,
    headSha: NATIVE_QUALIFICATION_HEAD_SHA,
    baseRef: "main",
    baseSha: NATIVE_QUALIFICATION_BASE_SHA,
    runId: 7001,
    attempt: 2,
    jobId: 8001,
    artifact: {
      id: 9001,
      name: "native-runtime-qualification-9143",
      digest: `sha256:${NATIVE_QUALIFICATION_ARTIFACT_SHA256}`,
    },
  };
}

function protectedRun(
  overrides: Partial<NativeRuntimeQualificationProtectedRun>,
): NativeRuntimeQualificationProtectedRun {
  const { artifact: _artifact, ...source } = nativeQualificationExpectedSource();
  return { ...source, ...overrides };
}

export function nativeQualificationEvidence(
  sourceOverrides: Partial<NativeRuntimeQualificationProtectedRun> = {},
): NativeRuntimeQualificationEvidenceEnvelope {
  return nativeQualificationEvidenceForDefinition(
    PODMAN_PROTECTED_HOST_LOCAL_INFERENCE_QUALIFICATION,
    sourceOverrides,
  );
}

export function nativeQualificationEvidenceForDefinition(
  qualification: NativeRuntimeQualificationDefinition,
  sourceOverrides: Partial<NativeRuntimeQualificationProtectedRun> = {},
): NativeRuntimeQualificationEvidenceEnvelope {
  return {
    schemaVersion: 1,
    qualificationId: qualification.id,
    providerId: qualification.providerId,
    cases: qualification.cases.map((entry) => ({
      schemaVersion: 1,
      caseId: entry.id,
      protectedRun: protectedRun(sourceOverrides),
      installer: {
        providerId: qualification.providerId,
        architecture: entry.architecture,
        dockerAvailability: "unavailable",
        exitCode: 0,
        invocation: {
          path: `installer/${entry.id}.json`,
          sha256: NATIVE_QUALIFICATION_RECEIPT_SHA256,
        },
        script: {
          path: "installer/install.sh",
          sha256: NATIVE_QUALIFICATION_RECEIPT_SHA256,
        },
      },
      runtime: {
        providerId: qualification.providerId,
        agent: entry.agent,
        inference: entry.inference,
        architecture: entry.architecture,
        acceleration: entry.acceleration,
        rootMode: "rootless",
        engineName: "candidate-runtime",
        engineVersion: "1.0.0",
        managedImages: [{ role: "agent", digest: IMAGE_DIGEST }],
        result: {
          path: `runtime/${entry.id}.json`,
          sha256: NATIVE_QUALIFICATION_RECEIPT_SHA256,
        },
      },
      operations: entry.obligations.map((id) => ({
        id,
        artifact: {
          path: `operations/${entry.id}-${id}.json`,
          sha256: NATIVE_QUALIFICATION_RECEIPT_SHA256,
        },
      })),
      ...(entry.acceleration === "nvidia-gpu"
        ? {
            nvidiaCdi: {
              device: "nvidia.com/gpu=all" as const,
              artifact: {
                path: `cdi/${entry.id}.json`,
                sha256: NATIVE_QUALIFICATION_RECEIPT_SHA256,
              },
            },
          }
        : {}),
    })),
  };
}
