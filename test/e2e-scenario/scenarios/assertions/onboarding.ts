// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AssertionGroup } from "../types.ts";

export function onboardingBaseline(): AssertionGroup {
  return {
    id: "onboarding.baseline",
    phase: "onboarding",
    description: "Skeleton onboarding assertion group.",
    steps: [
      {
        id: "onboarding.plan.skeleton",
        phase: "onboarding",
        description: "Placeholder step until onboarding assertions are migrated.",
        implementation: { kind: "pending", ref: "phase-1-skeleton" },
        evidencePath: ".e2e/onboarding.result.json",
      },
    ],
  };
}
