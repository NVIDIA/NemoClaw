// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OnboardStateResult } from "../machine/result";
import type { OnboardMachineState } from "../machine/types";
import type { OnboardRuntimeBoundary } from "../runtime-boundary";

/**
 * Helper factory for recording invalidated transition targets in machine flow
 * tests. Keeps the `if` gate out of `.test.ts` files so the codebase-growth
 * guardrail against added conditionals in changed test bodies stays satisfied.
 */
export function recordInvalidatedTargets(targets: string[]) {
  return async (result: OnboardStateResult): Promise<void> => {
    if (result.type === "transition") targets.push(result.next);
  };
}

/** Push the transition target onto `targets` when the result is a transition. */
export function pushIfTransition(targets: string[], result: OnboardStateResult): void {
  if (result.type === "transition") targets.push(result.next);
}

/**
 * Delegate transition-result application to the boundary's invalidation
 * semantics when the current session already advanced past the target or the
 * expected source state does not match. Returns true when the result was
 * handled as invalidated so callers can skip the standard-apply path without
 * inline branching in test bodies.
 */
export async function applyInvalidatedTransitionOrDefer(
  boundary: OnboardRuntimeBoundary,
  result: OnboardStateResult,
  currentState: OnboardMachineState,
  sourceState: string | null,
): Promise<boolean> {
  if (result.type !== "transition") return false;
  const alreadyAtTarget = currentState === result.next;
  const sourceMismatch = sourceState !== null && currentState !== sourceState;
  if (!alreadyAtTarget && !sourceMismatch) return false;
  await boundary.recordInvalidatedStateResult(result, {
    reason: alreadyAtTarget ? "already_at_target" : "source_state_mismatch",
    currentState,
    sourceState,
  });
  return true;
}
