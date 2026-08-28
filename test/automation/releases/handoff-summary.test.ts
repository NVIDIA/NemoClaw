// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildHandoffSummary,
  renderHandoffMarkdown,
} from "../../../.agents/skills/nemoclaw-maintainer-day/scripts/handoff-summary.ts";

const SCRIPT = path.join(
  process.cwd(),
  ".agents",
  "skills",
  "nemoclaw-maintainer-day",
  "scripts",
  "handoff-summary.ts",
);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function runCli(cwd: string, ...args: string[]) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", SCRIPT, ...args],
    { cwd, encoding: "utf8" },
  );
}

function expectMarkdownList(markdown: string, values: string[]): void {
  for (const value of values) expect(markdown).toContain(`- ${value}`);
}

describe("release handoff summary", () => {
  it("classifies the release range and renders its QA focus", () => {
    const previous = "1".repeat(40);
    const candidate = "2".repeat(40);
    const results = new Map([
      [`rev-parse ${candidate}^{commit}`, candidate],
      [`merge-base ${previous} ${candidate}`, previous],
      [`rev-list --count ${previous}..${candidate}`, "2"],
      [
        `diff --name-only ${previous}..${candidate}`,
        [
          "install.sh",
          "src/lib/onboard/machine/runner.ts",
          "nemoclaw/src/blueprint/ssrf.ts",
          ".github/workflows/e2e.yaml",
          "src/lib/inference/client.ts",
          "docs/changelog/2026-08-17.mdx",
        ].join("\n"),
      ],
    ]);
    const command = (_command: string, args: string[]): string => {
      const operation = args.join(" ");
      expect(results.has(operation), operation).toBe(true);
      return results.get(operation)!;
    };

    const summary = buildHandoffSummary(
      {
        previousTag: "v1.2.2",
        previousTagCommit: previous,
        targetVersion: "v1.2.3",
        candidateCommit: candidate,
        candidateSelection: "current-main",
        historicalCandidateException: "None",
      },
      command,
    );

    expect(summary).toEqual({
      previousTag: "v1.2.2",
      previousTagCommit: previous,
      targetVersion: "v1.2.3",
      candidateCommit: candidate,
      candidateSelection: "current-main",
      historicalCandidateException: "None",
      commitCount: 2,
      riskyFileCount: 5,
      riskyAreas: [
        "Installer / bootstrap",
        "Onboarding / host glue",
        "Sandbox / policy / SSRF",
        "Workflow / enforcement",
        "Credentials / inference",
      ],
      suggestedTestFocus: [
        "Fresh install and upgrade paths",
        "Onboarding wizard and sandbox creation",
        "Policy enforcement, network egress, and SSRF protections",
        "CI checks, pre-commit hooks, and DCO declarations",
        "Credential storage and inference provider routing",
      ],
    });

    const markdown = renderHandoffMarkdown(summary);
    expect(markdown).toContain(`- Candidate: \`${candidate}\``);
    expect(markdown).toContain("- Risky files detected: 5");
    expect(markdown).toContain("## Documentation coverage");
    expect(markdown).toContain("- Maintainer decision: TODO_RELEASE_BRIEF");
    expectMarkdownList(markdown, summary.riskyAreas);
    expectMarkdownList(markdown, summary.suggestedTestFocus);
  });
});

describe("release handoff summary CLI", () => {
  let repo: string;
  let plan: string;

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-handoff-summary-"));
    git(repo, "init", "--quiet");
    git(repo, "config", "user.name", "NemoClaw Test");
    git(repo, "config", "user.email", "nemoclaw-test@example.com");
    git(repo, "config", "commit.gpgsign", "false");

    const fixture = path.join(repo, "release-input.txt");
    fs.writeFileSync(fixture, "previous\n");
    git(repo, "add", "release-input.txt");
    git(repo, "commit", "--quiet", "-m", "test: previous release");
    const previous = git(repo, "rev-parse", "HEAD");

    fs.appendFileSync(fixture, "candidate\n");
    git(repo, "commit", "--quiet", "-am", "test: release candidate");
    const candidate = git(repo, "rev-parse", "HEAD");

    plan = path.join(repo, "plan.json");
    fs.writeFileSync(
      plan,
      JSON.stringify({
        candidateCommit: candidate,
        candidateSelection: "current-main",
        historicalCandidateException: "None",
        nextTag: "v1.2.3",
        originMainCommit: candidate,
        originMainHeadline: "test: release candidate",
        previousTag: "v1.2.2",
        previousTagCommit: previous,
        previousTagObject: previous,
      }),
    );
  });

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("writes a release brief for a valid plan and output path", () => {
    const output = path.join(repo, "brief", "valid.md");
    const result = runCli(repo, "--plan", plan, "--output", output);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(`Release brief written: ${output}`);
    const brief = fs.readFileSync(output, "utf8");
    expect(brief).toContain("# NemoClaw v1.2.3 release brief");
    expect(brief).toContain("- Commits: 1");
  });

  it("rejects an invocation without an output path", () => {
    const output = path.join(repo, "brief", "missing-output.md");
    const result = runCli(repo, "--plan", plan);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("usage: handoff-summary.ts --plan PATH --output PATH");
    expect(fs.existsSync(output)).toBe(false);
  });

  it("refuses to overwrite an existing release brief", () => {
    const output = path.join(repo, "brief", "existing.md");
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, "existing release brief\n");

    const result = runCli(repo, "--plan", plan, "--output", output);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("handoff-summary: EEXIST");
    expect(fs.readFileSync(output, "utf8")).toBe("existing release brief\n");
  });
});
