// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf-8");
}

function readMarkdownTree(relativeDir: string): string {
  const absoluteDir = path.join(root, relativeDir);
  return fs
    .readdirSync(absoluteDir, { recursive: true })
    .filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".md"))
    .map((entry) => fs.readFileSync(path.join(absoluteDir, entry), "utf-8"))
    .join("\n");
}

describe("maintainer skills follow canonical workflow policy", () => {
  it("routes triage through the canonical policy package", () => {
    const skill = read(".agents/skills/nemoclaw-maintainer-triage/SKILL.md");

    expect(skill).toContain("../nemoclaw-maintainer-policies/references/triage-instructions.md");
    expect(skill).toContain("native Issue Type");
    expect(skill).toContain("Project Priority and Status");
    expect(skill).not.toMatch(
      /`(?:bug|documentation|question|priority: high|status: needs-info)`/u,
    );
    expect(
      fs.existsSync(
        path.join(
          root,
          ".agents/skills/nemoclaw-maintainer-triage/references/triage-instructions.md",
        ),
      ),
    ).toBe(false);
  });

  it("reads priority from Project 199 instead of a priority label", () => {
    const finder = read(".agents/skills/nemoclaw-maintainer-find-review-pr/SKILL.md");
    const triage = read(".agents/skills/nemoclaw-maintainer-day/scripts/triage.ts");

    expect(finder).toContain("gh project item-list 199");
    expect(finder).toContain('select(.priority == "Urgent" or .priority == "High")');
    expect(finder).not.toContain("priority: high");
    expect(triage).toContain('select(.field.name == "Priority")');
    expect(triage).toContain('item.projectPriority === "Urgent"');
    expect(triage).toContain('item.projectPriority === "High"');
    expect(triage.indexOf("const projectPriorities")).toBeLessThan(
      triage.indexOf("const candidates"),
    );
    expect(triage).not.toContain("priority: high");
  });

  it("describes the current morning-triage data sources", () => {
    const morning = read(".agents/skills/nemoclaw-maintainer-morning/SKILL.md");

    expect(morning).not.toContain("gh-pr-merge-now --json");
    expect(morning).toContain("fetches open PRs through `gh`");
    expect(morning).toContain("reads Project 199 Priority");
    expect(morning).toContain("review, CI, file, and risky-area data");
  });

  it("moves post-tag stragglers to the next patch version", () => {
    const evening = read(".agents/skills/nemoclaw-maintainer-evening/SKILL.md");
    const release = read(".agents/skills/nemoclaw-maintainer-cut-release-tag/SKILL.md");
    const morning = read(".agents/skills/nemoclaw-maintainer-morning/SKILL.md");
    const priorities = read(".agents/skills/nemoclaw-maintainer-day/PR-REVIEW-PRIORITIES.md");
    const policy = read(".agents/skills/nemoclaw-maintainer-policies/references/release-train.md");

    expect(evening).toContain("automatically bump stragglers to the next patch");
    expect(release).toContain("scripts/bump-stragglers.ts");
    expect(release).toContain("Do not run it before Step 4");
    expect(morning).toContain("post-tag housekeeping was interrupted");
    expect(priorities).toContain("automatically bump stragglers to the next patch");
    expect(policy).toContain("automatically move every open straggler to the next patch label");
    expect(
      fs.existsSync(
        path.join(root, ".agents/skills/nemoclaw-maintainer-day/scripts/bump-stragglers.ts"),
      ),
    ).toBe(true);
  });

  it("records every merged main PR against its ancestry-derived release target", () => {
    const policy = read(".agents/skills/nemoclaw-maintainer-policies/references/release-train.md");
    const projectWorkflow = read(
      ".agents/skills/nemoclaw-maintainer-policies/references/project-workflow.md",
    );
    const taxonomy = JSON.parse(
      read(".agents/skills/nemoclaw-maintainer-policies/references/label-taxonomy.json"),
    ) as {
      label_families: {
        release: { application_policy: string; positive_signals: string[] };
      };
      quality_rules: { post_merge_release_labeling_allowed: boolean };
    };

    expect(policy).toContain("After a PR merges to `main`");
    expect(policy).toContain("earliest containing release");
    expect(policy).toContain("completed releases tagged within the seven-day retention window");
    expect(policy).toContain("never removes an existing version label");
    expect(projectWorkflow).toContain("On open PRs");
    expect(projectWorkflow).toContain("After a PR merges to `main`");
    expect(projectWorkflow).toContain("historical release attribution");
    expect(taxonomy.label_families.release.positive_signals).toContain(
      "authorized post-merge assignment to a containing release or the next patch release",
    );
    expect(taxonomy.label_families.release.application_policy).toContain(
      "preserve existing version labels",
    );
    expect(taxonomy.quality_rules.post_merge_release_labeling_allowed).toBe(true);
  });

  it("requires E2E evidence for the release candidate commit or itemized maintainer exceptions", () => {
    const dailyFlow = read(".agents/skills/nemoclaw-maintainer-policies/references/daily-flow.md");
    const evening = read(".agents/skills/nemoclaw-maintainer-evening/SKILL.md");
    const priorities = read(".agents/skills/nemoclaw-maintainer-day/PR-REVIEW-PRIORITIES.md");
    const release = read(".agents/skills/nemoclaw-maintainer-cut-release-tag/SKILL.md");
    const policy = read(".agents/skills/nemoclaw-maintainer-policies/references/release-train.md");

    expect(policy).toContain("exact full `origin/main` commit SHA");
    expect(policy).toContain("`.github/workflows/e2e.yaml` is the sole source of truth");
    expect(policy).toContain("Do not maintain a separate release-gating test list");
    expect(policy).toContain("at least one completed, successful execution");
    expect(policy).toContain("multiple workflow runs, selective runs, reruns, and attempts");
    expect(policy).toContain("explicit selection and every expanded matrix execution");
    expect(policy).toContain("each expanded matrix execution as a separate ledger entry");
    expect(policy).toContain("matrix `id`");
    expect(policy).toContain("A later failure does not erase an earlier successful execution");
    expect(policy).toContain(
      "Skipped, unexecuted, queued, in-progress, cancelled, and failing results are not green evidence",
    );
    expect(policy).toContain("itemized maintainer exception");
    expect(policy).toContain("If the candidate SHA changes");
    expect(policy).toContain("discard the ledger and its exceptions");
    expect(release).toContain("the number of tests with green evidence");
    expect(release).toContain("successful run or job URL and attempt");
    const evidenceSummary = release.indexOf("Before showing the confirmation prompt");
    const confirmationPrompt = release.indexOf(
      "Ask the maintainer to paste the exact phrase",
      evidenceSummary,
    );
    expect(evidenceSummary).toBeGreaterThanOrEqual(0);
    expect(evidenceSummary).toBeLessThan(confirmationPrompt);
    expect(evening).toContain("every test has green evidence");
    expect(evening).toContain("explicit itemized maintainer exception");
    expect(evening).toContain("tag the confirmed release commit with `vX.Y.Z`");
    expect(evening).not.toContain("tag `main`");
    expect(dailyFlow).toContain("freeze the exact candidate SHA and review every E2E test");
    expect(priorities).toContain("collect the E2E evidence or itemized maintainer exceptions");
  });

  it("runs release-prep docs before generating the final release plan", () => {
    const updateDocs = read(".agents/skills/nemoclaw-contributor-update-docs/SKILL.md");
    const evening = read(".agents/skills/nemoclaw-maintainer-evening/SKILL.md");
    const release = read(".agents/skills/nemoclaw-maintainer-cut-release-tag/SKILL.md");
    const policy = read(".agents/skills/nemoclaw-maintainer-policies/references/release-train.md");

    expect(updateDocs).toContain("/nemoclaw-contributor-update-docs for vX.Y.Z");
    expect(evening.indexOf("/nemoclaw-contributor-update-docs for <version>")).toBeLessThan(
      evening.indexOf("Load `cut-release-tag`"),
    );
    expect(release).toContain(
      "Do not generate the release plan until release-prep docs are merged or explicitly waived.",
    );
    expect(policy).toContain("Run `/nemoclaw-contributor-update-docs for vX.Y.Z`");
    expect(policy).toContain("If any merge lands after `release:plan`, generate a fresh plan");
  });

  it("keeps cross-issue sweeping separate from comparator scoring", () => {
    const sweep = read(".agents/skills/nemoclaw-maintainer-cross-issue-sweep/SKILL.md");
    const comparator = read(".agents/skills/nemoclaw-maintainer-pr-comparator/SKILL.md");

    expect(sweep).toContain("The comparator does not call it");
    expect(comparator).toContain("Cross-issue regression sweep (separate skill)");
  });

  it("uses native bug type and approved Project writes for stale verification", () => {
    const stale = readMarkdownTree(".agents/skills/nemoclaw-maintainer-verify-stale");

    expect(stale).toContain('select(.issueType.name == "Bug")');
    expect(stale).toContain("Verdict names are comment and log vocabulary, not GitHub labels");
    expect(stale).toContain("Project Status `Won't Fix`");
    expect(stale).not.toMatch(/gh issue edit[^\n]*--add-label/u);
    expect(stale).not.toContain("--label bug");
  });

  it("makes DCO and GitHub verification explicit approval gates", () => {
    const mergeGate = read(".agents/skills/nemoclaw-maintainer-day/MERGE-GATE.md");
    const comparator = read(
      ".agents/skills/nemoclaw-maintainer-pr-comparator/scripts/collect-gates.sh",
    );

    expect(mergeGate).toContain("every PR commit appears as `Verified` in GitHub");
    expect(comparator).toContain("gate_contributor_compliance");
    expect(comparator).toContain(".commit.verification.verified");
  });

  it("gives distinct remediation for PR-body and commit-verification failures", () => {
    const verdict = read(".agents/skills/nemoclaw-maintainer-pr-comparator/templates/verdict.md");

    expect(verdict).toContain("Missing PR-body DCO declaration: update the PR body");
    expect(verdict).toContain(
      "Missing GitHub Verified commit history: replace the branch with compliant history",
    );
    expect(verdict).not.toContain(
      "PR-body DCO declaration or GitHub Verified commit history is missing",
    );
  });
});
