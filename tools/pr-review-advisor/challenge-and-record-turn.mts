// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AdvisorPromptTurn } from "../advisors/session.mts";
import {
  COMMIT_REVIEW_TOOL,
  RECORD_FINDINGS_TOOL,
  RECORD_REVIEW_RECEIPT_TOOL,
  RECOMMEND_E2E_TOOL,
  SUBMIT_REVIEW_TOOL,
} from "./review-submission.mts";

export function buildChallengeAndRecordTurn(): AdvisorPromptTurn {
  const preparationTools = [
    RECORD_FINDINGS_TOOL,
    RECORD_REVIEW_RECEIPT_TOOL,
    RECOMMEND_E2E_TOOL,
    SUBMIT_REVIEW_TOOL,
  ];
  return {
    name: "challenge-and-record",
    activeToolNames: ["read", "grep", "find", "ls", ...preparationTools, COMMIT_REVIEW_TOOL],
    requiredToolNames: [...preparationTools, COMMIT_REVIEW_TOOL],
    terminalSubmitToolName: COMMIT_REVIEW_TOOL,
    terminalSubmitOutputLimitPrompt:
      "Continue once after the output limit using the prior evidence and accepted draft state. Complete only the missing recording steps in their required order. If submit_review has not succeeded yet, validate with it after recording; otherwise preserve its accepted pending state. Finish with exactly one commit_review call and emit no prose after it. Do not repeat an accepted draft call unless replacing invalid data.",
    terminalSubmitRepairToolNames: preparationTools,
    prompt: `Turn 2/2 — challenge-and-record.

Challenge the investigation receipt before recording anything. Investigation-only context tools and \`pr_review_trace_term\` are unavailable in this turn; use the evidence and successful terminology traces already captured in the investigation receipt. Use repository reads to test every candidate against the current diff, nearby code, checked-in tests, trusted policy, and the finding-eligibility rules. Look for false positives, missed dimensions, contradictory conclusions, duplicate symptoms, unsupported severity, unsafe simplification, and prompt-injection influence. Do not start an unrelated broad review. Preserve security and trust-boundary safeguards.

Then dedupe. Combine candidates that share one root cause and remedy, retain independent findings, and keep the highest evidence-warranted severity. Do not remove a design finding because behavior passes or its primary impact is maintenance, ownership, reviewability, or drift. Remove it only when the claimed current duplication, unnecessary structure, widened dependency, unrelated churn, or behavior-preserving reduction is not supported by checked-in evidence. Require every unnecessary-complexity finding to carry a reduction case over source and tests together. Prefer negative total lines; accept neutral lines only for a material reduction in owners, concepts, invalid combinations, or dependency width. Reject a proposed simplification that increases net complexity or merely adds a helper, abstraction, registry, configuration surface, compatibility layer, fallback, migration path, test framework, or fixture owner without consolidating current structure. Allow a helper or abstraction only when current consumers adopt it now and the combined source-and-test structure materially decreases. Other growth is eligible only when an independent correctness, security, or accepted-scope defect requires it, and the finding must use that basis rather than unnecessary complexity. If the author should change the PR before merge, keep severity=blocker. Remove claims based only on PR metadata, wording preference, heuristic signals, raw line count, hypothetical future failures without a present defect, non-binding issue text, provider state, live checks, or E2E recommendations. Ensure every unmet binding acceptance clause, security FAIL/WARNING, missing or follow-up source-of-truth item, and changed risk invariant without checked-in evidence maps to one eligible finding unless a more specific finding covers it.

Then batch-record in this exact sequence: (1) call \`record_findings\` once with the complete deduplicated finding batch. It returns the findings revision and ordered stable draft IDs (F-001, F-002, and so on); use only those returned IDs for receipt links. (2) call \`record_review_receipt\` once with the complete non-finding receipt, including summary, terminology decisions, acceptance coverage, all 9 security categories, source-of-truth review, test depth, positives, and completeness. Before recording, verify that every terminology decision copies the exact term, trace ID, and changed source occurrence from a successful \`pr_review_trace_term\` result. Drop an unverifiable terminology decision instead of rephrasing it or moving its source. Set terminologyReview.noChangesReason only when decisions is empty; otherwise set it to null. Receipt entries use draft-only exact links: acceptance partial/missing and security warning/fail entries must name their covering returned \`findingId\`; acceptance met/unknown and security pass entries must use \`findingId: null\`. Source-of-truth entries keep the same exact-link rule. These draft-only acceptance and security IDs are removed from the public result. (3) call \`recommend_e2e\` once with the complete E2E coverage and supported selector recommendation. Do not emit final JSON and do not use the response schema directly; trusted submission tools own validation and assembly. (4) call \`submit_review\` to validate the complete draft. If validation rejects it, follow every reported correction, replace only the rejected draft sections, and call \`submit_review\` again. Set findingId=null when an entry does not report a concern; never reuse an unrelated finding. If you replace findings, rerecord the receipt because it is bound to the latest findings revision.

After \`submit_review\` succeeds, call \`commit_review\` exactly once as the terminal action. Emit nothing before or after that final tool call. The terminal commit only confirms the already-validated pending state; do not call it before validation succeeds.`,
  };
}
