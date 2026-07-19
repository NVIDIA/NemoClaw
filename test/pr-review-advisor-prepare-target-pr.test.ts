// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PrepareTargetPrError,
  prepareTargetPr,
  validatePrepareTargetPrInput,
} from "../tools/pr-review-advisor/prepare-target-pr.mts";

const REPO = "NVIDIA/NemoClaw";
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prepare-target-pr-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type GitCall = string[];

function harness(shas: { base?: string; head?: string } = {}) {
  const gitCalls: GitCall[] = [];
  const env: Array<[string, string]> = [];
  const commandOutputs = new Map([
    [["rev-parse", "refs/remotes/target/base"].join("\0"), shas.base ?? ""],
    [["rev-parse", "HEAD"].join("\0"), shas.head ?? ""],
  ]);
  const runGit = (args: string[]): string => {
    gitCalls.push(args);
    return commandOutputs.get(args.slice(-2).join("\0")) ?? "";
  };
  const appendEnv = (key: string, value: string): void => {
    env.push([key, value]);
  };
  return { gitCalls, env, options: { targetDir: tempDir(), runGit, appendEnv } };
}

describe("validatePrepareTargetPrInput", () => {
  const base = { targetRepo: REPO, targetPr: "42", targetBase: "main" };

  it("accepts a well-formed input", () => {
    expect(() => validatePrepareTargetPrInput(base)).not.toThrow();
  });

  it.each([
    ["repo with spaces", { ...base, targetRepo: "NVIDIA / NemoClaw" }, /target_repo/u],
    ["repo missing slash", { ...base, targetRepo: "NemoClaw" }, /target_repo/u],
    ["non-numeric pr", { ...base, targetPr: "42x" }, /target_pr/u],
    ["base starting with dash", { ...base, targetBase: "-oops" }, /target_base/u],
    ["base with dot-dot", { ...base, targetBase: "a..b" }, /target_base/u],
    ["base with colon", { ...base, targetBase: "a:b" }, /target_base/u],
    ["base with space", { ...base, targetBase: "a b" }, /target_base/u],
    ["base absolute", { ...base, targetBase: "/etc" }, /target_base/u],
    ["short base sha", { ...base, prBaseSha: "abc" }, /base SHA/u],
    ["short head sha", { ...base, expectedHeadSha: "abc" }, /head SHA/u],
  ])("rejects %s", (_label, input, pattern) => {
    expect(() => validatePrepareTargetPrInput(input)).toThrow(PrepareTargetPrError);
    expect(() => validatePrepareTargetPrInput(input)).toThrow(pattern);
  });
});

describe("prepareTargetPr", () => {
  it("fetches, verifies SHAs, and exports env on the pull_request_target path", () => {
    const { gitCalls, env, options } = harness({ base: BASE_SHA, head: HEAD_SHA });

    const result = prepareTargetPr(
      {
        targetRepo: REPO,
        targetPr: "42",
        targetBase: "main",
        prBaseSha: BASE_SHA,
        expectedHeadSha: HEAD_SHA,
      },
      options,
    );

    expect(result).toEqual({ workdir: options.targetDir, prNumber: "42" });
    // base fetch uses the immutable SHA, not the branch ref, when provided.
    const flat = gitCalls.map((c) => c.join(" "));
    expect(flat).toContain(`-C ${options.targetDir} config core.hooksPath /dev/null`);
    expect(flat).toContain(`-C ${options.targetDir} config submodule.recurse false`);
    expect(flat.some((c) => c.includes(`${BASE_SHA}:refs/remotes/target/base`))).toBe(true);
    expect(flat.some((c) => c.includes("refs/pull/42/head:refs/remotes/target/pr-42"))).toBe(true);
    expect(flat.some((c) => c.includes("checkout --detach refs/remotes/target/pr-42"))).toBe(true);
    expect(env).toEqual([
      ["ADVISOR_WORKDIR", options.targetDir],
      ["PR_NUMBER", "42"],
    ]);
  });

  it("fetches the base branch ref on the dispatch path (no event SHAs)", () => {
    const { gitCalls, options } = harness();

    prepareTargetPr({ targetRepo: REPO, targetPr: "7", targetBase: "release/1.0" }, options);

    const flat = gitCalls.map((c) => c.join(" "));
    expect(flat.some((c) => c.includes("refs/heads/release/1.0:refs/remotes/target/base"))).toBe(
      true,
    );
    // no base-SHA verification query when the event carries no base SHA.
    expect(flat.some((c) => c.includes("rev-parse refs/remotes/target/base"))).toBe(false);
  });

  it("fails closed when the fetched base does not match the event base SHA", () => {
    const { options } = harness({ base: "c".repeat(40), head: HEAD_SHA });
    expect(() =>
      prepareTargetPr(
        {
          targetRepo: REPO,
          targetPr: "42",
          targetBase: "main",
          prBaseSha: BASE_SHA,
          expectedHeadSha: HEAD_SHA,
        },
        options,
      ),
    ).toThrow(/Fetched base does not match/u);
  });

  it("fails closed when the fetched head does not match the event head SHA", () => {
    const { options } = harness({ base: BASE_SHA, head: "d".repeat(40) });
    expect(() =>
      prepareTargetPr(
        {
          targetRepo: REPO,
          targetPr: "42",
          targetBase: "main",
          prBaseSha: BASE_SHA,
          expectedHeadSha: HEAD_SHA,
        },
        options,
      ),
    ).toThrow(/Fetched pull ref does not match/u);
  });

  it("validates before touching git", () => {
    const { gitCalls, options } = harness();
    expect(() =>
      prepareTargetPr({ targetRepo: "bad repo", targetPr: "1", targetBase: "main" }, options),
    ).toThrow(PrepareTargetPrError);
    expect(gitCalls.length).toBe(0);
  });
});
