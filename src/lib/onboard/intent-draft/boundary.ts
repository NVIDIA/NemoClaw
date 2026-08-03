// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OnboardIntentDraft } from "./schema";

export interface OnboardIntentDraftBoundaryOptions {
  readonly shouldCollect: boolean;
  readonly existingDraft: OnboardIntentDraft | null;
  readonly initialDraft: OnboardIntentDraft;
  collect(
    initialDraft: OnboardIntentDraft,
  ): Promise<
    | { readonly kind: "apply"; readonly draft: OnboardIntentDraft }
    | { readonly kind: "exit"; readonly draft: OnboardIntentDraft }
  >;
  /** Runs only after Apply, or for an already accepted resumed draft. */
  accept(draft: OnboardIntentDraft): Promise<void> | void;
}

export type OnboardIntentDraftBoundaryResult =
  | { readonly kind: "continue"; readonly draft: OnboardIntentDraft | null }
  | { readonly kind: "exit"; readonly draft: OnboardIntentDraft };

/**
 * Enforce the review/commit boundary. Callers put every materialization
 * projection behind `accept`; the collector can only checkpoint its draft.
 */
export async function crossOnboardIntentDraftBoundary(
  options: OnboardIntentDraftBoundaryOptions,
): Promise<OnboardIntentDraftBoundaryResult> {
  let acceptedDraft = options.existingDraft?.phase === "accepted" ? options.existingDraft : null;
  if (options.shouldCollect) {
    const result = await options.collect(options.existingDraft ?? options.initialDraft);
    if (result.kind === "exit") return result;
    acceptedDraft = result.draft;
  }
  if (acceptedDraft) await options.accept(acceptedDraft);
  return { kind: "continue", draft: acceptedDraft };
}
