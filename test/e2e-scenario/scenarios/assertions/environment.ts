// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AssertionGroup } from "../types.ts";

export function environmentBaseline(): AssertionGroup {
  return {
    id: "environment.baseline",
    phase: "environment",
    description: "Skeleton environment baseline assertion group.",
    migrationStatus: "complete",
    steps: [
      {
        id: "environment.plan.skeleton",
        phase: "environment",
        description: "Placeholder step until live environment orchestration is migrated.",
        implementation: { kind: "pending", ref: "phase-1-skeleton" },
        evidencePath: ".e2e/environment.result.json",
      },
    ],
  };
}
