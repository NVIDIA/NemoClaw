// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

interface ComplianceFixture {
  body: string;
  commitOutput?: string;
  verified: boolean;
  reason?: string;
}

interface ComparatorFixture extends ComplianceFixture {
  checkNames?: string[];
  checkConclusions?: Record<string, string>;
  headRefOid?: string;
  state?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function runGate(fixture: ComplianceFixture) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "check-gates-compliance-"));
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  const ghPath = path.join(bin, "gh");

  const pr = {
    number: 42,
    title: "fix(policy): align maintainer workflow",
    url: "https://github.com/NVIDIA/NemoClaw/pull/42",
    body: fixture.body,
    files: [],
    statusCheckRollup: ["checks", "commit-lint", "dco-check"].map((name) => ({
      __typename: "CheckRun",
      name,
      status: "COMPLETED",
      conclusion: "SUCCESS",
    })),
    mergeStateStatus: "CLEAN",
    headRefOid: "abc123",
  };
  const commit = {
    sha: "abc123",
    verified: fixture.verified,
    reason: fixture.reason ?? (fixture.verified ? "valid" : "unsigned"),
  };
  const commitOutput = fixture.commitOutput ?? JSON.stringify(commit);

  fs.writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  "pr view") printf '%s' ${shellSingleQuote(JSON.stringify(pr))} ;;
  "api graphql") printf '%s' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}' ;;
  "api repos/NVIDIA/NemoClaw/issues/42/comments") printf '%s' '{"id":1,"body":"ordinary comment","user":{"login":"reviewer"},"updated_at":"2026-01-01T00:00:00Z"}' ;;
  "api repos/NVIDIA/NemoClaw/pulls/42/commits") printf '%s' ${shellSingleQuote(commitOutput)} ;;
  *) echo "unexpected gh args: $*" >&2; exit 9 ;;
esac
`,
  );
  fs.chmodSync(ghPath, 0o755);

  try {
    return spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        ".agents/skills/nemoclaw-maintainer-day/scripts/check-gates.ts",
        "42",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf-8",
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
      },
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function runComparatorGate(fixture: ComparatorFixture, prNumber = "42") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "collect-gates-compliance-"));
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  const ghPath = path.join(bin, "gh");

  const pr = {
    number: 42,
    state: fixture.state ?? "OPEN",
    body: fixture.body,
    headRefOid: fixture.headRefOid ?? "abc123",
    statusCheckRollup: (fixture.checkNames ?? ["checks", "commit-lint", "dco-check"]).map(
      (name) => ({
        name,
        status: "COMPLETED",
        conclusion: fixture.checkConclusions?.[name] ?? "SUCCESS",
      }),
    ),
    mergeable: fixture.mergeable ?? "MERGEABLE",
    mergeStateStatus: fixture.mergeStateStatus ?? "CLEAN",
    reviewDecision: fixture.reviewDecision ?? "APPROVED",
  };
  const commit = {
    sha: "abc123",
    verified: fixture.verified,
    reason: fixture.reason ?? (fixture.verified ? "valid" : "unsigned"),
  };
  const commitOutput = fixture.commitOutput ?? JSON.stringify(commit);

  fs.writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  "pr view") printf '%s' ${shellSingleQuote(JSON.stringify(pr))} ;;
  "api repos/NVIDIA/NemoClaw/pulls/42/commits") printf '%s' ${shellSingleQuote(commitOutput)} ;;
  *) echo "unexpected gh args: $*" >&2; exit 9 ;;
esac
`,
  );
  fs.chmodSync(ghPath, 0o755);

  try {
    return spawnSync(
      "bash",
      [
        ".agents/skills/nemoclaw-maintainer-pr-comparator/scripts/collect-gates.sh",
        prNumber,
        "--repo",
        "NVIDIA/NemoClaw",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf-8",
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
      },
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("maintainer merge-gate contributor compliance", () => {
  it("passes when the PR body has DCO and every commit is GitHub Verified", () => {
    const result = runGate({
      body: "## Summary\n\nPolicy alignment.\n\nSigned-off-by: Example User <user@example.com>",
      verified: true,
    });

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.gates.contributorCompliance).toMatchObject({
      pass: true,
      dcoDeclarationPresent: true,
      unverifiedCommits: [],
    });
    expect(output.allPass).toBe(true);
  });

  it("fails closed when the PR body lacks the DCO declaration", () => {
    const result = runGate({ body: "## Summary\n\nNo declaration.", verified: true });

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.gates.contributorCompliance.pass).toBe(false);
    expect(output.gates.contributorCompliance.details).toContain("lacks a valid Signed-off-by");
    expect(output.allPass).toBe(false);
  });

  it("fails closed when any PR commit is not GitHub Verified", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: false,
      reason: "unsigned",
    });

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.gates.contributorCompliance).toMatchObject({
      pass: false,
      dcoDeclarationPresent: true,
      unverifiedCommits: [{ sha: "abc123", reason: "unsigned" }],
    });
    expect(output.allPass).toBe(false);
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

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.gates.contributorCompliance).toMatchObject({
      pass: false,
      unverifiedCommits: [{ sha: "abc123", reason: "malformed_commit_verification_data" }],
    });
    expect(output.allPass).toBe(false);
  });
});

describe("maintainer PR comparator contributor compliance", () => {
  it("passes when DCO and every commit are verified", () => {
    const result = runComparatorGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
    });

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.gates.ci_green_latest_sha).toBe(true);
    expect(output.gates.contributor_compliance).toBe(true);
    expect(output.details).toMatchObject({
      dco_declaration_present: true,
      commit_count: 1,
      unverified_commits: [],
    });
  });

  it("fails when a commit is not verified", () => {
    const result = runComparatorGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: false,
      reason: "unsigned",
    });

    expect(result.status).toBe(0);
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

    expect(result.status).toBe(0);
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

    expect(result.status).toBe(0);
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

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      pr: '42,"injected":true',
      error: "invalid_pr_number",
    });
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

    expect(result.status).toBe(0);
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

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.gates.ci_green_latest_sha).toBe(false);
    expect(output.details.ci_missing_required_checks).toEqual([
      "checks",
      "commit-lint",
      "dco-check",
    ]);
    expect(output.failures).toContain(
      "substantive:ci_failures=0,pending=0,missing=checks,commit-lint,dco-check",
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
    const result = runComparatorGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      checkNames: ["checks", "commit-lint"],
    });

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.gates.ci_green_latest_sha).toBe(false);
    expect(output.details.ci_missing_required_checks).toEqual(["dco-check"]);
    expect(output.failures).toContain("substantive:ci_failures=0,pending=0,missing=dco-check");
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

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.gates.ci_green_latest_sha).toBe(false);
    expect(output.details.ci_failing_checks).toEqual([`checks: ${conclusion}`]);
    expect(output.failures).toContain("substantive:ci_failures=1,pending=0,missing=");
  });
});
