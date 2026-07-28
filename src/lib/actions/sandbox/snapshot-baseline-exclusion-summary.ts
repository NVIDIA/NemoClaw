// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type BaselineExclusionRequest,
  BASELINE_EXCLUSION_SUPPORT_IMPACT,
} from "../../policy/baseline-exclusion";

export function formatSnapshotBaselineExclusionSummary(
  exclusions: readonly BaselineExclusionRequest[],
): string[] {
  if (exclusions.length === 0) return [];
  return [
    `Active baseline exclusions: ${exclusions.map((entry) => entry.key).join(", ")}`,
    `Support impact: ${BASELINE_EXCLUSION_SUPPORT_IMPACT}`,
  ];
}
