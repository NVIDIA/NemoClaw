// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AssertionGroup } from "../types.ts";

export function runtimeSmokeSkeleton(): AssertionGroup {
  return {
    id: "runtime.smoke.skeleton",
    phase: "runtime",
    description: "Skeleton runtime smoke assertion group.",
    steps: [
      {
        id: "runtime.plan.skeleton",
        phase: "runtime",
        description: "Placeholder step until validation suites are migrated.",
        implementation: { kind: "pending", ref: "phase-1-skeleton" },
        evidencePath: ".e2e/runtime.result.json",
      },
    ],
  };
}
