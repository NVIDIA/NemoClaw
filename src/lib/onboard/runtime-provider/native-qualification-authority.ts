// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Immutable GitHub identities resolved by the trusted native qualification
 * collector. The evidence consumer rechecks these identities before issuing
 * an authority receipt; activation must match the receipt to its independently
 * required source identity.
 */
export const NATIVE_RUNTIME_QUALIFICATION_PROTECTED_REPOSITORY = "NVIDIA/NemoClaw";
/** The trusted collector is separate and rejects evidence emitted by its own workflow. */
export const NATIVE_RUNTIME_QUALIFICATION_PRODUCER_WORKFLOW =
  ".github/workflows/e2e.yaml";

export interface NativeRuntimeQualificationProtectedRun {
  readonly repository: string;
  readonly workflow: string;
  readonly pullRequestNumber: number;
  readonly candidateRepository: string;
  readonly headSha: string;
  readonly baseRef: "main";
  readonly baseSha: string;
  readonly runId: number;
  readonly attempt: number;
  readonly jobId: number;
}

export interface NativeRuntimeQualificationExpectedSource extends NativeRuntimeQualificationProtectedRun {
  readonly artifact: {
    readonly id: number;
    readonly name: string;
    readonly digest: string;
  };
}

export interface NativeRuntimeQualificationAuthority {
  readonly schemaVersion: 1;
  readonly qualificationId: string;
  readonly providerId: string;
  readonly source: NativeRuntimeQualificationExpectedSource;
}
