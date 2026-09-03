// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RuntimeProviderStateMutationPlan } from "../../src/lib/onboard/runtime-provider/contract";

type ProtectionTransitionPlan = Extract<
  RuntimeProviderStateMutationPlan,
  { readonly intent: "protection-transition" }
>;

export function requireProtectionTransitionPlan(
  plan: RuntimeProviderStateMutationPlan,
): ProtectionTransitionPlan {
  if (plan.intent !== "protection-transition") {
    throw new Error("expected protection-transition plan");
  }
  return plan;
}
