// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildHandoffSummary,
  renderHandoffMarkdown,
} from "../.agents/skills/nemoclaw-maintainer-day/scripts/handoff-summary.ts";

const skills = path.join(process.cwd(), ".agents", "skills");
const read = (...parts: string[]) => fs.readFileSync(path.join(skills, ...parts), "utf8");
const tagSkill = read("nemoclaw-maintainer-cut-release-tag", "SKILL.md");
const eveningSkill = read("nemoclaw-maintainer-evening", "SKILL.md");
const releaseNotesSkill = read("nemoclaw-maintainer-release-notes", "SKILL.md");
const releasePolicy = read("nemoclaw-maintainer-policies", "references", "release-train.md");
const candidateEvidence = read(
  "nemoclaw-maintainer-cut-release-tag",
  "references",
  "candidate-evidence.md",
);

describe("release tag maintainer guidance", () => {
  it("keeps candidate documentation and image evidence mandatory (#9234)", () => {
    expect(tagSkill).toContain("approved-empty Pi documentation result");
    expect(tagSkill).toMatch(/cannot\s+be waived/u);
    expect(candidateEvidence).toContain("Publish documentation catch-up");
    expect(tagSkill).toContain("candidate-specific");
    expect(candidateEvidence).toContain('base: successful_check("base-image-publication")');
    expect(candidateEvidence).toContain("Trust the aggregate instead of");
    expect(candidateEvidence).toContain("launchable-e2e.json");
    expect(candidateEvidence).toContain("cleanup.json");
    expect(candidateEvidence).toContain("Exact staging Brev Launchable");
    expect(candidateEvidence).toMatch(
      /the rest of the general E2E suite remains maintainer\s+context/u,
    );
    expect(releasePolicy).toMatch(/approved\s+empty Pi patch/);
    expect(releasePolicy).toContain("A managed PR or branch for a later");
    expect(releasePolicy).toContain("Neither result can be waived by the general E2E decision");
  });

  it("puts the general E2E decision in the maintainer's hands (#9234)", () => {
    expect(tagSkill).toContain("status and conclusion");
    expect(tagSkill).toContain("last-updated timestamps, plus age at inspection");
    expect(tagSkill).toContain("workflow URL and `Release qualification` job URL");
    expect(tagSkill).toContain("Run focused tests selected by the maintainer");
    expect(tagSkill).toContain("Run the full suite");
    expect(tagSkill).toContain("Proceed with the status as shown");
    expect(tagSkill).toContain("is the decision, not the reason");
    expect(tagSkill).toMatch(/requested\s+run remains unresolved while it is queued or running/);
    expect(tagSkill).toContain("successful result covers the same requested scope");
    expect(releasePolicy).toMatch(
      /requested run remains unresolved while it is queued or\s+running/,
    );
    expect(tagSkill).toContain("Exceptions: None");
    expect(releasePolicy).toContain("General E2E informs the maintainer");
    expect(releasePolicy).not.toContain("release_qualification_waived_jobs");
  });

  it("uses one signed Markdown record and stops after tag readback (#9234)", () => {
    expect(tagSkill).toContain("release:plan -- --version vX.Y.Z");
    expect(tagSkill).toContain("release-brief.md");
    expect(tagSkill).toContain("plan is immutable once written");
    expect(tagSkill).toContain("--plan ../nemoclaw-release-vX.Y.Z/plan.json");
    expect(tagSkill).toContain("--message-file");
    expect(tagSkill).toContain("signed tag annotation");
    expect(tagSkill).toContain("Return immediately");
    expect(tagSkill).toContain("it can fail after the tag is cut and can be");
    expect(tagSkill).toMatch(/a\s+new dispatch cannot test the older candidate/u);
    expect(tagSkill).not.toContain("release:wait-latest");
    expect(tagSkill).not.toContain("release:notes-data");
    expect(tagSkill).not.toContain("--bump");
    expect(tagSkill).not.toContain("--format markdown");
    const briefTemplate = tagSkill.indexOf("Create the brief template now");
    const candidateEvidenceStep = tagSkill.indexOf("### 2. Verify Required Candidate Evidence");
    expect(briefTemplate).toBeGreaterThan(-1);
    expect(candidateEvidenceStep).toBeGreaterThan(briefTemplate);
    expect(eveningSkill).toContain("Do not run a full E2E suite automatically");
    expect(eveningSkill).toContain("return immediately");
    expect(releaseNotesSkill).toContain("Do not wait for `latest`");
    expect(releaseNotesSkill).toContain("signed tag annotation");
    expect(releaseNotesSkill).not.toContain("notes-data.json");
    const confirmation = tagSkill.indexOf("After receiving that exact phrase");
    const finalRecheck = tagSkill.indexOf("Final Documentation Recheck", confirmation);
    const cutter = tagSkill.indexOf("Then run:", confirmation);
    expect(confirmation).toBeGreaterThan(-1);
    expect(finalRecheck).toBeGreaterThan(confirmation);
    expect(cutter).toBeGreaterThan(confirmation);
    expect(cutter).toBeGreaterThan(finalRecheck);
    expect(tagSkill).not.toContain("Before showing the final brief");
    expect(tagSkill).toContain("does not depend on the Step 2 shell");
  });

  it("keeps an older planned candidate when its own evidence remains valid (#9234)", () => {
    expect(tagSkill).toContain("candidate is still an ancestor of `origin/main`");
    expect(tagSkill).toContain("New commits on `main` do not invalidate that plan");
    expect(candidateEvidence).toContain("A PR or branch for a later candidate");
    expect(eveningSkill).toContain("later managed documentation work");
    expect(releasePolicy).toContain("Keep the planned candidate");
  });

  it("generates the plan before exact-candidate documentation checks (#9234)", () => {
    const plan = releasePolicy.indexOf("Generate the immutable release plan");
    const evidence = releasePolicy.indexOf("Verify the candidate's required documentation");
    expect(releasePolicy).toContain("In the normal evening flow, merge it before");
    expect(releasePolicy).toContain("If direct use of the release-tag");
    expect(plan).toBeGreaterThan(-1);
    expect(evidence).toBeGreaterThan(plan);
    expect(releasePolicy).toMatch(/merge that PR,\s+generate a new plan,\s+and repeat/u);
  });
});

describe("release handoff summary", () => {
  it("uses exact range boundaries and renders Markdown QA context (#9234)", () => {
    const previous = "1".repeat(40);
    const candidate = "2".repeat(40);
    const operationResults = new Map([
      [`rev-parse ${candidate}^{commit}`, candidate],
      [`merge-base ${previous} ${candidate}`, previous],
      [`rev-list --count ${previous}..${candidate}`, "2"],
      [
        `diff --name-only ${previous}..${candidate}`,
        ".github/workflows/e2e.yaml\nsrc/lib/onboard/machine/runner.ts\ndocs/changelog/2026-08-17.mdx",
      ],
    ]);
    const command = (_command: string, args: string[]): string => {
      const operation = args.join(" ");
      return (
        operationResults.get(operation) ??
        (() => {
          throw new Error(`Unexpected command: ${operation}`);
        })()
      );
    };

    const summary = buildHandoffSummary(
      {
        previousTag: "v1.2.2",
        previousTagCommit: previous,
        targetVersion: "v1.2.3",
        candidateCommit: candidate,
      },
      command,
    );
    const markdown = renderHandoffMarkdown(summary);

    expect(summary.commitCount).toBe(2);
    expect(summary.riskyFileCount).toBe(2);
    expect(summary.riskyAreas).toContain("Workflow / enforcement");
    expect(summary.riskyAreas).toContain("Onboarding / host glue");
    expect(summary.suggestedTestFocus).toContain(
      "CI checks, pre-commit hooks, and DCO declarations",
    );
    expect(markdown).toContain("# NemoClaw v1.2.3 release brief");
    expect(markdown).toContain(`Previous release: \`v1.2.2\` at \`${previous}\``);
    expect(markdown).toContain(`Candidate: \`${candidate}\``);
    expect(markdown).toContain("Risky files detected: 2");
    expect(markdown).toContain("## Pi documentation evidence");
    expect(markdown).toContain("## Exact staging Brev Launchable evidence");
    expect(markdown).toContain(`- Launchable candidate: \`${candidate}\``);
    expect(markdown).toContain(
      "workflow and job URLs, artifact name, normalized approved-empty review",
    );
    expect(markdown).toContain("- Entry:\n\nTODO_RELEASE_BRIEF");
    expect(markdown).toContain("Exceptions: TODO_RELEASE_BRIEF");
    expect(markdown.match(/TODO_RELEASE_BRIEF/g)).toHaveLength(7);
    expect(markdown).not.toContain("feat: ship the release");
    expect(markdown).not.toContain("`.github/workflows/e2e.yaml`");
  });
});
