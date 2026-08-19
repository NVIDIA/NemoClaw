// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  readTrustedCodeChangeConsiderations,
  readTrustedControlledWords,
  readTrustedSecurityRubric,
  readTrustedWritingGuide,
} from "../tools/pr-review-advisor/analyze.mts";

describe("PR review advisor writing guides", () => {
  it("loads and embeds the checked-in review guides", () => {
    const rubric = readTrustedSecurityRubric();
    const writingGuide = readTrustedWritingGuide();
    const controlledWords = readTrustedControlledWords();
    const considerations = readTrustedCodeChangeConsiderations();
    const prompt = buildSystemPrompt();

    expect(rubric).toContain("# Security Rubric");
    expect(rubric).toContain("Category 1: Secrets and Credentials");
    expect(rubric).toContain("Category 9: System Security");
    expect(writingGuide).toContain("# NemoClaw Writing Guide");
    expect(writingGuide).toContain("Use one term for one concept");
    expect(writingGuide).toContain("## Scope and Review Policy");

    expect(writingGuide).toContain("### Agent-Written Text");
    expect(writingGuide).toContain("Tool-call labels and descriptions");
    expect(controlledWords).toContain("| `commit under review` | Technical noun |");
    expect(controlledWords).toContain("| `latest PR commit` | Technical noun |");
    expect(controlledWords).toContain("| `commit SHA` | Technical noun |");
    expect(controlledWords).toContain("| `runtime provider state mutation` | Technical noun |");
    expect(considerations).toContain("# Code Change Considerations");
    expect(prompt).toContain("Trusted security rubric from workflow checkout");
    expect(prompt).toContain("Trusted code change considerations from workflow checkout");
    expect(prompt).toContain("Trusted NemoClaw writing guide from workflow checkout");
    expect(prompt).toContain("# Security Rubric");
    expect(prompt).toContain("Category 1: Secrets and Credentials");
    expect(prompt).not.toContain("## Step 1: Parse the GitHub URL");
    expect(prompt).toContain("# NemoClaw Writing Guide");
    expect(prompt).toContain("Use one term for one concept");
  });

  it("includes terminology and review-scope policy", () => {
    const prompt = buildSystemPrompt();

    expect(prompt).toContain(
      "Apply it before you return a response or start a tool call with a visible label or description",
    );
    expect(prompt).toContain(
      "documentation, code comments, test titles, user-visible messages, and tool-call labels or descriptions",
    );
    expect(prompt).toContain(
      "Apply the guide's language-finding threshold to each related finding",
    );
    expect(prompt).toContain("Do not request unrelated language cleanup");
    expect(prompt).toContain("SSRF-shaped input");
    expect(prompt).toContain("sandbox escape, SSRF bypass, policy bypass");
    expect(prompt).not.toContain("For NemoClaw PRs, check sandbox escape vectors");
    expect(prompt).toContain(
      "Do not report GitHub mergeability, branch protection, CI status, reviewer state, CodeRabbit state, or external E2E job status",
    );
    expect(prompt).toContain(
      "merge_as_is means a completed, non-low-confidence review has no open findings",
    );
    expect(prompt).toContain(
      "info_only is reserved for skipped, unavailable, incomplete, or low-confidence review evidence",
    );
    expect(prompt).toContain("merge_as_is never approves the PR or replaces required human review");
    expect(prompt).toContain(
      "compare it with the current diff and decide whether prior code-review findings were addressed",
    );
    expect(prompt).toContain("PR-description or template compliance");
  });

  it("documents finding eligibility, severity, and evidence rules", () => {
    const prompt = buildSystemPrompt();

    expect(prompt).toContain(
      "any unmet binding acceptance clause or security fail/warning must be represented as a finding",
    );
    expect(prompt).toContain("Source-of-truth review");
    expect(prompt).toContain("E2E suite architecture");
    expect(prompt).toContain(
      "testDepth.suggestedTests are internal review notes, not author tasks",
    );
    expect(prompt).toContain(
      "use category=tests only when the gap is not already part of another defect",
    );
    expect(prompt).toContain("Every finding must be probe-shaped");
    expect(prompt).toContain("Simplification review");
    expect(prompt).toContain("Deterministic regression risks");
    expect(prompt).toContain("E2E guidance");
    expect(prompt).toContain("E2E guidance is not a finding");
    expect(prompt).toContain("A required validation job is not a finding unless");
    expect(prompt).toContain("Prior-advisor availability, failure, or incompleteness");
    expect(prompt).toContain("record_findings");
    expect(prompt).toContain("submit_review is nonmutating validation and assembly");
    expect(prompt).toContain("delete, stdlib, native, yagni, or shrink");
    expect(prompt).not.toContain("Consider writing more tests for");
    expect(prompt).toContain("E2E suite architecture");
    expect(prompt).toContain("shortest stable test");
    expect(prompt).toContain("defaults, retries, recovery, and cleanup");
    expect(prompt).toContain(
      "Any sourceOfTruthReview item with status=missing or status=needs_followup must also be represented as a finding",
    );
    expect(prompt).toContain("Finding severity mapping: blocker renders as 'Blocker'");
    expect(prompt).toContain("Proposed designs, implementation ideas, investigation notes");
    expect(prompt).toContain("author_association is OWNER, MEMBER, or COLLABORATOR");
    expect(prompt).toContain("A Refs, Related, or Follow-up link does not commit the PR");
    expect(prompt).toContain("When several symptoms or locations share one root cause and remedy");
    expect(prompt).toContain("suggestion renders as 'Suggestion'");
    expect(prompt).toContain("The controlled word list is not a general dictionary");
    expect(prompt).toContain(
      "absence of an ordinary phrase from the controlled word list",
    );
  });

  it("treats material present design defects as blockers", () => {
    const prompt = buildSystemPrompt();

    expect(prompt).toContain(
      "present behavioral, security, scope, or material codebase-design defect",
    );
    expect(prompt).toContain(
      "If a finding asks the author to change code before merge, classify it as blocker",
    );
    expect(prompt).toContain(
      "Passing tests or currently matching outputs do not downgrade duplicated authority",
    );
    expect(prompt).toContain("basis.kind=unnecessary_complexity");
    expect(prompt).toContain("does not require an externally visible behavior failure");
    expect(prompt).toContain(
      "Requiring synchronized edits to two current implementations of one contract is a present defect",
    );
    expect(prompt).toContain("a raw line count by itself");
    expect(prompt).toContain("mere open-PR overlap or merge coordination");
    expect(prompt).toContain(
      "For redundancy or ownership findings, checked-out evidence must show that the current PR introduces or retains duplicate or conflicting ownership",
    );
    expect(prompt).toContain(
      "This ownership requirement does not apply to independently supported correctness, security, scope, or other design defects",
    );
    expect(prompt).not.toContain(
      "A finding is eligible when checked-out evidence shows that the current PR introduces or retains duplicate or conflicting ownership",
    );
    expect(prompt).toContain(
      "If a refreshed base only makes the PR unnecessary without leaving duplicate or conflicting code",
    );
    expect(prompt).not.toContain("refreshed base already contains equivalent behavior");
    expect(prompt).toContain("use recommendation=superseded");
    expect(prompt).toContain(
      "missing that authorization is a current scope defect, not template noncompliance",
    );
    expect(prompt).toContain("Duplicated test setup, parallel test owners");
    expect(prompt).toContain(
      "Preserve semantic regression coverage and necessary boundary evidence",
    );
    expect(prompt).toContain(
      "produce a reduction case that names the current code, owners, concepts, branches, parameters, fixtures, or files",
    );
    expect(prompt).toContain("Prefer a negative total line delta");
    expect(prompt).toContain(
      "A positive line result is not a simplification finding",
    );
    expect(prompt).toContain("Future reuse, aesthetic symmetry");
    expect(prompt).toContain(
      "Do not create a serial chain of new architecture findings",
    );
  });

  it("documents the same-session conversation contract", () => {
    const prompt = buildSystemPrompt();

    expect(prompt).toContain("exactly two normal turns");
    expect(prompt).toContain("investigate turn");
    expect(prompt).toContain("challenge-and-record turn");
  });
});
