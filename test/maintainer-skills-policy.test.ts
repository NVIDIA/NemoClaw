// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

  it("keeps N1X routing canonical across maintainer policy sources (#8095)", () => {
    const taxonomy = JSON.parse(
      read(".agents/skills/nemoclaw-maintainer-policies/references/label-taxonomy.json"),
    ) as {
      label_families: {
        platform: {
          entries: Array<{
            description: string;
            name: string;
            negative_signals: string[];
            positive_signals: string[];
          }>;
          values: string[];
        };
      };
    };
    const markdown = read(
      ".agents/skills/nemoclaw-maintainer-policies/references/label-taxonomy.md",
    );
    const instructions = read(
      ".agents/skills/nemoclaw-maintainer-policies/references/triage-instructions.md",
    );
    const examples = read(".agents/skills/nemoclaw-maintainer-policies/references/examples.md");
    const staleCandidateSelection = read(
      ".agents/skills/nemoclaw-maintainer-verify-stale/reference/candidate-selection.md",
    );
    const n1xExample = examples.match(
      /### N1X Linux Install Failure[\s\S]*?(?=\n### |\n## |$)/,
    )?.[0];
    const n1x = taxonomy.label_families.platform.entries.find(
      (entry) => entry.name === "platform: n1x",
    );

    expect(taxonomy.label_families.platform.values).toContain("platform: n1x");
    expect(n1x).toEqual(
      expect.objectContaining({
        name: "platform: n1x",
        description: "Affects N1X hardware or workflows.",
        positive_signals: expect.arrayContaining(["N1x Linux Laptop", "NVIDIA RTX Spark N1X"]),
        negative_signals: expect.arrayContaining([
          "ARM64 issue without N1X evidence",
          "NVIDIA hardware mentioned without N1X relevance",
        ]),
      }),
    );
    expect(markdown).toContain("| `platform: n1x` | Affects N1X hardware or workflows. |");
    expect(instructions).toContain(
      "Map N1X, N1x Linux Laptop, and NVIDIA RTX Spark N1X evidence to `platform: n1x`",
    );
    expect(n1xExample).toContain('"labels_to_add": ["area: install", "platform: n1x"]');
    expect(n1xExample).not.toContain('"platform: ubuntu"');
    expect(n1xExample).not.toContain('"platform: arm64"');
    expect(staleCandidateSelection).toContain(
      "`platform: jetson`, and `platform: n1x`. Brev has no equivalent hardware",
    );
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

    expect(evening).toContain("move to the next patch label");
    expect(evening).toContain("released-label retirement state");
    expect(release).toContain("release-latest-tag");
    expect(release).toContain("signed annotated tag object");
    expect(release).toContain("verifies the exact signed annotated tag object through GitHub");
    expect(release).toContain("--preflight-only");
    expect(release).toContain("dedicated SSH private signing key");
    expect(release).toContain("Do not retag, move `latest`, retire labels directly");
    expect(release).toContain("directly calls `release-latest-tag.yaml`");
    expect(morning).toContain("post-tag housekeeping was interrupted");
    expect(priorities).toContain("move its label to the next patch");
    expect(priorities).toContain("Delete the released label");
    expect(policy).toContain("moves every open straggler");
    expect(policy).toContain("deletes the released label");
    expect(policy).toContain("Never rename, recreate, or reuse them");
    expect(policy).toContain("shared release-label queue");
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

    expect(policy).toContain("trusted post-merge workflow labels untagged merges");
    expect(policy).toContain("Tags and commit ancestry are the durable");
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

  it("freezes the 4 PM candidate and keeps E2E advisory through the 4 AM cut", () => {
    const dailyFlow = read(".agents/skills/nemoclaw-maintainer-policies/references/daily-flow.md");
    const evening = read(".agents/skills/nemoclaw-maintainer-evening/SKILL.md");
    const priorities = read(".agents/skills/nemoclaw-maintainer-day/PR-REVIEW-PRIORITIES.md");
    const release = read(".agents/skills/nemoclaw-maintainer-cut-release-tag/SKILL.md");
    const policy = read(".agents/skills/nemoclaw-maintainer-policies/references/release-train.md");

    expect(policy).toContain("8:00 AM–4:00 PM");
    expect(policy).toContain("latest `post-merge-agent-review.yaml` push run");
    expect(policy).toContain("A merge after the cutoff belongs to the next edition");
    expect(policy).toContain("Tag the frozen candidate regardless of E2E state");
    expect(policy).toContain("Do not create an E2E waiver ledger");
    expect(policy).toContain("E2E never enters the tag authorization");
    expect(release).toContain("Never regenerate or advance the frozen candidate");
    expect(release).toContain("E2E is advisory");
    expect(release).toContain("Do not merge during the freeze");
    expect(evening).toContain("Do not merge fixes during the freeze");
    expect(evening).toContain("E2E does not authorize or block the 4:00 AM tag");
    expect(dailyFlow).toContain("tag the frozen candidate at 4 AM regardless of its state");
    expect(priorities).toContain("Tag the frozen candidate regardless of E2E state");
  });

  it("keeps full-mode E2E receipts available for advisory overnight diagnosis (#7487)", () => {
    const e2e = read(".agents/skills/nemoclaw-maintainer-e2e/SKILL.md");
    const evening = read(".agents/skills/nemoclaw-maintainer-evening/SKILL.md");
    const release = read(".agents/skills/nemoclaw-maintainer-cut-release-tag/SKILL.md");
    const policy = read(".agents/skills/nemoclaw-maintainer-policies/references/release-train.md");
    const skillsGuide = read(".agents/skills/nemoclaw-skills-guide/SKILL.md");

    expect(e2e).toContain("include_staging_brev_launchable=true");
    expect(e2e).toContain("Exact staging Brev Launchable");
    expect(e2e).toContain("launchable-e2e.json");
    expect(e2e).toContain("cleanup.json");
    expect(e2e).toContain("dispatch.json");
    expect(e2e).toContain("Bind every result to the tested SHA");
    expect(e2e).not.toContain("Release Coverage Dispatch Group");
    expect(e2e).not.toContain("manifest inputs");
    expect(release).toContain("Load `nemoclaw-maintainer-e2e`");
    expect(release).toContain("Classify failures");
    expect(release).toContain("Never inspect E2E state to authorize");
    expect(evening).toContain("Load `nemoclaw-maintainer-e2e`");
    expect(policy).toContain("consolidated results");
    expect(policy).toContain("selective reruns");
    expect(policy).toContain("Do not fail, wait, or branch on E2E state");
    expect(skillsGuide).toContain("`nemoclaw-maintainer-e2e`");
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
    expect(updateDocs).toContain("current documentation contributor guide");
    expect(updateDocs).toContain("current repository policy");
    expect(updateDocs).toContain("../nemoclaw-maintainer-policies/references/release-train.md");
    expect(updateDocs).not.toContain("parser-safe MDX SPDX comment");
    expect(updateDocs).not.toContain("scan `<previous-tag>..origin/main`");
    expect(updateDocs).toContain("planned release date");
    expect(updateDocs).toContain("Stop before PR creation");
    expect(createPr).toContain('--label "area: docs"');
    expect(createPr).not.toContain('--label "documentation"');
    expect(evening).toContain("Run `/nemoclaw-contributor-update-docs for <version>` early enough");
    expect(evening).toContain("exact `## <version>` heading");
    expect(release).toContain("git grep -n -E '^## vX\\.Y\\.Z$'");
    expect(release).toContain("No changelog waiver exists");
    expect(releaseNotes).toContain("does not replace or create that canonical entry");
    expect(policy).toContain("Run `/nemoclaw-contributor-update-docs for vX.Y.Z`");
    expect(policy).toContain("Run `/nemoclaw-contributor-update-docs for vX.Y.Z`");
    expect(policy).toContain("No changelog waiver exists");
    expect(priorities).toContain("require the dated changelog entry");
    expect(skillsGuide).toContain(
      "update their owning documentation under current repository policy",
    );
    expect(agents).toContain("a PR that updates ordinary pages without the dated changelog entry");
    expect(docsAgents).toContain("Every pre-tag release-note docs PR must create or update");
    expect(docsContributing).toContain("Create the planned release entry in the pre-tag");
    expect(policy).toContain("A merge after the cutoff belongs to the next edition");
    expect(releaseNotes).toContain(
      "Keep candidate internals, agent-review diagnostics, E2E classifications, rerun details, and failure rationale out of the public Announcement",
    );
    expect(releaseNotes).toContain(
      "Never include candidate internals, agent-review diagnostics, internal E2E classifications, rerun details, or failure rationale in the public Announcement",
    );
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

  it("requires replacement PRs to preserve transferred contributor attribution", () => {
    const policy = read(
      ".agents/skills/nemoclaw-maintainer-policies/references/workflow-policy.md",
    );
    const comparator = read(".agents/skills/nemoclaw-maintainer-pr-comparator/SKILL.md");
    const tiebreakers = read(".agents/skills/nemoclaw-maintainer-pr-comparator/tiebreakers.md");
    const verdict = read(".agents/skills/nemoclaw-maintainer-pr-comparator/templates/verdict.md");
    const finder = read(".agents/skills/nemoclaw-maintainer-find-review-pr/SKILL.md");
    const parser = read(
      ".agents/skills/nemoclaw-maintainer-pr-comparator/scripts/parse-supersession.sh",
    );

    expect(policy).toContain("Supersedes #<number>");
    expect(policy).toContain("Preserve the source contributor as the Git author");
    expect(policy).toContain("Co-authored-by: Name <email>");
    expect(policy).toContain("Use the exact author name and email from the source commit");
    expect(policy).toContain("Never guess or substitute an attribution identity");
    expect(policy).toContain("Never add or copy a DCO declaration");
    expect(policy).toContain("leave the winner unset and ask the contributor");
    const sourceDcoPolicyIndex = policy.indexOf("Confirm that the source PR already contains");
    const transferPolicyIndex = policy.indexOf("After both checks pass");
    expect(sourceDcoPolicyIndex).toBeGreaterThanOrEqual(0);
    expect(transferPolicyIndex).toBeGreaterThan(sourceDcoPolicyIndex);
    expect(policy).toContain("does not require co-authorship");
    expect(policy).toContain("does not replace attribution in the merged PR history");

    expect(comparator).toContain("../nemoclaw-maintainer-policies/references/workflow-policy.md");
    expect(comparator).toContain("They do not rank a candidate");
    expect(comparator).toContain("`transferred`");
    expect(comparator).toContain("`unclear`");
    expect(comparator).toContain("leave `winner` null");
    expect(finder).toContain("../nemoclaw-maintainer-pr-comparator/scripts/parse-supersession.sh");
    for (const pattern of [
      "supersed[a-z]*",
      "replac[a-z]*",
      "clos[a-z]* in favor of",
      "fold[a-z]* in",
    ]) {
      expect(parser).toContain(pattern);
      expect(comparator).toContain(pattern);
      expect(finder).toContain(pattern);
    }
    for (const example of [
      "superseded by #N",
      "replaced by #N",
      "closed in favor of #N",
      "folded into #N",
    ]) {
      expect(comparator).toContain(example);
      expect(finder).toContain(example);
    }
    expect(comparator).toContain("A `follow-up to #N` statement is a related-PR signal");
    expect(finder).toContain("A `follow-up to #N` statement is a related-PR signal");

    expect(tiebreakers).toContain("it does not rank a candidate");
    expect(tiebreakers).not.toContain("**Supersession.**");
    expect(tiebreakers).toContain("rerun the comparator before selecting a winner");

    expect(verdict).toContain("git cherry-pick -S -x <source-sha>");
    expect(verdict).toContain("Co-authored-by: Name <email>");
    expect(verdict).toContain("using the verified source-commit identity");
    expect(verdict).toContain("run the comparator again on the updated SHA");
    expect(verdict).toContain("contains the contributor's `Signed-off-by:` declaration");
    expect(verdict).toContain("Do not add or copy that declaration");
    expect(verdict).toContain("Keep the replacement author's own DCO declaration");
    expect(verdict).toContain("every replacement commit appears as `Verified` in GitHub");

    const sourceDcoIndex = verdict.indexOf("Confirm that PR #B contains the contributor's");
    const identityIndex = verdict.indexOf(
      "Read the exact author name and email from the source commit",
    );
    const transferIndex = verdict.indexOf("Transfer the test from PR #B before merge");
    const rerunIndex = verdict.indexOf("run the comparator again on the updated SHA");
    const mergeIndex = verdict.indexOf("Merge PR #A only if the new verdict selects it");
    const closeIndex = verdict.indexOf("After PR #A merges, close PR #B");

    expect(sourceDcoIndex).toBeGreaterThanOrEqual(0);
    expect(identityIndex).toBeGreaterThanOrEqual(0);
    expect(transferIndex).toBeGreaterThan(sourceDcoIndex);
    expect(transferIndex).toBeGreaterThan(identityIndex);
    expect(rerunIndex).toBeGreaterThan(transferIndex);
    expect(mergeIndex).toBeGreaterThan(rerunIndex);
    expect(closeIndex).toBeGreaterThan(mergeIndex);

    expect(finder).toContain("../nemoclaw-maintainer-policies/references/workflow-policy.md");
    expect(finder).toContain("This skill reports recommendations only");
    expect(finder).toContain(
      "Do not recommend closing the source PR until another authorized workflow",
    );
    expect(finder).toContain("merged the selected target");
    expect(finder).toContain("After the updated verdict selects #1416 and #1416 merges");
  });

  it("orients active and passive supersession statements", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "parse-supersession-"));
    const bin = path.join(tmp, "bin");
    const mockGh = path.join(bin, "gh");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      mockGh,
      [
        "#!/usr/bin/env bash",
        'case "$3" in',
        '  100) printf "%s" "${PR_BODY_100:-}" ;;',
        '  200) printf "%s" "${PR_BODY_200:-}" ;;',
        "esac",
      ].join("\n"),
    );
    fs.chmodSync(mockGh, 0o755);

    const parser = path.join(
      root,
      ".agents/skills/nemoclaw-maintainer-pr-comparator/scripts/parse-supersession.sh",
    );
    const scenarios = [
      { statement: "Supersedes #200", superseder: 100, superseded: 200 },
      { statement: "Superseded by #200", superseder: 200, superseded: 100 },
      { statement: "Replaces #200", superseder: 100, superseded: 200 },
      { statement: "Replaced by #200", superseder: 200, superseded: 100 },
      { statement: "Closes in favor of #200", superseder: 200, superseded: 100 },
      { statement: "Closed in favor of #200", superseder: 200, superseded: 100 },
      { statement: "Folds in #200", superseder: 100, superseded: 200 },
      { statement: "Folded into #200", superseder: 200, superseded: 100 },
      {
        statement: "Supersedes #200\nReplaces #200",
        superseder: 100,
        superseded: 200,
      },
    ];

    try {
      for (const scenario of scenarios) {
        const result = spawnSync("bash", [parser, "100", "200"], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            PR_BODY_100: scenario.statement,
            PR_BODY_200: "",
          },
        });

        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          edges: [
            {
              superseder: scenario.superseder,
              superseded: scenario.superseded,
            },
          ],
        });
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
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
    expect(mergeGate).toContain(
      "The first attempt requires the triggering actor to have current `maintain` or `admin` access.",
    );
    expect(mergeGate).toContain(
      "Immediately before dispatch, it confirms that the PR SHA, base SHA, head repository, and required-check identity still match.",
    );
    expect(mergeGate).toContain("Approval cannot record success by itself.");
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
