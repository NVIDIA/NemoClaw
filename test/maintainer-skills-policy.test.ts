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
