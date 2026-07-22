// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { REQUIRED_CHECK_NAMES, runComparatorGate, runGate } from "./check-gates-test-fixtures.ts";

describe("maintainer merge-gate contributor compliance", () => {
  it("passes when the PR body has DCO and every commit is GitHub Verified", () => {
    const result = runGate({
      body: "## Summary\n\nPolicy alignment.\n\nSigned-off-by: Example User <user@example.com>",
      verified: true,
    });

    const output = JSON.parse(result.stdout);
    expect(output.gates.contributorCompliance).toMatchObject({
      pass: true,
      dcoDeclarationPresent: true,
      unverifiedCommits: [],
    });
    expect(output.advisories.contributorApprovalOverlap).toMatchObject({
      status: "clear",
      actors: [],
      uncertainActors: [],
    });
    expect(output.advisories.contributorApprovalOverlap.details).toContain(
      "not proof of independent approval",
    );
    expect(output.gates).not.toHaveProperty("prAdvisor");
  });
  it("warns without blocking when a contributor also approved (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["apurvvkumaria"],
      reviews: [
        {
          author: { login: "apurvvkumaria" },
          state: "APPROVED",
          submittedAt: "2026-01-01T00:00:00Z",
        },
        {
          author: { login: "apurvvkumaria" },
          state: "COMMENTED",
          submittedAt: "2026-01-02T00:00:00Z",
        },
      ],
      prAuthorLogin: "laitingsheng",
      verified: true,
    });

    const output = JSON.parse(result.stdout);
    expect(output.advisories.contributorApprovalOverlap).toMatchObject({
      status: "warning",
      actors: ["apurvvkumaria"],
      uncertainActors: [],
    });
    expect(output.advisories.contributorApprovalOverlap.details).toContain("advisory");
  });
  it("warns when the PR opener approved their own PR (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["coauthor"],
      prAuthorLogin: "opener",
      reviews: [
        {
          author: { login: "opener" },
          state: "APPROVED",
          submittedAt: "2026-01-01T00:00:00Z",
        },
      ],
      verified: true,
    });

    const output = JSON.parse(result.stdout);
    expect(output.advisories.contributorApprovalOverlap).toMatchObject({
      status: "warning",
      actors: ["opener"],
      uncertainActors: [],
    });
  });
  it("uses contributors and approvals from every paginated GitHub page (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      contributorCommitPages: [
        [{ authors: [{ login: "first-page-contributor" }] }],
        [{ authors: [{ login: "later-page-contributor" }] }],
      ],
      contributorReviewPages: [
        [
          {
            author: { login: "first-page-reviewer" },
            state: "APPROVED",
            submittedAt: "2026-01-01T00:00:00Z",
          },
        ],
        [
          {
            author: { login: "later-page-contributor" },
            state: "APPROVED",
            submittedAt: "2026-01-02T00:00:00Z",
          },
        ],
      ],
      verified: true,
    });

    const output = JSON.parse(result.stdout);
    expect(output.advisories.contributorApprovalOverlap).toMatchObject({
      status: "warning",
      actors: ["later-page-contributor"],
      uncertainActors: [],
    });
  });
  it("uses a later review page to supersede an earlier approval (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["contributor"],
      contributorReviewPages: [
        [
          {
            author: { login: "contributor" },
            state: "APPROVED",
            submittedAt: "2026-01-01T00:00:00Z",
          },
        ],
        [
          {
            author: { login: "contributor" },
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-01-02T00:00:00Z",
          },
        ],
      ],
      verified: true,
    });

    const output = JSON.parse(result.stdout);
    expect(output.advisories.contributorApprovalOverlap).toMatchObject({
      status: "clear",
      actors: [],
      uncertainActors: [],
    });
  });
  it("warns when a commit author page is incomplete (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      contributorCommitPages: [[{ authors: [{ login: "contributor" }], authorCount: 101 }]],
      reviews: [
        {
          author: { login: "contributor" },
          state: "APPROVED",
          submittedAt: "2026-01-01T00:00:00Z",
        },
      ],
      verified: true,
    });

    const output = JSON.parse(result.stdout);
    expect(output.advisories.contributorApprovalOverlap).toMatchObject({
      status: "warning",
      actors: [],
      uncertainActors: [],
    });
    expect(output.advisories.contributorApprovalOverlap.details).toContain(
      "complete paginated commit and review history",
    );
  });

  it("warns when the paginated review count is incomplete (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["contributor"],
      contributorReviewPages: [
        [
          {
            author: { login: "other-reviewer" },
            state: "APPROVED",
            submittedAt: "2026-01-01T00:00:00Z",
          },
        ],
      ],
      contributorReviewTotalCount: 2,
      verified: true,
    });

    const output = JSON.parse(result.stdout);
    expect(output.advisories.contributorApprovalOverlap).toMatchObject({
      status: "warning",
      actors: [],
      uncertainActors: [],
    });
    expect(output.advisories.contributorApprovalOverlap.details).toContain(
      "complete paginated commit and review history",
    );
  });

  it("matches multiple commit authors and co-authors case-insensitively (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["PrimaryAuthor", "CoAuthor"],
      prAuthorLogin: "opener",
      reviews: [
        {
          author: { login: "coauthor" },
          state: "APPROVED",
          submittedAt: "2026-01-01T00:00:00Z",
        },
        {
          author: { login: "PRIMARYAUTHOR" },
          state: "APPROVED",
          submittedAt: "2026-01-02T00:00:00Z",
        },
      ],
      verified: true,
    });

    const output = JSON.parse(result.stdout);
    expect(output.advisories.contributorApprovalOverlap).toMatchObject({
      status: "warning",
      actors: ["coauthor", "primaryauthor"],
      uncertainActors: [],
    });
  });

  it("ignores automated contributor and reviewer identities (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["dependabot[bot]", "coderabbitai", "github-actions[bot]"],
      prAuthorLogin: "human-author",
      reviews: [
        {
          author: { login: "dependabot[bot]" },
          state: "APPROVED",
          submittedAt: "2026-01-01T00:00:00Z",
        },
        {
          author: { login: "coderabbitai" },
          state: "APPROVED",
          submittedAt: "2026-01-02T00:00:00Z",
        },
        {
          author: { login: "github-actions[bot]" },
          state: "APPROVED",
          submittedAt: "2026-01-03T00:00:00Z",
        },
      ],
      verified: true,
    });

    const output = JSON.parse(result.stdout);
    expect(output.advisories.contributorApprovalOverlap).toMatchObject({
      status: "clear",
      actors: [],
      uncertainActors: [],
    });
  });

  it("clears overlap when approval is superseded by requested changes (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["contributor"],
      reviews: [
        {
          author: { login: "contributor" },
          state: "APPROVED",
          submittedAt: "2026-01-01T00:00:00Z",
        },
        {
          author: { login: "contributor" },
          state: "CHANGES_REQUESTED",
          submittedAt: "2026-01-02T00:00:00Z",
        },
      ],
      verified: true,
    });

    expect(JSON.parse(result.stdout).advisories.contributorApprovalOverlap).toMatchObject({
      status: "clear",
      actors: [],
      uncertainActors: [],
    });
  });

  it("warns when approval supersedes requested changes regardless of input order (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["contributor"],
      reviews: [
        {
          author: { login: "contributor" },
          state: "APPROVED",
          submittedAt: "2026-01-02T00:00:00Z",
        },
        {
          author: { login: "contributor" },
          state: "CHANGES_REQUESTED",
          submittedAt: "2026-01-01T00:00:00Z",
        },
      ],
      verified: true,
    });

    expect(JSON.parse(result.stdout).advisories.contributorApprovalOverlap).toMatchObject({
      status: "warning",
      actors: ["contributor"],
      uncertainActors: [],
    });
  });

  it("clears overlap when approval is superseded by dismissal (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["contributor"],
      reviews: [
        {
          author: { login: "contributor" },
          state: "APPROVED",
          submittedAt: "2026-01-01T00:00:00Z",
        },
        {
          author: { login: "contributor" },
          state: "DISMISSED",
          submittedAt: "2026-01-02T00:00:00Z",
        },
      ],
      verified: true,
    });

    expect(JSON.parse(result.stdout).advisories.contributorApprovalOverlap).toMatchObject({
      status: "clear",
      actors: [],
      uncertainActors: [],
    });
  });

  it("reports uncertainty when a contributor review timestamp is malformed (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["contributor"],
      reviews: [
        {
          author: { login: "contributor" },
          state: "APPROVED",
          submittedAt: "not-a-timestamp",
        },
      ],
      verified: true,
    });

    const advisory = JSON.parse(result.stdout).advisories.contributorApprovalOverlap;
    expect(advisory).toMatchObject({
      status: "warning",
      actors: [],
      uncertainActors: ["contributor"],
    });
    expect(advisory.details).toContain("could not be determined");
  });

  it("reports uncertainty when a contributor review timestamp is missing (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["contributor"],
      reviews: [
        {
          author: { login: "contributor" },
          state: "APPROVED",
        },
      ],
      verified: true,
    });

    const advisory = JSON.parse(result.stdout).advisories.contributorApprovalOverlap;
    expect(advisory).toMatchObject({
      status: "warning",
      actors: [],
      uncertainActors: ["contributor"],
    });
    expect(advisory.details).toContain("missing");
  });

  it("does not confirm approval when a later opinion has a malformed timestamp (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["contributor"],
      reviews: [
        {
          author: { login: "contributor" },
          state: "APPROVED",
          submittedAt: "2026-01-01T00:00:00Z",
        },
        {
          author: { login: "contributor" },
          state: "CHANGES_REQUESTED",
          submittedAt: "not-a-timestamp",
        },
      ],
      verified: true,
    });

    expect(JSON.parse(result.stdout).advisories.contributorApprovalOverlap).toMatchObject({
      status: "warning",
      actors: [],
      uncertainActors: ["contributor"],
    });
  });

  it("does not confirm approval when an earlier input opinion has a malformed timestamp (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["contributor"],
      reviews: [
        {
          author: { login: "contributor" },
          state: "CHANGES_REQUESTED",
          submittedAt: "not-a-timestamp",
        },
        {
          author: { login: "contributor" },
          state: "APPROVED",
          submittedAt: "2026-01-01T00:00:00Z",
        },
      ],
      verified: true,
    });

    expect(JSON.parse(result.stdout).advisories.contributorApprovalOverlap).toMatchObject({
      status: "warning",
      actors: [],
      uncertainActors: ["contributor"],
    });
  });

  it("reports uncertainty for conflicting opinions with equal timestamps (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["contributor"],
      reviews: [
        {
          author: { login: "contributor" },
          state: "APPROVED",
          submittedAt: "2026-01-01T00:00:00Z",
        },
        {
          author: { login: "contributor" },
          state: "CHANGES_REQUESTED",
          submittedAt: "2026-01-01T00:00:00Z",
        },
      ],
      verified: true,
    });

    expect(JSON.parse(result.stdout).advisories.contributorApprovalOverlap).toMatchObject({
      status: "warning",
      actors: [],
      uncertainActors: ["contributor"],
    });
  });

  it("reports equal-timestamp conflicts independently of API order (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["contributor"],
      reviews: [
        {
          author: { login: "contributor" },
          state: "CHANGES_REQUESTED",
          submittedAt: "2026-01-01T00:00:00Z",
        },
        {
          author: { login: "contributor" },
          state: "APPROVED",
          submittedAt: "2026-01-01T00:00:00Z",
        },
      ],
      verified: true,
    });

    expect(JSON.parse(result.stdout).advisories.contributorApprovalOverlap).toMatchObject({
      status: "warning",
      actors: [],
      uncertainActors: ["contributor"],
    });
  });

  it("accepts GraphQL RFC3339 timestamp variants (#6222)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      commitAuthorLogins: ["fractional", "offset", "whole-second"],
      reviews: [
        {
          author: { login: "fractional" },
          state: "APPROVED",
          submittedAt: "2026-01-01T00:00:00.123Z",
        },
        {
          author: { login: "offset" },
          state: "APPROVED",
          submittedAt: "2026-01-01T05:30:00+05:30",
        },
        {
          author: { login: "whole-second" },
          state: "APPROVED",
          submittedAt: "2026-01-01T00:00:00Z",
        },
      ],
      verified: true,
    });

    expect(JSON.parse(result.stdout).advisories.contributorApprovalOverlap).toMatchObject({
      status: "warning",
      actors: ["fractional", "offset", "whole-second"],
      uncertainActors: [],
    });
  });

  it("fails closed when the PR body lacks the DCO declaration", () => {
    const result = runGate({ body: "## Summary\n\nNo declaration.", verified: true });

    const output = JSON.parse(result.stdout);
    expect(output.gates.contributorCompliance.pass).toBe(false);
    expect(output.gates.contributorCompliance.details).toContain("lacks a valid Signed-off-by");
  });

  it.each([
    "app/dependabot",
    "dependabot[bot]",
  ])("accepts the explicit PR-body DCO bypass for %s", (prAuthorLogin) => {
    const output = JSON.parse(
      runGate({
        body: "Automated dependency update.",
        prAuthorLogin,
        verified: true,
      }).stdout,
    );

    expect(output.gates.contributorCompliance).toMatchObject({
      pass: true,
      dcoDeclarationPresent: false,
      dcoDeclarationBypassed: true,
      unverifiedCommits: [],
    });
  });

  it("still rejects an unverified Dependabot commit", () => {
    const output = JSON.parse(
      runGate({
        body: "Automated dependency update.",
        prAuthorLogin: "app/dependabot",
        verified: false,
        reason: "unsigned",
      }).stdout,
    );

    expect(output.gates.contributorCompliance).toMatchObject({
      pass: false,
      dcoDeclarationBypassed: true,
      unverifiedCommits: [{ sha: "abc123", reason: "unsigned" }],
    });
  });

  it("fails closed when any PR commit is not GitHub Verified", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: false,
      reason: "unsigned",
    });

    const output = JSON.parse(result.stdout);
    expect(output.gates.contributorCompliance).toMatchObject({
      pass: false,
      dcoDeclarationPresent: true,
      unverifiedCommits: [{ sha: "abc123", reason: "unsigned" }],
    });
  });

  it("fails closed for type-skewed commit verification data", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      commitOutput: JSON.stringify({
        sha: "abc123",
        verified: "false",
        reason: "unsigned",
      }),
    });

    const output = JSON.parse(result.stdout);
    expect(output.gates.contributorCompliance).toMatchObject({
      pass: false,
      unverifiedCommits: [{ sha: "abc123", reason: "malformed_commit_verification_data" }],
    });
  });
});

describe("maintainer PR comparator contributor compliance", () => {
  it("passes when DCO and every commit are verified", () => {
    const result = runComparatorGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
    });

    const output = JSON.parse(result.stdout);
    expect(output.gates.ci_green_sha).toBe(true);
    expect(output.gates.contributor_compliance).toBe(true);
    expect(output.details).toMatchObject({
      dco_declaration_present: true,
      commit_count: 1,
      unverified_commits: [],
    });
  });

  it.each([
    "app/dependabot",
    "dependabot[bot]",
  ])("accepts the explicit PR-body DCO bypass for %s", (prAuthorLogin) => {
    const result = runComparatorGate({
      body: "Automated dependency update.",
      prAuthorLogin,
      verified: true,
    });

    const output = JSON.parse(result.stdout);
    expect(output.gates.contributor_compliance).toBe(true);
    expect(output.details).toMatchObject({
      dco_declaration_present: false,
      dco_declaration_bypassed: true,
      unverified_commits: [],
    });
  });

  it("still rejects an unverified Dependabot commit", () => {
    const result = runComparatorGate({
      body: "Automated dependency update.",
      prAuthorLogin: "app/dependabot",
      verified: false,
      reason: "unsigned",
    });

    const output = JSON.parse(result.stdout);
    expect(output.gates.contributor_compliance).toBe(false);
    expect(output.details).toMatchObject({
      dco_declaration_bypassed: true,
      unverified_commits: [{ sha: "abc123", reason: "unsigned" }],
    });
  });

  it("fails when a commit is not verified", () => {
    const result = runComparatorGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: false,
      reason: "unsigned",
    });

    const output = JSON.parse(result.stdout);
    expect(output.gates.contributor_compliance).toBe(false);
    expect(output.details.unverified_commits).toEqual([{ sha: "abc123", reason: "unsigned" }]);
    expect(output.failures).toContain("ineligible:contributor_compliance");
  });

  it("emits fail-closed JSON when commit API output is malformed", () => {
    const result = runComparatorGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      commitOutput: "not-json",
    });

    const output = JSON.parse(result.stdout);
    expect(output.gates.contributor_compliance).toBe(false);
    expect(output.details).toMatchObject({
      commit_count: 0,
      unverified_commits: [],
      commit_fetch_failed: false,
      commit_parse_failed: true,
    });
    expect(output.failures).toContain("ineligible:contributor_compliance");
  });

  it("fails when the PR body lacks the DCO declaration", () => {
    const result = runComparatorGate({
      body: "## Summary\n\nNo declaration.",
      verified: true,
    });

    const output = JSON.parse(result.stdout);
    expect(output.gates.contributor_compliance).toBe(false);
    expect(output.details.dco_declaration_present).toBe(false);
    expect(output.failures).toContain("ineligible:contributor_compliance");
  });

  it("rejects a non-numeric PR argument without emitting malformed JSON", () => {
    const result = runComparatorGate(
      {
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
      },
      '42,"injected":true',
    );

    expect(JSON.parse(result.stdout)).toEqual({
      pr: '42,"injected":true',
      error: "invalid_pr_number",
    });
    expect(result.stderr).toBe("");
  });

  it("uses the requested PR number in comparator GitHub fixtures", () => {
    const result = runComparatorGate(
      {
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
      },
      "73",
    );

    expect(JSON.parse(result.stdout).pr).toBe(73);
    expect(result.stderr).toBe("");
  });

  it("serializes unusual GitHub string values as valid JSON", () => {
    const result = runComparatorGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      headRefOid: 'abc"123\\nnext',
      state: 'OPEN"unexpected',
      mergeable: 'MERGEABLE"unexpected',
      mergeStateStatus: 'CLEAN"unexpected',
      reviewDecision: 'APPROVED"unexpected',
    });

    const output = JSON.parse(result.stdout);
    expect(output.head_sha).toBe('abc"123\\nnext');
    expect(output.details).toMatchObject({
      state: 'OPEN"unexpected',
      mergeable: 'MERGEABLE"unexpected',
      merge_state_status: 'CLEAN"unexpected',
      review_decision: 'APPROVED"unexpected',
    });
  });

  it("fails closed when the status check rollup is empty", () => {
    const result = runComparatorGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      checkNames: [],
    });

    const output = JSON.parse(result.stdout);
    expect(output.gates.ci_green_sha).toBe(false);
    expect(output.details.ci_missing_required_checks).toEqual(REQUIRED_CHECK_NAMES);
    expect(output.failures).toContain(
      "substantive:ci_failures=0,pending=0,missing=checks,check-hash,changes,commit-lint,dco-check,E2E / PR Gate",
    );
  });

  describe("contributor-compliance DCO parity", () => {
    it("requires the canonical Signed-off-by trailer casing in both gates", () => {
      const fixture = {
        body: "signed-off-by: Example User <user@example.com>",
        verified: true,
      };
      const mergeGate = runGate(fixture);
      const comparator = runComparatorGate(fixture);

      expect(mergeGate.status).toBe(0);
      expect(comparator.status).toBe(0);
      expect(JSON.parse(mergeGate.stdout).gates.contributorCompliance.pass).toBe(false);
      expect(JSON.parse(comparator.stdout).gates.contributor_compliance).toBe(false);
    });
  });

  it("names a missing required check and fails the CI gate", () => {
    const fixture = {
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      checkNames: REQUIRED_CHECK_NAMES.filter((name) => name !== "E2E / PR Gate"),
    };
    const mergeGate = runGate(fixture);
    const comparator = runComparatorGate(fixture);

    expect(mergeGate.status).toBe(0);
    expect(comparator.status).toBe(0);
    const mergeOutput = JSON.parse(mergeGate.stdout);
    const comparatorOutput = JSON.parse(comparator.stdout);
    expect(mergeOutput.gates.ci).toMatchObject({
      pass: false,
      missingChecks: ["E2E / PR Gate"],
    });
    expect(mergeOutput.allPass).toBe(false);
    expect(comparatorOutput.gates.ci_green_sha).toBe(false);
    expect(comparatorOutput.details.ci_missing_required_checks).toEqual(["E2E / PR Gate"]);
    expect(comparatorOutput.failures).toContain(
      "substantive:ci_failures=0,pending=0,missing=E2E / PR Gate",
    );
  });

  it.each([
    "NEUTRAL",
    "SKIPPED",
  ])("requires a literal SUCCESS conclusion from E2E / PR Gate when it is %s", (conclusion) => {
    const fixture = {
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      checkConclusions: { "E2E / PR Gate": conclusion },
    };
    const mergeGate = runGate(fixture);
    const comparator = runComparatorGate(fixture);

    expect(mergeGate.status).toBe(0);
    expect(comparator.status).toBe(0);
    const mergeOutput = JSON.parse(mergeGate.stdout);
    const comparatorOutput = JSON.parse(comparator.stdout);
    expect(mergeOutput.gates.ci).toMatchObject({
      pass: false,
      failingChecks: [`E2E / PR Gate: ${conclusion}`],
    });
    expect(mergeOutput.allPass).toBe(false);
    expect(comparatorOutput.gates.ci_green_sha).toBe(false);
    expect(comparatorOutput.details.ci_failing_checks).toEqual([`E2E / PR Gate: ${conclusion}`]);
  });

  it.each([
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
    "STALE",
  ])("fails closed for a completed required check with conclusion %s", (conclusion) => {
    const result = runComparatorGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      checkConclusions: { checks: conclusion },
    });

    const output = JSON.parse(result.stdout);
    expect(output.gates.ci_green_sha).toBe(false);
    expect(output.details.ci_failing_checks).toEqual([`checks: ${conclusion}`]);
    expect(output.failures).toContain("substantive:ci_failures=1,pending=0,missing=");
  });
});
