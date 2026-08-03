// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reversible, secret-free onboarding intent collection.
 *
 * This controller deliberately ends at the review boundary. Callers may start
 * external work only after it returns an `apply` result.
 */

export type DraftPromptResult<Value> =
  | { readonly kind: "answer"; readonly value: Value }
  | { readonly kind: "back" }
  | { readonly kind: "exit" };

export type DraftReviewResult<StepId extends string> =
  | { readonly kind: "apply" }
  | { readonly kind: "edit"; readonly step: StepId }
  | { readonly kind: "exit" };

export type DraftCollectionResult<Draft> =
  | { readonly kind: "apply"; readonly draft: Draft }
  | { readonly kind: "exit"; readonly draft: Draft };

export interface DraftStep<StepId extends string, Draft, Value> {
  readonly id: StepId;
  readonly label: string;
  read(draft: Draft): Value | undefined;
  write(draft: Draft, value: Value): Draft;
  prompt(options: {
    readonly draft: Draft;
    readonly previous: Value | undefined;
    readonly direction: "forward" | "back";
  }): Promise<DraftPromptResult<Value>>;
}

export interface CollectIntentDraftOptions<StepId extends string, Draft> {
  readonly steps: readonly DraftStep<StepId, Draft, unknown>[];
  readonly initialDraft: Draft;
  readonly review: (draft: Draft) => Promise<DraftReviewResult<StepId>>;
  /**
   * Revalidate dependent answers after one answer changes. Compatible answers
   * stay populated; incompatible answers are returned as `undefined` by their
   * step and are collected again.
   */
  readonly reconcile: (options: {
    readonly previous: Draft;
    readonly next: Draft;
    readonly changedStep: StepId;
  }) => Draft;
  /** Revalidate a complete draft against current capabilities before review. */
  readonly prepareReview?: (draft: Draft) => Promise<Draft> | Draft;
  /** Persist only the caller-defined secret-free draft. */
  readonly checkpoint?: (draft: Draft) => Promise<void> | void;
}

function firstIncompleteStepIndex<StepId extends string, Draft>(
  steps: readonly DraftStep<StepId, Draft, unknown>[],
  draft: Draft,
): number {
  return steps.findIndex((step) => step.read(draft) === undefined);
}

function findStepIndex<StepId extends string, Draft>(
  steps: readonly DraftStep<StepId, Draft, unknown>[],
  stepId: StepId,
): number {
  const index = steps.findIndex((step) => step.id === stepId);
  if (index < 0) throw new Error(`Unknown onboarding draft step: ${stepId}`);
  return index;
}

/**
 * Collect an onboarding draft, allow stepwise Back navigation, and provide a
 * direct edit menu at review. The function itself performs no materialization.
 */
export async function collectIntentDraft<StepId extends string, Draft>(
  options: CollectIntentDraftOptions<StepId, Draft>,
): Promise<DraftCollectionResult<Draft>> {
  if (options.steps.length === 0) throw new Error("Onboarding draft requires at least one step.");

  let draft = options.initialDraft;
  let stepIndex = firstIncompleteStepIndex(options.steps, draft);
  let atReview = stepIndex < 0;
  let direction: "forward" | "back" = "forward";
  if (stepIndex < 0) stepIndex = options.steps.length - 1;

  while (true) {
    if (!atReview) {
      const step = options.steps[stepIndex];
      const result = await step.prompt({ draft, previous: step.read(draft), direction });
      if (result.kind === "exit") return { kind: "exit", draft };
      if (result.kind === "back") {
        stepIndex = Math.max(0, stepIndex - 1);
        direction = "back";
        continue;
      }

      const previous = draft;
      const withAnswer = step.write(draft, result.value);
      draft = options.reconcile({ previous, next: withAnswer, changedStep: step.id });
      await options.checkpoint?.(draft);
      direction = "forward";

      const incompleteIndex = firstIncompleteStepIndex(options.steps, draft);
      if (incompleteIndex < 0) {
        atReview = true;
      } else {
        stepIndex = incompleteIndex;
      }
      continue;
    }

    const incompleteIndex = firstIncompleteStepIndex(options.steps, draft);
    if (incompleteIndex >= 0) {
      stepIndex = incompleteIndex;
      atReview = false;
      direction = "forward";
      continue;
    }

    if (options.prepareReview) {
      const prepared = await options.prepareReview(draft);
      if (prepared !== draft) {
        draft = prepared;
        await options.checkpoint?.(draft);
        continue;
      }
    }

    const reviewResult = await options.review(draft);
    if (reviewResult.kind === "apply") return { kind: "apply", draft };
    if (reviewResult.kind === "exit") return { kind: "exit", draft };
    stepIndex = findStepIndex(options.steps, reviewResult.step);
    atReview = false;
    direction = "forward";
  }
}

export type OnboardDraftPhase = "collecting" | "accepted" | "materializing";

/** Reject Back after the review boundary instead of pretending to roll effects back. */
export function assertDraftNavigationAllowed(phase: OnboardDraftPhase, cliName: string): void {
  if (phase === "collecting") return;
  throw new Error(
    `Back navigation is unavailable after Apply configuration. Use \`${cliName} <sandbox-name> rebuild\` or rerun \`${cliName} onboard --fresh\` to change the accepted configuration.`,
  );
}

/** Refuse any branch that would silently revisit an accepted choice. */
export function assertDraftRevisionAllowed(
  phase: OnboardDraftPhase,
  choice: string,
  cliName: string,
): void {
  if (phase === "collecting") return;
  throw new Error(
    `Cannot change ${choice} after Apply configuration. Use \`${cliName} <sandbox-name> rebuild\` or rerun \`${cliName} onboard --fresh\` to review a different configuration.`,
  );
}
