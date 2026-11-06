// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  conditionalGrowthViolations,
  e2eAssertionBudgetGrowthViolations,
} from "../../helpers/growth-guardrail-checks";
import { testOnly } from "../../helpers/growth-guardrail-diff";
import { e2eAssertionBudget } from "../../helpers/e2e-assertion-budget";
import { e2eBudgetChangeDigest } from "../../helpers/e2e-budget-approval";
import {
  BUDGET,
  GrowthRepository,
  POLICY,
  RETAINED_TEST,
} from "../../support/growth-guardrail-repository";

let repository: GrowthRepository;

beforeEach(() => {
  repository = new GrowthRepository();
});
afterEach(() => {
  repository.dispose();
});

function load(base: string, candidate: string) {
  vi.stubEnv("PR_NUMBER", "1");
  vi.stubEnv("BASE_SHA", base);
  vi.stubEnv("HEAD_SHA", candidate);
  vi.stubEnv("GITHUB_EVENT_NAME", "pull_request_target");
  vi.stubEnv("GITHUB_REPOSITORY", "fixture/repository");
  return testOnly.loadPullRequestDiff(repository.checkout);
}

describe("growth checks against the proposed merge", () => {
  it.each(["full", "shallow"] as const)(
    "preserves base-only reductions with %s history",
    async (depth) => {
      const base = repository.reduceBase();
      repository.startCandidate();
      repository.write("src/candidate.ts", "export const accepted = true;\n");
      const candidate = repository.commit("candidate change");
      repository.cloneBase(depth);
      const before = repository.git(repository.checkout, "status", "--porcelain=v1");

      const diff = load(base, candidate);

      expect(diff.files).toEqual([{ filename: "src/candidate.ts", status: "added" }]);
      expect(await conditionalGrowthViolations(diff)).toEqual([]);
      expect(await e2eAssertionBudgetGrowthViolations(diff)).toEqual([]);
      expect(await diff.readHead([BUDGET, RETAINED_TEST])).toEqual(
        await diff.readBase([BUDGET, RETAINED_TEST]),
      );
      expect(repository.git(repository.checkout, "rev-parse", "HEAD")).toBe(base);
      expect(repository.git(repository.checkout, "status", "--porcelain=v1")).toBe(before);
    },
  );

  it("rejects candidate conditional growth after a base-only reduction", async () => {
    const base = repository.reduceBase();
    repository.startCandidate();
    repository.write("test/candidate.test.ts", "if (true) {}\n");
    const candidate = repository.commit("candidate adds a conditional");
    repository.cloneBase();

    expect(await conditionalGrowthViolations(load(base, candidate))).toEqual([
      "test/candidate.test.ts: 1 if statement(s), up from 0",
    ]);
  });

  it("uses shallow history when the merge base is nearby", async () => {
    repository.appendHistory(2048);
    repository.git(repository.origin, "branch", "-f", "candidate", "main");
    const base = repository.reduceBase();
    repository.startCandidate();
    repository.write("src/candidate.ts", "export const accepted = true;\n");
    const candidate = repository.commit("candidate change");
    repository.cloneBase("shallow");

    const diff = load(base, candidate);

    expect(diff.files).toEqual([{ filename: "src/candidate.ts", status: "added" }]);
    expect(await diff.readHead([BUDGET])).toEqual(await diff.readBase([BUDGET]));
    expect(repository.git(repository.checkout, "rev-parse", "--is-shallow-repository")).toBe(
      "true",
    );
    expect(Number(repository.git(repository.checkout, "rev-list", "--count", "HEAD"))).toBeLessThan(
      64,
    );
    expect(
      Number(repository.git(repository.checkout, "rev-list", "--count", candidate)),
    ).toBeLessThan(64);
    expect(repository.git(repository.checkout, "rev-parse", "HEAD")).toBe(base);
    expect(repository.git(repository.checkout, "status", "--porcelain=v1")).toBe("");
  });

  it("deepens history when the merge base is beyond the shallow fetch", () => {
    repository.appendHistory(64);
    const base = repository.reduceBase();
    repository.startCandidate();
    repository.write("src/candidate.ts", "export const accepted = true;\n");
    const candidate = repository.commit("candidate change");
    repository.cloneBase("shallow");

    expect(load(base, candidate).files).toEqual([
      { filename: "src/candidate.ts", status: "added" },
    ]);
    expect(
      Number(repository.git(repository.checkout, "rev-list", "--count", "HEAD")),
    ).toBeGreaterThan(32);
    expect(repository.git(repository.checkout, "rev-parse", "HEAD")).toBe(base);
    expect(repository.git(repository.checkout, "status", "--porcelain=v1")).toBe("");
  });

  it("rejects a merge base outside the history bound without changing the checkout", () => {
    repository.reduceBase();
    const base = repository.appendHistory(2048);
    repository.startCandidate();
    repository.write("candidate.txt", "candidate\n");
    const candidate = repository.commit("candidate change");
    repository.cloneBase("shallow");

    expect(() => load(base, candidate)).toThrow(/PR #1.*merge tree/);
    expect(repository.git(repository.checkout, "rev-parse", "--is-shallow-repository")).toBe(
      "true",
    );
    expect(repository.git(repository.checkout, "rev-parse", "HEAD")).toBe(base);
    expect(repository.git(repository.checkout, "status", "--porcelain=v1")).toBe("");
  });

  it("identifies a failed trusted-base history fetch without changing the checkout", () => {
    const base = repository.reduceBase();
    repository.cloneBase("shallow");
    repository.git(repository.checkout, "remote", "set-url", "origin", "./missing-origin");

    expect(() => load(base, repository.ancestor)).toThrow(/PR #1.*trusted-base history fetch/);
    expect(repository.git(repository.checkout, "rev-parse", "HEAD")).toBe(base);
    expect(repository.git(repository.checkout, "status", "--porcelain=v1")).toBe("");
  });

  it("identifies a failed PR commit fetch without changing the checkout", () => {
    const base = repository.reduceBase();
    repository.cloneBase("shallow");
    repository.git(repository.origin, "config", "uploadpack.hideRefs", "refs/pull");

    expect(() => load(base, repository.ancestor)).toThrow(/PR #1.*PR commit fetch/);
    expect(repository.git(repository.checkout, "rev-parse", "HEAD")).toBe(base);
    expect(repository.git(repository.checkout, "status", "--porcelain=v1")).toBe("");
  });

  it("rejects a candidate budget increase and its own approval policy", async () => {
    const base = repository.git(repository.origin, "rev-parse", "HEAD");
    repository.startCandidate();
    repository.write(BUDGET, e2eAssertionBudget(3));
    repository.write(
      POLICY,
      JSON.stringify({
        schemaVersion: 1,
        exceptions: [
          {
            pullRequest: 1,
            changeSha256: e2eBudgetChangeDigest(e2eAssertionBudget(2), e2eAssertionBudget(3)),
          },
        ],
      }),
    );
    const candidate = repository.commit("candidate tries to authorize budget growth");
    repository.cloneBase();
    const diff = load(base, candidate);

    expect(diff.exceptionPolicySource).toBe("base");
    expect(await diff.readBase([POLICY])).toEqual(
      new Map([[POLICY, JSON.stringify({ schemaVersion: 1, exceptions: [] })]]),
    );
    expect(await e2eAssertionBudgetGrowthViolations(diff)).toContain(
      "direct.expectCalls increased from 2 to 3",
    );
  });

  it("rejects a changed pull reference", () => {
    const base = repository.reduceBase();
    repository.startCandidate();
    repository.write("candidate.txt", "candidate\n");
    const candidate = repository.commit("candidate change");
    repository.cloneBase();
    repository.git(repository.origin, "update-ref", "refs/pull/1/head", base);

    expect(() => load(base, candidate)).toThrow("Fetched PR head does not match HEAD_SHA");
  });

  it("rejects a merge conflict without changing the trusted checkout", () => {
    const base = repository.reduceBase();
    repository.startCandidate();
    repository.write(RETAINED_TEST, "// conflicting candidate edit\n");
    const candidate = repository.commit("candidate conflict");
    repository.cloneBase();

    expect(() => load(base, candidate)).toThrow(/PR #1.*merge tree construction/);
    expect(repository.git(repository.checkout, "rev-parse", "HEAD")).toBe(base);
    expect(repository.git(repository.checkout, "status", "--porcelain=v1")).toBe("");
  });

  it("rejects unrelated histories", () => {
    const base = repository.reduceBase();
    repository.git(repository.origin, "checkout", "--orphan", "unrelated");
    repository.git(repository.origin, "rm", "-rf", ".");
    repository.write("unrelated.txt", "unrelated\n");
    const candidate = repository.commit("unrelated root");
    repository.git(repository.origin, "branch", "-f", "candidate", candidate);
    repository.cloneBase();

    expect(() => load(base, candidate)).toThrow(/PR #1.*merge tree construction/);
  });

  it.each([
    ["PR_NUMBER", "-1", "PR_NUMBER must be a positive integer"],
    ["BASE_SHA", "--help", "BASE_SHA must be a full commit SHA"],
    ["HEAD_SHA", "main", "HEAD_SHA must be a full commit SHA"],
  ])("rejects malformed %s before fetching", (name, value, message) => {
    const base = repository.reduceBase();
    repository.cloneBase();
    load(base, repository.ancestor);
    vi.stubEnv(name, value);

    expect(() => testOnly.loadPullRequestDiff(repository.checkout)).toThrow(message);
  });
});
