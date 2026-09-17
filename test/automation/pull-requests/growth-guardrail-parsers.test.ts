// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { E2eAssertionBudget } from "../../../scripts/checks/e2e-assertion-census.mts";

import {
  addedJavaScriptViolations,
  conditionalGrowthViolations,
  diagnostics,
  dockerfileBudgetGrowthViolations,
  e2eAssertionBudgetGrowthViolations,
  loopGrowthViolations,
  onboardGrowthViolations,
  testOnly as checkTestOnly,
  testSizeViolations,
} from "../../helpers/growth-guardrail-checks";
import {
  type GrowthGuardrailDiff,
  testOnly as diffTestOnly,
} from "../../helpers/growth-guardrail-diff";

/** Build an in-memory PR diff so guardrail tests do not read repository files. */
function fixtureDiff(
  files: GrowthGuardrailDiff["files"],
  base: Readonly<Record<string, string>>,
  head: Readonly<Record<string, string>>,
  pullRequestNumber: number | null = null,
): GrowthGuardrailDiff {
  return {
    files,
    pullRequestNumber,
    /**
     * Return each requested base-revision fixture file.
     *
     * @param paths - Repository-relative paths requested by the guardrail.
     * @returns A map from each path to fixture content or the missing-file marker.
     */
    async readBase(paths) {
      return new Map(paths.map((file) => [file, base[file] ?? null]));
    },
    /**
     * Return each requested candidate-revision fixture file.
     *
     * @param paths - Repository-relative paths requested by the guardrail.
     * @returns A map from each path to fixture content or the missing-file marker.
     */
    async readHead(paths) {
      return new Map(paths.map((file) => [file, head[file] ?? null]));
    },
  };
}

function e2eAssertionBudget(
  expectCalls: number,
  referenceSha = "a".repeat(40),
  file = "test/e2e/live/example.test.ts",
): string {
  const metrics = {
    expectCalls,
    matcherAssertions: expectCalls,
    nodeAssertions: 0,
    namedAssertionHelpers: 0,
    failCalls: 0,
    throwGuards: 0,
    objectFieldAssertions: 0,
    assertionPoints: expectCalls,
    generatedProbeBlocks: 0,
    generatedProbeConditions: 0,
  };
  return JSON.stringify({
    $comment: "fixture",
    schemaVersion: 1,
    issue: 10934,
    epic: 10920,
    reference: {
      mainSha: referenceSha,
      currentMainCollectedTests: 1,
      epicMainSha: "b".repeat(40),
      epicCollectedTests: 95,
      epicDirectExpectCalls: 2184,
      epicLiveExpectCalls: 2677,
    },
    limits: {
      testFileCount: 1,
      liveFileCount: 1,
      direct: metrics,
      unique: metrics,
      fileMetricOrder: [
        "directExpectCalls",
        "directAssertionPoints",
        "transitiveExpectCalls",
        "transitiveAssertionPoints",
        "transitiveGeneratedProbeBlocks",
      ],
      files: {
        [file]: [expectCalls, expectCalls, expectCalls, expectCalls, 0],
      },
    },
  });
}

const E2E_BUDGET_PATH = "ci/e2e-assertion-budget.json";
const E2E_EXCEPTION_PATH = "ci/e2e-assertion-growth-exceptions.json";
const QUALIFICATION_TEST = "test/e2e/live/gpu-e2e.test.ts";
const QUALIFICATION_OWNER = "test/e2e/live/gpu-vllm-export-owner.ts";

/** Synthetic policy and census retain the approved qualification's exact growth. */
function qualificationExceptionFixture() {
  const base = JSON.parse(
    e2eAssertionBudget(1, "a".repeat(40), QUALIFICATION_TEST),
  ) as E2eAssertionBudget;
  const baseline = {
    liveFileCount: 194,
    direct: { expectCalls: 1452, assertionPoints: 2279 },
    unique: { expectCalls: 1900, assertionPoints: 3528 },
    files: { [QUALIFICATION_TEST]: [39, 44, 72, 90, 3] as const },
  };
  const maximum = {
    liveFileCount: 195,
    direct: { expectCalls: 1496, assertionPoints: 2340 },
    unique: { expectCalls: 1970, assertionPoints: 3615 },
    files: { [QUALIFICATION_TEST]: [83, 105, 142, 177, 3] as const },
  };
  const budget = (
    limits: Pick<E2eAssertionBudget["limits"], "liveFileCount" | "files"> & {
      direct: { expectCalls: number; assertionPoints: number };
      unique: { expectCalls: number; assertionPoints: number };
    },
  ) => ({
    ...base,
    limits: {
      ...base.limits,
      ...limits,
      direct: { ...base.limits.direct, ...limits.direct },
      unique: { ...base.limits.unique, ...limits.unique },
    },
  });
  const approvedBase = budget(baseline);
  const head = budget(maximum);
  const policy = JSON.stringify({
    schemaVersion: 1,
    exceptions: [
      { pullRequest: 11919, paths: [QUALIFICATION_TEST, QUALIFICATION_OWNER], baseline, maximum },
    ],
  });
  const files = [
    { filename: E2E_BUDGET_PATH, status: "modified" },
    { filename: QUALIFICATION_TEST, status: "modified" },
    { filename: QUALIFICATION_OWNER, status: "added" },
  ];
  return { approvedBase, head, policy, files };
}

/** Register synthetic cases for the growth guardrail parsers and diagnostics. */
function defineCodebaseGrowthGuardrailTestSupport(): void {
  it("allows only the trusted qualification budget for its approved PR", async () => {
    const { approvedBase, head, policy, files } = qualificationExceptionFixture();
    const diff = fixtureDiff(
      files,
      { [E2E_BUDGET_PATH]: JSON.stringify(approvedBase), [E2E_EXCEPTION_PATH]: policy },
      { [E2E_BUDGET_PATH]: JSON.stringify(head) },
      11919,
    );
    expect(await e2eAssertionBudgetGrowthViolations(diff)).toEqual([]);
  });

  it.each([null, 11918, 11920])("rejects the qualification allowance for PR %s", async (pr) => {
    const { approvedBase, head, policy, files } = qualificationExceptionFixture();
    const diff = fixtureDiff(
      files,
      { [E2E_BUDGET_PATH]: JSON.stringify(approvedBase), [E2E_EXCEPTION_PATH]: policy },
      { [E2E_BUDGET_PATH]: JSON.stringify(head) },
      pr,
    );
    expect(await e2eAssertionBudgetGrowthViolations(diff)).toContain(
      "test/e2e/live/gpu-e2e.test.ts transitiveAssertionPoints increased from 90 to 177",
    );
  });

  it("rejects an allowance supplied only by the candidate", async () => {
    const { approvedBase, head, policy, files } = qualificationExceptionFixture();
    const diff = fixtureDiff(
      files,
      { [E2E_BUDGET_PATH]: JSON.stringify(approvedBase) },
      { [E2E_BUDGET_PATH]: JSON.stringify(head), [E2E_EXCEPTION_PATH]: policy },
      11919,
    );
    expect(await e2eAssertionBudgetGrowthViolations(diff)).not.toEqual([]);
  });

  it("rejects a qualification that exceeds the approved upper bound", async () => {
    const { approvedBase, head, policy, files } = qualificationExceptionFixture();
    const oversized = {
      ...head,
      limits: {
        ...head.limits,
        unique: { ...head.limits.unique, assertionPoints: 3616 },
        files: { [QUALIFICATION_TEST]: [83, 105, 142, 178, 3] },
      },
    };
    const diff = fixtureDiff(
      files,
      { [E2E_BUDGET_PATH]: JSON.stringify(approvedBase), [E2E_EXCEPTION_PATH]: policy },
      { [E2E_BUDGET_PATH]: JSON.stringify(oversized) },
      11919,
    );
    expect(await e2eAssertionBudgetGrowthViolations(diff)).toContain(
      "test/e2e/live/gpu-e2e.test.ts transitiveAssertionPoints increased from 177 to 178",
    );
  });

  it("keeps the approved growth bounded after unrelated baseline reductions", async () => {
    const { approvedBase, head, policy, files } = qualificationExceptionFixture();
    const reduced = {
      ...approvedBase,
      limits: {
        ...approvedBase.limits,
        unique: { ...approvedBase.limits.unique, assertionPoints: 3527 },
      },
    };
    const diff = fixtureDiff(
      files,
      { [E2E_BUDGET_PATH]: JSON.stringify(reduced), [E2E_EXCEPTION_PATH]: policy },
      { [E2E_BUDGET_PATH]: JSON.stringify(head) },
      11919,
    );
    expect(await e2eAssertionBudgetGrowthViolations(diff)).toContain(
      "unique.assertionPoints increased from 3614 to 3615",
    );
  });

  it("rejects unrelated live source changes alongside the qualification", async () => {
    const { approvedBase, head, policy, files } = qualificationExceptionFixture();
    const diff = fixtureDiff(
      [...files, { filename: "test/e2e/live/unrelated.ts", status: "added" }],
      { [E2E_BUDGET_PATH]: JSON.stringify(approvedBase), [E2E_EXCEPTION_PATH]: policy },
      { [E2E_BUDGET_PATH]: JSON.stringify(head) },
      11919,
    );
    expect(await e2eAssertionBudgetGrowthViolations(diff)).not.toEqual([]);
  });

  it("rejects another owner's budget growth even within the suite allowance", async () => {
    const { approvedBase, head, policy, files } = qualificationExceptionFixture();
    const other = "test/e2e/live/other.test.ts";
    const before = {
      ...approvedBase,
      limits: {
        ...approvedBase.limits,
        files: { ...approvedBase.limits.files, [other]: [1, 1, 1, 1, 0] },
      },
    };
    const after = {
      ...head,
      limits: { ...head.limits, files: { ...head.limits.files, [other]: [2, 2, 2, 2, 0] } },
    };
    const diff = fixtureDiff(
      files,
      { [E2E_BUDGET_PATH]: JSON.stringify(before), [E2E_EXCEPTION_PATH]: policy },
      { [E2E_BUDGET_PATH]: JSON.stringify(after) },
      11919,
    );
    expect(await e2eAssertionBudgetGrowthViolations(diff)).toContain(
      "test/e2e/live/other.test.ts directExpectCalls increased from 1 to 2",
    );
  });

  it.each([
    [{}, null],
    [{ NEMOCLAW_GROWTH_PR_NUMBER: "11919" }, 11919],
    [{ NEMOCLAW_GROWTH_PR_NUMBER: "11918" }, 11918],
    [{ PR_NUMBER: "11918", NEMOCLAW_GROWTH_PR_NUMBER: "11919" }, 11918],
    [{ PR_NUMBER: "11919", NEMOCLAW_GROWTH_PR_NUMBER: "invalid" }, 11919],
  ])("uses local PR hints only outside hosted PR mode (%j)", (environment, expected) => {
    expect(diffTestOnly.selectPullRequestNumber(environment)).toBe(expected);
  });

  it.each(["", "0", "-1", "11919junk", "1.5", "9007199254740992"])(
    "rejects malformed local PR hint %s",
    (value) => {
      expect(() =>
        diffTestOnly.selectPullRequestNumber({ NEMOCLAW_GROWTH_PR_NUMBER: value }),
      ).toThrow();
    },
  );

  it("caches repeated blob reads across guardrail checks", () => {
    const read = vi.fn((file: string) => `${file} content`);
    const cache = new Map<string, string | null>();

    expect(diffTestOnly.readFilesCached(["test/a.test.ts"], cache, read)).toEqual(
      new Map([["test/a.test.ts", "test/a.test.ts content"]]),
    );
    expect(diffTestOnly.readFilesCached(["test/a.test.ts"], cache, read)).toEqual(
      new Map([["test/a.test.ts", "test/a.test.ts content"]]),
    );
    expect(read).toHaveBeenCalledOnce();
  });

  it("rejects an added JavaScript file without rejecting an existing JavaScript rename", () => {
    expect(
      addedJavaScriptViolations([
        { filename: "test/new.test.js", status: "added" },
        {
          filename: "test/new-name.test.js",
          previous_filename: "test/old-name.test.js",
          status: "renamed",
        },
      ]),
    ).toEqual(["test/new.test.js"]);
  });

  it("rejects growth in the onboarding entry point", async () => {
    const diff = fixtureDiff(
      [{ filename: "src/lib/onboard.ts", status: "modified" }],
      { "src/lib/onboard.ts": "first\n" },
      { "src/lib/onboard.ts": "first\nsecond\n" },
    );
    expect(await onboardGrowthViolations(diff)).toEqual(["src/lib/onboard.ts grew by 1 line(s)"]);
  });

  /** Separate failures identify both the visible and byte-level budget increases. */
  async function rejectDockerfileLineAndByteGrowth(): Promise<void> {
    const diff = fixtureDiff(
      [{ filename: "Dockerfile", status: "modified" }],
      { Dockerfile: "FROM scratch\nRUN true\n" },
      { Dockerfile: "FROM scratch\nRUN true\nCOPY setup /setup\nRUN /setup\n" },
    );
    expect(await dockerfileBudgetGrowthViolations(diff)).toEqual([
      "Dockerfile line budget increased from 2 to 4",
      "Dockerfile byte budget increased from 22 to 51",
    ]);
  }

  it("rejects root Dockerfile line and byte growth", rejectDockerfileLineAndByteGrowth);

  /** Byte growth closes the bypass left by instruction and physical-line counters. */
  async function rejectDockerfileSameLineGrowth(): Promise<void> {
    const diff = fixtureDiff(
      [{ filename: "Dockerfile", status: "modified" }],
      { Dockerfile: "FROM scratch\nRUN true\n" },
      { Dockerfile: "FROM scratch\nRUN true && second\n" },
    );
    expect(await dockerfileBudgetGrowthViolations(diff)).toEqual([
      "Dockerfile byte budget increased from 22 to 32",
    ]);

    const multibyteDiff = fixtureDiff(
      [{ filename: "Dockerfile", status: "modified" }],
      { Dockerfile: "FROM scratch\nRUN echo\n" },
      { Dockerfile: "FROM scratch\nRUN echo é\n" },
    );
    expect(await dockerfileBudgetGrowthViolations(multibyteDiff)).toEqual([
      "Dockerfile byte budget increased from 22 to 25",
    ]);
  }

  it("rejects root Dockerfile growth within an existing line", rejectDockerfileSameLineGrowth);

  /** Comments share the budget because the ratchet applies to the complete producer file. */
  async function rejectDockerfileDocumentationGrowth(): Promise<void> {
    const diff = fixtureDiff(
      [{ filename: "Dockerfile", status: "modified" }],
      { Dockerfile: "FROM scratch\n" },
      { Dockerfile: "# Managed image recipe\nFROM scratch\n" },
    );
    expect(await dockerfileBudgetGrowthViolations(diff)).toEqual([
      "Dockerfile line budget increased from 1 to 2",
      "Dockerfile byte budget increased from 13 to 36",
    ]);
  }

  it("rejects documentation-only root Dockerfile growth", rejectDockerfileDocumentationGrowth);

  /** The ratchet permits simplification without a maintainer override. */
  async function allowDockerfileBudgetShrinkage(): Promise<void> {
    const diff = fixtureDiff(
      [{ filename: "Dockerfile", status: "modified" }],
      { Dockerfile: "FROM scratch\nRUN true\n" },
      { Dockerfile: "FROM scratch\n" },
    );
    expect(await dockerfileBudgetGrowthViolations(diff)).toEqual([]);
  }

  it("allows the root Dockerfile budget to shrink", allowDockerfileBudgetShrinkage);

  it("allows the trusted-base Dockerfile ceiling only (#11105)", async () => {
    const policy = JSON.stringify({
      schemaVersion: 1,
      exceptions: [{ pullRequest: 11105, maxLines: 4, maxBytes: 51 }],
    });
    const files = [{ filename: "Dockerfile", status: "modified" }] as const;
    const base = {
      Dockerfile: "FROM scratch\nRUN true\n",
      "ci/dockerfile-growth-exceptions.json": policy,
    };
    const head = {
      Dockerfile: "FROM scratch\nRUN true\nCOPY setup /setup\nRUN /setup\n",
    };

    expect(await dockerfileBudgetGrowthViolations(fixtureDiff(files, base, head, 11105))).toEqual(
      [],
    );
    expect(await dockerfileBudgetGrowthViolations(fixtureDiff(files, base, head, 11106))).toEqual([
      "Dockerfile line budget increased from 2 to 4",
      "Dockerfile byte budget increased from 22 to 51",
    ]);
  });

  it("rejects either approved Dockerfile ceiling when exceeded (#11105)", async () => {
    const policy = JSON.stringify({
      schemaVersion: 1,
      exceptions: [{ pullRequest: 11105, maxLines: 3, maxBytes: 40 }],
    });
    const diff = fixtureDiff(
      [{ filename: "Dockerfile", status: "modified" }],
      {
        Dockerfile: "FROM scratch\nRUN true\n",
        "ci/dockerfile-growth-exceptions.json": policy,
      },
      { Dockerfile: "FROM scratch\nRUN true\nCOPY setup /setup\nRUN /setup\n" },
      11105,
    );

    expect(await dockerfileBudgetGrowthViolations(diff)).toEqual([
      "Dockerfile line budget exceeded the PR #11105 maximum of 3 with 4",
      "Dockerfile byte budget exceeded the PR #11105 maximum of 40 with 51",
    ]);
  });

  it("does not let a candidate revision add its own Dockerfile exception", async () => {
    const candidatePolicy = JSON.stringify({
      schemaVersion: 1,
      exceptions: [{ pullRequest: 11106, maxLines: 4, maxBytes: 51 }],
    });
    const diff = fixtureDiff(
      [
        { filename: "Dockerfile", status: "modified" },
        {
          filename: "ci/dockerfile-growth-exceptions.json",
          status: "modified",
        },
      ],
      {
        Dockerfile: "FROM scratch\nRUN true\n",
        "ci/dockerfile-growth-exceptions.json": JSON.stringify({
          schemaVersion: 1,
          exceptions: [],
        }),
      },
      {
        Dockerfile: "FROM scratch\nRUN true\nCOPY setup /setup\nRUN /setup\n",
        "ci/dockerfile-growth-exceptions.json": candidatePolicy,
      },
      11106,
    );

    expect(await dockerfileBudgetGrowthViolations(diff)).toEqual([
      "Dockerfile line budget increased from 2 to 4",
      "Dockerfile byte budget increased from 22 to 51",
    ]);
  });

  /** The remediation text records the escalation path for intentional growth. */
  function requireDockerfileBudgetDecision(): void {
    const message = diagnostics.dockerfileBudget(["Dockerfile byte budget increased"]);
    expect(message).toContain("Host-side stock Dockerfile onboarding is deprecated");
    expect(message).toContain("managed-image startup profile, bootstrap, or runtime-provider path");
    expect(message).toContain("record a maintainer decision before increasing this budget");
  }

  it(
    "requires a maintainer decision to increase the root Dockerfile budget",
    requireDockerfileBudgetDecision,
  );

  it("rejects a larger default test file budget", async () => {
    const diff = fixtureDiff(
      [{ filename: "ci/test-file-size-budget.json", status: "modified" }],
      { "ci/test-file-size-budget.json": '{"defaultMaxLines":1500}' },
      { "ci/test-file-size-budget.json": '{"defaultMaxLines":2000}' },
    );
    expect(await testSizeViolations(diff)).toContain("defaultMaxLines increased from 1500 to 2000");
  });

  it("accepts the initial live E2E assertion budget", async () => {
    const budget = e2eAssertionBudget(1);
    const diff = fixtureDiff(
      [{ filename: "ci/e2e-assertion-budget.json", status: "added" }],
      {},
      { "ci/e2e-assertion-budget.json": budget },
    );

    expect(await e2eAssertionBudgetGrowthViolations(diff)).toEqual([]);
  });

  it("accepts a lower live E2E assertion budget", async () => {
    const diff = fixtureDiff(
      [{ filename: "ci/e2e-assertion-budget.json", status: "modified" }],
      { "ci/e2e-assertion-budget.json": e2eAssertionBudget(2) },
      { "ci/e2e-assertion-budget.json": e2eAssertionBudget(1) },
    );

    expect(await e2eAssertionBudgetGrowthViolations(diff)).toEqual([]);
  });

  it("rejects a larger live E2E assertion budget and changed reference", async () => {
    const diff = fixtureDiff(
      [{ filename: "ci/e2e-assertion-budget.json", status: "modified" }],
      { "ci/e2e-assertion-budget.json": e2eAssertionBudget(1) },
      { "ci/e2e-assertion-budget.json": e2eAssertionBudget(2, "c".repeat(40)) },
    );
    const violations = await e2eAssertionBudgetGrowthViolations(diff);

    expect(violations).toContain("live E2E assertion reference metadata changed");
    expect(violations).toContain("direct.expectCalls increased from 1 to 2");
    expect(violations).toContain(
      "test/e2e/live/example.test.ts directExpectCalls increased from 1 to 2",
    );
  });

  it("rejects an omitted live E2E assertion budget unless its test was removed", async () => {
    const withoutFile = JSON.parse(e2eAssertionBudget(1)) as {
      limits: { files: Record<string, unknown> };
    };
    withoutFile.limits.files = {};
    const base = { "ci/e2e-assertion-budget.json": e2eAssertionBudget(1) };
    const head = {
      "ci/e2e-assertion-budget.json": JSON.stringify(withoutFile),
    };

    const omitted = fixtureDiff(
      [{ filename: "ci/e2e-assertion-budget.json", status: "modified" }],
      base,
      head,
    );
    expect(await e2eAssertionBudgetGrowthViolations(omitted)).toContain(
      "test/e2e/live/example.test.ts omitted its live E2E assertion budget",
    );

    const removed = fixtureDiff(
      [
        { filename: "ci/e2e-assertion-budget.json", status: "modified" },
        { filename: "test/e2e/live/example.test.ts", status: "removed" },
      ],
      base,
      head,
    );
    expect(await e2eAssertionBudgetGrowthViolations(removed)).toEqual([]);
  });

  it("carries a live E2E assertion budget across a test rename", async () => {
    const renamed = "test/e2e/live/renamed.test.ts";
    const diff = fixtureDiff(
      [
        { filename: "ci/e2e-assertion-budget.json", status: "modified" },
        {
          filename: renamed,
          previous_filename: "test/e2e/live/example.test.ts",
          status: "renamed",
        },
      ],
      { "ci/e2e-assertion-budget.json": e2eAssertionBudget(2) },
      {
        "ci/e2e-assertion-budget.json": e2eAssertionBudget(1, "a".repeat(40), renamed),
      },
    );

    expect(await e2eAssertionBudgetGrowthViolations(diff)).toEqual([]);
  });

  it("rejects a changed test that is missing from the latest PR commit", async () => {
    const diff = fixtureDiff(
      [{ filename: "test/example.test.ts", status: "modified" }],
      { "ci/test-file-size-budget.json": '{"defaultMaxLines":1500}' },
      {},
    );
    expect(await testSizeViolations(diff)).toContain(
      "test/example.test.ts was not found at the latest PR commit",
    );
  });

  it("asks for a stale legacy budget to be removed when its test is deleted", async () => {
    const budget = '{"defaultMaxLines":1500,"legacyMaxLines":{"test/legacy.test.ts":1}}';
    const diff = fixtureDiff(
      [{ filename: "test/legacy.test.ts", status: "removed" }],
      {
        "ci/test-file-size-budget.json": budget,
        "test/legacy.test.ts": "legacy\n",
      },
      { "ci/test-file-size-budget.json": budget },
    );
    expect(await testSizeViolations(diff)).toEqual([
      "test/legacy.test.ts no longer exists; remove its legacy budget 1",
    ]);
  });

  it("reports an oversized changed legacy test once", async () => {
    const budget = '{"defaultMaxLines":1500,"legacyMaxLines":{"test/legacy.test.ts":1}}';
    const diff = fixtureDiff(
      [{ filename: "test/legacy.test.ts", status: "modified" }],
      {
        "ci/test-file-size-budget.json": budget,
        "test/legacy.test.ts": "legacy\n",
      },
      {
        "ci/test-file-size-budget.json": budget,
        "test/legacy.test.ts": "legacy\ngrowth\n",
      },
    );
    expect(await testSizeViolations(diff)).toEqual([
      "test/legacy.test.ts has 2 lines, above its budget 1",
    ]);
  });

  it("rejects a new if statement in a changed test file", async () => {
    const diff = fixtureDiff(
      [{ filename: "test/example.test.ts", status: "modified" }],
      { "test/example.test.ts": "it('works', () => expect(ok).toBe(true));" },
      { "test/example.test.ts": "it('works', () => { if (ok) expect(ok).toBe(true); });" },
    );
    expect(await conditionalGrowthViolations(diff)).toEqual([
      "test/example.test.ts: 1 if statement(s), up from 0",
    ]);
  });

  it("rejects a new loop in a changed test callback", async () => {
    const diff = fixtureDiff(
      [{ filename: "test/example.test.ts", status: "modified" }],
      { "test/example.test.ts": "it('works', () => expect(rows).toBeDefined());" },
      {
        "test/example.test.ts":
          "it('works', () => { for (const row of rows) expect(row).toBeDefined(); });",
      },
    );
    expect(await loopGrowthViolations(diff)).toEqual([
      "test/example.test.ts: 1 test loop(s), up from 0",
    ]);
  });

  it.each([
    ["if statements", conditionalGrowthViolations, "if (ok) expect(ok).toBe(true);"],
    [
      "test loops",
      loopGrowthViolations,
      "for (const row of rows) it(row.name, () => expect(row).toBeDefined());",
    ],
  ])("compares %s across a renamed test", async (_name, violations, addedSyntax) => {
    const file = {
      filename: "test/new.test.ts",
      previous_filename: "test/old.test.ts",
      status: "renamed",
    };
    const base = "it('works', () => expect(ok).toBe(true));";

    expect(
      await violations(
        fixtureDiff([file], { "test/old.test.ts": base }, { "test/new.test.ts": base }),
      ),
    ).toEqual([]);
    expect(
      await violations(
        fixtureDiff(
          [file],
          { "test/old.test.ts": base },
          { "test/new.test.ts": `${base}\n${addedSyntax}` },
        ),
      ),
    ).toHaveLength(1);
  });

  it.each([
    ["plain assertion", "it('works', () => expect(true).toBe(true));", 0],
    ["conditional assertion", "it('works', () => { if (ok) expect(ok).toBe(true); });", 1],
  ])("counts if statements in %s", (_name, source, expected) => {
    expect(checkTestOnly.countIfStatements("test/example.test.ts", source)).toBe(expected);
  });

  it.each([
    ["plain assertion", "it('works', () => expect(true).toBe(true));", 0],
    [
      "test callback loop",
      "it('works', () => { for (const row of rows) expect(row).toBe(1); });",
      1,
    ],
    [
      "table definition loop",
      "for (const row of rows) it(row.name, () => expect(row).toBe(1));",
      1,
    ],
    [
      "named test callback loop",
      "function verifyRows() { for (const row of rows) expect(row).toBe(1); } it('works', verifyRows);",
      1,
    ],
    [
      "one-use loop helper",
      "function collect(rows) { for (const row of rows) consume(row); } it('works', () => collect(rows));",
      1,
    ],
    [
      "thin callback-forwarding helper",
      "function repeat(rows, action) { for (const row of rows) action(row); } it('works', () => repeat(rows, (row) => expect(row).toBe(1)));",
      1,
    ],
    [
      "callback-forwarding helper declared inside a test",
      "it('works', () => { function repeat(rows, action) { for (const row of rows) action(row); } repeat(rows, (row) => expect(row).toBe(1)); });",
      1,
    ],
    [
      "reused setup helper",
      "function collect(rows) { for (const row of rows) consume(row); } it('works', () => collect(rows)); it('also works', () => collect(moreRows));",
      0,
    ],
    [
      "same-named helpers in different lexical scopes",
      "function collect(rows) { for (const row of rows) consume(row); } it('outer', () => collect(rows)); it('nested', () => { function collect(value) { consume(value); } collect(value); });",
      1,
    ],
    [
      "uncalled nested helper loop",
      "it('works', () => { function collect(rows) { for (const row of rows) consume(row); } expect(ok).toBe(true); });",
      0,
    ],
    ["support helper loop", "function collect(rows) { for (const row of rows) consume(row); }", 0],
  ])("counts test loops in %s", (_name, source, expected) => {
    expect(checkTestOnly.countTestLoops("test/example.test.ts", source)).toBe(expected);
  });

  it("parses renamed and added files from a zero-delimited Git diff", () => {
    expect(diffTestOnly.parseChangedFiles("R100\0old.ts\0new.ts\0A\0added.ts\0")).toEqual([
      { filename: "new.ts", previous_filename: "old.ts", status: "renamed" },
      { filename: "added.ts", status: "added" },
    ]);
  });

  it("compares a main merge worktree with its MERGE_HEAD commit", () => {
    expect(diffTestOnly.selectLocalComparisonBase("branch-base", "main-head", true)).toBe(
      "main-head",
    );
  });

  it("keeps the branch merge base outside a main merge", () => {
    expect(diffTestOnly.selectLocalComparisonBase("branch-base", null, false)).toBe("branch-base");
    expect(diffTestOnly.selectLocalComparisonBase("branch-base", "topic-head", false)).toBe(
      "branch-base",
    );
  });

  it("accepts only conclusive Git ancestry probe results", () => {
    expect(diffTestOnly.parseAncestorProbe(0, undefined)).toBe(true);
    expect(diffTestOnly.parseAncestorProbe(1, undefined)).toBe(false);
    expect(() => diffTestOnly.parseAncestorProbe(128, undefined)).toThrow(
      "git merge-base --is-ancestor failed with status 128",
    );
    expect(() => diffTestOnly.parseAncestorProbe(null, new Error("spawn failed"))).toThrow(
      "spawn failed",
    );
  });
}

describe("codebase growth guardrail test support", defineCodebaseGrowthGuardrailTestSupport);
