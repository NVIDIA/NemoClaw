// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type E2eRiskSignal = {
  version: 1;
  jobId: string;
  shardId: string;
  expectedSha: string;
  testedSha: string;
  planHash: string;
  correlationId: string;
  passed: number;
  failed: number;
  skipped: number;
  // Additive version-1 field; older PR heads omit it and are treated as zero.
  optionalSkipped?: number;
  pending: number;
  unhandledErrors: number;
  runReason: "passed" | "failed" | "interrupted";
};
