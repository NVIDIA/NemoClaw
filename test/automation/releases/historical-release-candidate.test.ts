// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildHandoffSummary,
  renderHandoffMarkdown,
} from "../../../.agents/skills/nemoclaw-maintainer-day/scripts/handoff-summary";
import {
  cleanupFixtures,
  commit,
  createFixture,
  createHistoricalPlan,
  cutHistoricalPlan,
  git,
  planArguments,
  pushTag,
  releaseBrief,
  remoteCommit,
  remoteTagText,
  run,
  writeBrief,
} from "../../helpers/historical-release-fixture";

const fixtureEnvironment = { NEMOCLAW_RELEASE_ALLOW_NON_CANONICAL: "1" };
const exception = "Urgent QA qualification for issue `#123` requires the preceding main commit.";

afterEach(cleanupFixtures);

describe("historical release candidate", () => {
  it("renders the plan-bound exception in the handoff summary", () => {
    const previous = "1".repeat(40);
    const candidate = "2".repeat(40);
    const results = new Map([
      [`rev-parse ${candidate}^{commit}`, candidate],
      [`merge-base ${previous} ${candidate}`, previous],
      [`rev-list --count ${previous}..${candidate}`, "1"],
      [`diff --name-only ${previous}..${candidate}`, ""],
    ]);
    const command = (_command: string, args: string[]): string => results.get(args.join(" "))!;

    const markdown = renderHandoffMarkdown(
      buildHandoffSummary(
        {
          previousTag: "v1.2.2",
          previousTagCommit: previous,
          targetVersion: "v1.2.3",
          candidateCommit: candidate,
          candidateSelection: "historical",
          historicalCandidateException: exception,
        },
        command,
      ),
    );

    expect(markdown).toContain("- Candidate selection: historical");
    expect(markdown).toContain(
      "- Historical candidate exception: Urgent QA qualification for issue \\`\\#123\\` requires the preceding main commit.",
    );
  });

  it("plans an ancestor and binds its exception into the signed brief", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const candidate = commit(fixture, "historical release candidate");
    const currentMain = commit(fixture, "planned release commit");
    const historical = createHistoricalPlan(fixture, candidate, exception);
    const brief = releaseBrief(historical.plan);

    const result = cutHistoricalPlan(
      fixture,
      historical.path,
      historical.plan,
      writeBrief(fixture, brief),
    );

    expect(result.status, String(result.stderr)).toBe(0);
    expect(historical.plan).toMatchObject({
      candidateCommit: candidate,
      candidateSelection: "historical",
      historicalCandidateException: exception,
      originMainCommit: currentMain,
    });
    expect(remoteCommit(fixture, "refs/tags/v0.0.2")).toBe(candidate);
    expect(remoteTagText(fixture, "refs/tags/v0.0.2")).toContain(
      "- Historical candidate exception: Urgent QA qualification for issue \\`\\#123\\` requires the preceding main commit.",
    );
  });

  it("requires a historical exception", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const candidate = commit(fixture, "historical release candidate");
    commit(fixture, "planned release commit");

    const result = run(fixture.work, planArguments(candidate), fixtureEnvironment);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--exception requires a nonblank plain-language reason");
  });

  it("rejects an exception for current origin/main", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const currentMain = commit(fixture, "planned release commit");

    const result = run(fixture.work, planArguments(currentMain, "Not needed."), fixtureEnvironment);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("omit --candidate and --exception");
  });

  it("rejects a candidate that is not reachable from origin/main", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    commit(fixture, "planned release commit");
    const tree = git(fixture.work, "rev-parse", "HEAD^{tree}");
    const unreachable = git(
      fixture.work,
      "commit-tree",
      tree,
      "-p",
      fixture.firstCommit,
      "-m",
      "unreachable candidate",
    );

    const result = run(
      fixture.work,
      planArguments(unreachable, "Urgent QA qualification requires this commit."),
      fixtureEnvironment,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `Candidate commit is not reachable from origin/main: ${unreachable}`,
    );
  });

  it("rejects a candidate before the previous release", () => {
    const fixture = createFixture();
    const candidate = fixture.firstCommit;
    const previousRelease = commit(fixture, "previous release commit");
    pushTag(fixture, "v0.0.1", previousRelease);
    commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");

    const result = run(
      fixture.work,
      planArguments(candidate, "Urgent QA qualification requires this commit.", planPath),
      fixtureEnvironment,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `Candidate commit ${candidate} does not follow previous release v0.0.1`,
    );
    expect(fs.existsSync(planPath)).toBe(false);
  });

  it("rejects a brief whose historical exception differs from the plan", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const candidate = commit(fixture, "historical release candidate");
    commit(fixture, "planned release commit");
    const historical = createHistoricalPlan(fixture, candidate, exception);
    const brief = releaseBrief(historical.plan).replace(
      /^- Historical candidate exception:.*$/mu,
      "- Historical candidate exception: A different reason.",
    );

    const result = cutHistoricalPlan(
      fixture,
      historical.path,
      historical.plan,
      writeBrief(fixture, brief),
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("plan-bound historical candidate exception");
    expect(
      run(fixture.work, ["git", "show-ref", "--verify", "--quiet", "refs/tags/v0.0.2"]).status,
    ).not.toBe(0);
  });
});
