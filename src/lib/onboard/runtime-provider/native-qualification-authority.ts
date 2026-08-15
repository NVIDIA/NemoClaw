// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface NativeRuntimeQualificationArtifactIdentity {
  readonly id: string;
  readonly name: string;
  readonly digest: string;
  readonly sizeInBytes: number;
}

/**
 * Source identity authenticated by the protected native runtime qualification
 * collector. Keep this shape aligned with the qualification plan and authority
 * so activation can compare the authority with an independent requirement.
 */
export interface NativeRuntimeQualificationPlanSource {
  readonly repository: "NVIDIA/NemoClaw";
  readonly producerWorkflow: ".github/workflows/e2e.yaml";
  readonly pullRequestNumber: number;
  readonly candidateRepository: string;
  readonly candidateSha: string;
  readonly baseRef: "main";
  readonly baseSha: string;
  readonly workflowSha: string;
  readonly producerRunId: string;
  readonly producerRunAttempt: 1;
  readonly dispatchArtifact: NativeRuntimeQualificationArtifactIdentity;
}

export interface NativeRuntimeQualificationProtectedJobIdentity {
  readonly caseId: string;
  readonly id: string;
  readonly name: string;
}

export interface NativeRuntimeQualificationAuthoritySource extends NativeRuntimeQualificationPlanSource {
  readonly protectedJobs: readonly NativeRuntimeQualificationProtectedJobIdentity[];
}

/** Issued only after the protected collector authenticates complete evidence. */
export interface NativeRuntimeQualificationAuthority {
  readonly schemaVersion: 1;
  readonly kind: "nemoclaw-native-runtime-qualification-authority-v1";
  readonly qualificationId: string;
  readonly providerId: string;
  readonly source: NativeRuntimeQualificationAuthoritySource;
}
