// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingPlan } from "./manifest";

export type RegistryMessagingAuthority =
  | {
      readonly authoritative: true;
      readonly plan: SandboxMessagingPlan | null;
    }
  | {
      readonly authoritative: false;
      readonly plan: null;
    };

export interface MessagingPlanAuthorityInput {
  readonly sandboxName: string;
  readonly registry: RegistryMessagingAuthority;
  readonly stagedPlan: SandboxMessagingPlan | null;
  readonly sessionPlan: SandboxMessagingPlan | null;
}

export interface MessagingPlanAuthorityResult {
  readonly source: "registry" | "staged" | "session" | "none";
  readonly plan: SandboxMessagingPlan | null;
}

function planTargetsSandbox(plan: SandboxMessagingPlan | null, sandboxName: string): boolean {
  return plan?.sandboxName === sandboxName;
}

/** Resolve logical messaging intent. Raw credential values are not inputs. */
export function resolveMessagingPlanAuthority(
  input: MessagingPlanAuthorityInput,
): MessagingPlanAuthorityResult {
  if (input.registry.authoritative) {
    if (input.registry.plan && !planTargetsSandbox(input.registry.plan, input.sandboxName)) {
      throw new Error(
        `Registry messaging plan targets '${input.registry.plan.sandboxName}', not '${input.sandboxName}'.`,
      );
    }
    return { source: "registry", plan: input.registry.plan };
  }
  if (input.stagedPlan && !planTargetsSandbox(input.stagedPlan, input.sandboxName)) {
    throw new Error(
      `Staged messaging plan targets '${input.stagedPlan.sandboxName}', not '${input.sandboxName}'.`,
    );
  }
  if (input.stagedPlan && planTargetsSandbox(input.stagedPlan, input.sandboxName)) {
    return { source: "staged", plan: input.stagedPlan };
  }
  if (input.sessionPlan && !planTargetsSandbox(input.sessionPlan, input.sandboxName)) {
    throw new Error(
      `Session messaging plan targets '${input.sessionPlan.sandboxName}', not '${input.sandboxName}'.`,
    );
  }
  if (input.sessionPlan && planTargetsSandbox(input.sessionPlan, input.sandboxName)) {
    return { source: "session", plan: input.sessionPlan };
  }
  return { source: "none", plan: null };
}
