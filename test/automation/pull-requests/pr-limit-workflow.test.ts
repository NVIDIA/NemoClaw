// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { readRepoText, readYaml, type Workflow } from "../../helpers/e2e-workflow-contract";

const workflow = readYaml<Workflow>(".github/workflows/pr-limit.yaml");
const script = workflow.jobs["check-pr-limit"].steps?.[0].with?.script;
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...parameters: string[]
) => (...args: unknown[]) => Promise<unknown>;

function createHarness(policy: unknown, author = "contributor", openCount = 6) {
  const getContent = vi.fn().mockResolvedValue({
    data: {
      type: "file",
      content: Buffer.from(JSON.stringify(policy)).toString("base64"),
    },
  });
  const createComment = vi.fn().mockResolvedValue({});
  const update = vi.fn().mockResolvedValue({});
  const paginate = vi.fn().mockResolvedValue(
    Array.from({ length: openCount }, (_, index) => ({
      number: index + 1,
      pull_request: {},
    })),
  );
  const context = {
    repo: { owner: "NVIDIA", repo: "NemoClaw" },
    payload: {
      action: "opened",
      pull_request: { user: { login: author }, number: 100, base: { sha: "a".repeat(40) } },
    },
  };
  const core = { info: vi.fn(), setFailed: vi.fn() };
  const github = {
    paginate,
    rest: {
      repos: { getContent },
      issues: { createComment, listForRepo: vi.fn() },
      pulls: { update },
    },
  };
  return { context, core, createComment, getContent, github, paginate, update };
}

async function runScript(harness: ReturnType<typeof createHarness>): Promise<void> {
  expect(script).toEqual(expect.any(String));
  await new AsyncFunction("github", "context", "core", script as string)(
    harness.github,
    harness.context,
    harness.core,
  );
}

describe("open PR limit workflow", () => {
  it.each(["jason-ma-nv", "yanyunl1991", "laitingsheng", "yimoj"])(
    "exempts %s under the repository policy without counting or closing PRs",
    async (author) => {
      const harness = createHarness(JSON.parse(readRepoText(".github/pr-limits.json")), author);

      await runScript(harness);

      expect(harness.getContent).toHaveBeenCalledWith({
        ...harness.context.repo,
        path: ".github/pr-limits.json",
        ref: harness.context.payload.pull_request.base.sha,
      });
      expect(harness.paginate).not.toHaveBeenCalled();
      expect(harness.createComment).not.toHaveBeenCalled();
      expect(harness.update).not.toHaveBeenCalled();
      expect(harness.core.setFailed).not.toHaveBeenCalled();
    },
  );

  it("matches an unlimited account without regard to login case", async () => {
    const harness = createHarness({ contributor: "unlimited", "*": "5" }, "Contributor");

    await runScript(harness);

    expect(harness.paginate).not.toHaveBeenCalled();
    expect(harness.update).not.toHaveBeenCalled();
  });

  it.each([
    { author: "contributor", openCount: 5 },
    { author: "maintainer", openCount: 10 },
  ])("allows $author at the numeric cap of $openCount open PRs", async (testCase) => {
    const harness = createHarness(
      { exempt: "unlimited", maintainer: "10", "*": "5" },
      testCase.author,
      testCase.openCount,
    );

    await runScript(harness);

    expect(harness.paginate).toHaveBeenCalledTimes(1);
    expect(harness.createComment).not.toHaveBeenCalled();
    expect(harness.core.setFailed).not.toHaveBeenCalled();
    expect(harness.update).not.toHaveBeenCalled();
  });

  it.each([
    { author: "contributor", openCount: 6 },
    { author: "maintainer", openCount: 11 },
    { author: "blocked", openCount: 1 },
  ])("closes excess PRs for $author with $openCount open PRs", async (testCase) => {
    const harness = createHarness(
      { exempt: "unlimited", maintainer: "10", blocked: "0", "*": "5" },
      testCase.author,
      testCase.openCount,
    );

    await runScript(harness);

    expect(harness.paginate).toHaveBeenCalledTimes(1);
    expect(harness.createComment).toHaveBeenCalledTimes(1);
    expect(harness.core.setFailed).toHaveBeenCalledTimes(1);
    expect(harness.update).toHaveBeenCalledWith({
      ...harness.context.repo,
      pull_number: harness.context.payload.pull_request.number,
      state: "closed",
    });
  });

  it.each(["Unlimited", "Infinity", "-1", "01", "9007199254740992", 10, null])(
    "rejects invalid policy value %j before exempting an account",
    async (value) => {
      const harness = createHarness({ contributor: "unlimited", other: value, "*": "5" });

      await expect(runScript(harness)).rejects.toThrow("Invalid PR limit policy values");
      expect(harness.paginate).not.toHaveBeenCalled();
      expect(harness.createComment).not.toHaveBeenCalled();
      expect(harness.update).not.toHaveBeenCalled();
    },
  );
});
