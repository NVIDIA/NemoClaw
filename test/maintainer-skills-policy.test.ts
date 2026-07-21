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

  it("moves post-tag stragglers and retires the released label", () => {
    const evening = read(".agents/skills/nemoclaw-maintainer-evening/SKILL.md");
    const release = read(".agents/skills/nemoclaw-maintainer-cut-release-tag/SKILL.md");
    const morning = read(".agents/skills/nemoclaw-maintainer-morning/SKILL.md");
    const priorities = read(".agents/skills/nemoclaw-maintainer-day/PR-REVIEW-PRIORITIES.md");
    const policy = read(".agents/skills/nemoclaw-maintainer-policies/references/release-train.md");

    expect(evening).toContain("automatically carry stragglers to the next patch");
    expect(evening).toContain("retire the released label");
    expect(release).toContain("release-latest-tag");
    expect(release).toContain("signed annotated semver tag");
    expect(release).toContain("GitHub-Verified");
    expect(release).toContain("same tag object");
    expect(release).toContain("Do not run the retirement script directly");
    expect(release).toContain('--event push --commit "$RELEASE_SHA"');
    expect(release).toContain("Expected exactly one release-latest-tag push run");
    expect(morning).toContain("post-tag housekeeping was interrupted");
    expect(priorities).toContain("Move open items to the next patch label");
    expect(priorities).toContain("delete the released label");
    expect(policy).toContain("automatically move every open straggler to the next patch label");
    expect(policy).toContain("delete the released version label");
    expect(policy).toContain("never renamed or reused");
    expect(policy).toContain("shared release-label coordination queue");
    expect(fs.existsSync(path.join(root, "scripts/retire-release-label.mts"))).toBe(true);
  });

  it("keeps release labels temporary and limits post-merge assignment to untagged work", () => {
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
      quality_rules: { post_merge_untagged_release_labeling_allowed: boolean };
    };

    expect(policy).toContain("After a PR merges to `main`");
    expect(policy).toContain("ahead of the latest release tag");
    expect(policy).toContain("only across the untagged interval");
    expect(policy).toContain("Tags and commit ancestry are the only durable");
    expect(policy).not.toContain("earliest containing release");
    expect(policy).not.toContain("seven-day retention window");
    expect(projectWorkflow).toContain("On open PRs");
    expect(projectWorkflow).toContain("After a PR merges to `main`");
    expect(projectWorkflow).toContain("tag comparison range owns durable release membership");
    expect(taxonomy.label_families.release.positive_signals).toContain(
      "authorized post-merge assignment to the next untagged patch release",
    );
    expect(taxonomy.label_families.release.application_policy).toContain(
      "carry open items forward and delete the released label",
    );
    expect(taxonomy.quality_rules.post_merge_untagged_release_labeling_allowed).toBe(true);
  });

  it("requires E2E evidence for the release candidate commit or itemized maintainer exceptions", () => {
    const dailyFlow = read(".agents/skills/nemoclaw-maintainer-policies/references/daily-flow.md");
    const evening = read(".agents/skills/nemoclaw-maintainer-evening/SKILL.md");
    const priorities = read(".agents/skills/nemoclaw-maintainer-day/PR-REVIEW-PRIORITIES.md");
    const release = read(".agents/skills/nemoclaw-maintainer-cut-release-tag/SKILL.md");
    const policy = read(".agents/skills/nemoclaw-maintainer-policies/references/release-train.md");

    expect(policy).toContain("full `origin/main` commit SHA");
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
      "Ask the maintainer to paste this phrase",
      evidenceSummary,
    );
    expect(evidenceSummary).toBeGreaterThanOrEqual(0);
    expect(evidenceSummary).toBeLessThan(confirmationPrompt);
    expect(evening).toContain("every test has green evidence");
    expect(evening).toContain("explicit itemized maintainer exception");
    expect(evening).toContain("tag the confirmed release commit with `vX.Y.Z`");
    expect(evening).not.toContain("tag `main`");
    expect(dailyFlow).toContain("freeze the candidate SHA and review every E2E test");
    expect(priorities).toContain("Record the release SHA and required E2E evidence");
  });

  it("runs release-prep docs before generating the final release plan", () => {
    const updateDocs = read(".agents/skills/nemoclaw-contributor-update-docs/SKILL.md");
    const createPr = read(".agents/skills/nemoclaw-contributor-create-pr/SKILL.md");
    const evening = read(".agents/skills/nemoclaw-maintainer-evening/SKILL.md");
    const release = read(".agents/skills/nemoclaw-maintainer-cut-release-tag/SKILL.md");
    const releaseNotes = read(".agents/skills/nemoclaw-maintainer-release-notes/SKILL.md");
    const policy = read(".agents/skills/nemoclaw-maintainer-policies/references/release-train.md");
    const priorities = read(".agents/skills/nemoclaw-maintainer-day/PR-REVIEW-PRIORITIES.md");
    const skillsGuide = read(".agents/skills/nemoclaw-skills-guide/SKILL.md");
    const agents = read("AGENTS.md");
    const docsAgents = read("docs/AGENTS.md");
    const docsContributing = read("docs/CONTRIBUTING.md");

    expect(updateDocs).toContain("/nemoclaw-contributor-update-docs for vX.Y.Z");
    expect(updateDocs).toContain("Every pre-tag release-note docs PR must add");
    expect(updateDocs).toContain("docs/changelog/YYYY-MM-DD.mdx");
    expect(updateDocs).toContain("parser-safe MDX SPDX comment");
    expect(updateDocs).toContain("scan `<previous-tag>..origin/main`");
    expect(updateDocs).toContain("planned release date");
    expect(updateDocs).toContain("stop before PR creation");
    expect(createPr).toContain('--label "area: docs"');
    expect(createPr).not.toContain('--label "documentation"');
    expect(evening.indexOf("/nemoclaw-contributor-update-docs for <version>")).toBeLessThan(
      evening.indexOf("Load `cut-release-tag`"),
    );
    expect(evening).toContain("contains the exact `## <version>` heading");
    expect(release).toContain("git grep -n '^## vX\\.Y\\.Z$'");
    expect(release).toContain("Unless Step 1 records an explicit waiver");
    expect(release).toContain("show the recorded waiver reason");
    expect(release).toContain("A conventional Release Notes page or post-tag Announcement draft");
    expect(releaseNotes).toContain("does not replace or create that canonical entry");
    expect(policy).toContain("Run `/nemoclaw-contributor-update-docs for vX.Y.Z`");
    expect(policy).toContain("The pre-tag release-note docs PR must create or update");
    expect(priorities).toContain("the pre-tag changelog PR contains");
    expect(skillsGuide).toContain("create the canonical `docs/changelog/YYYY-MM-DD.mdx` entry");
    expect(agents).toContain("a PR that updates ordinary pages without the dated changelog entry");
    expect(docsAgents).toContain("Every pre-tag release-note docs PR must create or update");
    expect(docsContributing).toContain("Create the planned release entry in the pre-tag");
    expect(policy).toContain("If any merge lands after `release:plan`, generate a fresh plan");
  });

  it("keeps cross-issue sweeping separate from comparator scoring", () => {
    const sweep = read(".agents/skills/nemoclaw-maintainer-cross-issue-sweep/SKILL.md");
    const comparator = read(".agents/skills/nemoclaw-maintainer-pr-comparator/SKILL.md");

    expect(sweep).toContain("The comparator does not run this skill or use its findings");
    expect(comparator).toContain("Run `nemoclaw-maintainer-cross-issue-sweep` separately");
  });

  it("uses the merge gate's unresolved-issue threshold for ready-now PRs", () => {
    const day = read(".agents/skills/nemoclaw-maintainer-day/SKILL.md");
    const mergeGate = read(".agents/skills/nemoclaw-maintainer-day/MERGE-GATE.md");
    const threshold = "no unresolved correctness or security issue";

    expect(day).toContain(threshold);
    expect(mergeGate).toContain(threshold);
    expect(day).not.toContain("no confirmed major CodeRabbit or PR Review Advisor issues");
    expect(mergeGate).not.toContain("no confirmed major CodeRabbit or PR Review Advisor issues");
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

    expect(mergeGate).toContain("Require every commit to appear as `Verified` in GitHub");
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

  it("keeps PR workflow writes behind their safety checks", () => {
    const createPr = read(".agents/skills/nemoclaw-contributor-create-pr/SKILL.md");
    const judgment = read(
      ".agents/skills/nemoclaw-maintainer-cross-issue-sweep/checks/relationship-judgment.md",
    );
    const mergeGate = read(".agents/skills/nemoclaw-maintainer-day/MERGE-GATE.md");
    const salvage = read(".agents/skills/nemoclaw-maintainer-day/SALVAGE-PR.md");

    expect(createPr).toContain("For work that is not ready for review, complete Step 4");
    expect(createPr).toContain("--body-file /tmp/nemoclaw-pr-body.md");
    expect(createPr).not.toContain('--body "..."');
    expect(judgment).toContain("{candidate_comments}");
    expect(
      mergeGate.match(
        /the PR is open and that the PR SHA, base SHA, and coordination identity still match/gu,
      ),
    ).toHaveLength(2);
    expect(salvage).toContain("`headRepository.nameWithOwner` is `NVIDIA/NemoClaw`");
    expect(salvage).toContain("git push origin <local-branch>:<headRefName>");
    expect(salvage).toContain("If `maintainerCanModify` is false, do not push");
  });

  it("keeps maintainer ordering, state, and write authorization explicit", () => {
    const sequence = read(".agents/skills/nemoclaw-maintainer-day/SEQUENCE-WORK.md");
    const state = read(".agents/skills/nemoclaw-maintainer-day/STATE-SCHEMA.md");
    const instructions = read(
      ".agents/skills/nemoclaw-maintainer-policies/references/triage-instructions.md",
    );
    const triage = read(".agents/skills/nemoclaw-maintainer-triage/SKILL.md");

    expect(sequence).toContain("An identified security concern overrides this default order");
    expect(state).toContain("Keep at most 50 entries");
    expect(instructions).toContain(
      "keep `labels_to_add` and `labels_to_remove` as dry-run output and do not change labels",
    );
    expect(instructions).toContain(
      "An authorized agent-owned workflow may add or remove only `agt: *` labels",
    );
    expect(triage).toContain("Before each write, re-read Issue Type, Project fields, and labels");
    expect(triage).toContain("present an updated proposal for acceptance");
  });

  it("resolves security-review issue inputs to one verified PR", () => {
    const securityReview = read(".agents/skills/nemoclaw-maintainer-security-code-review/SKILL.md");

    expect(securityReview).toContain("--json closedByPullRequestsReferences");
    expect(securityReview).toContain("Continue only when this returns one PR number");
    expect(securityReview).toContain("Use the verified PR number in each later command");
    expect(securityReview).toContain("If no changed or reviewable security surface exists");
    expect(securityReview).toContain(
      "Dockerfiles, workflows, network policies, blueprints, dependencies, and security configuration",
    );
  });
});
