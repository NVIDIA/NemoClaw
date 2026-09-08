// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { resolveGreenChecksGate } from "../../../tools/pr-review-advisor/green-checks-gate.mts";

const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const RUN_ID = 1234;
const RUN_ATTEMPT = 2;

function input() {
  return {
    repository: "NVIDIA/NemoClaw",
    sourceRunId: RUN_ID,
    sourceRunAttempt: RUN_ATTEMPT,
    sourcePath: ".github/workflows/pr.yaml",
    sourceEvent: "pull_request",
    sourceStatus: "completed",
    sourceConclusion: "success",
    sourceHeadSha: HEAD_SHA,
    sourceTitle: `CI PR #42 head ${HEAD_SHA} base ${BASE_SHA} gate true`,
  };
}

function request(options: { headSha?: string; baseSha?: string; checkConclusion?: string } = {}) {
  const responses = new Map<string, unknown>([
    [
      "repos/NVIDIA/NemoClaw/pulls/42",
      {
        number: 42,
        state: "open",
        head: { sha: options.headSha ?? HEAD_SHA },
        base: {
          ref: "main",
          sha: options.baseSha ?? BASE_SHA,
          repo: { full_name: "NVIDIA/NemoClaw" },
        },
      },
    ],
    [
      `repos/NVIDIA/NemoClaw/actions/runs/${RUN_ID}/attempts/${RUN_ATTEMPT}/jobs?per_page=100`,
      {
        total_count: 2,
        jobs: [
          { name: "changes", status: "completed", conclusion: "success", head_sha: HEAD_SHA },
          {
            name: "checks",
            status: "completed",
            conclusion: options.checkConclusion ?? "success",
            head_sha: HEAD_SHA,
          },
        ],
      },
    ],
  ]);
  return vi.fn(async (path: string) => responses.get(path));
}

describe("PR Review Advisor green checks gate", () => {
  it("accepts a green checks job for the current PR revision", async () => {
    const github = request();

    await expect(resolveGreenChecksGate(input(), "token", { request: github })).resolves.toEqual({
      repository: "NVIDIA/NemoClaw",
      prNumber: 42,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      baseRef: "main",
    });
    expect(github).toHaveBeenCalledTimes(2);
  });

  it("rejects a checks job that did not pass", async () => {
    await expect(
      resolveGreenChecksGate(input(), "token", {
        request: request({ checkConclusion: "failure" }),
      }),
    ).rejects.toThrow("checks job must pass");
  });

  it.each([
    ["head", { headSha: "c".repeat(40) }],
    ["base", { baseSha: "c".repeat(40) }],
  ])("rejects checks evidence after the PR %s changes", async (_case, changedRevision) => {
    await expect(
      resolveGreenChecksGate(input(), "token", {
        request: request(changedRevision),
      }),
    ).rejects.toThrow("does not match the current PR revision");
  });

  it.each([
    ["workflow path", { sourcePath: ".github/workflows/lookalike.yaml" }],
    ["workflow event", { sourceEvent: "workflow_dispatch" }],
    ["workflow conclusion", { sourceConclusion: "failure" }],
    [
      "metadata-only run",
      { sourceTitle: `CI PR #42 head ${HEAD_SHA} base ${BASE_SHA} gate false` },
    ],
    ["source head", { sourceHeadSha: "c".repeat(40) }],
  ])("rejects a source with an invalid %s", async (_case, replacement) => {
    await expect(
      resolveGreenChecksGate({ ...input(), ...replacement }, "token", { request: request() }),
    ).rejects.toThrow();
  });
});
