// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  assertLatestPullCommit,
  buildCompletionComment,
} from "../../../tools/pr-review-advisor/completion-comment.mts";

const RUN_URL = "https://github.com/NVIDIA/NemoClaw/actions/runs/123";
const RUNS_URL = "https://github.com/NVIDIA/NemoClaw/actions/workflows/pr-review-advisor.yaml";
const COMMIT_SHA = "abcdef1234567890abcdef1234567890abcdef12";

describe("PR review advisor completion comment", () => {
  it("links the commit review and all previous workflow runs", () => {
    expect(buildCompletionComment(RUN_URL, COMMIT_SHA, RUNS_URL)).toBe(
      "<!-- nemoclaw-pr-review-advisor -->\n" +
        "PR review advisory complete for commit `abcdef1`: " +
        "[read the full review](https://github.com/NVIDIA/NemoClaw/actions/runs/123). " +
        "Read it before deciding whether to request changes, approve, or merge this PR.\n\n" +
        "[All previous runs](https://github.com/NVIDIA/NemoClaw/actions/workflows/pr-review-advisor.yaml)\n",
    );
  });

  it.each([
    "http://github.com/NVIDIA/NemoClaw/actions/runs/123",
    "https://example.invalid/NVIDIA/NemoClaw/actions/runs/123",
  ])("rejects an untrusted workflow URL [%s]", (url) => {
    expect(() => buildCompletionComment(url, COMMIT_SHA, RUNS_URL)).toThrow(
      "PR review advisor run URL must be an HTTPS github.com URL",
    );
  });

  it("accepts only the latest PR commit before publication", async () => {
    const readPull = async (): Promise<{ head: { sha: string } }> => ({
      head: { sha: COMMIT_SHA },
    });
    await expect(
      assertLatestPullCommit("NVIDIA/NemoClaw", "10303", COMMIT_SHA, "token", readPull),
    ).resolves.toBeUndefined();
  });

  it("rejects a stale workflow run before publication", async () => {
    const latestSha = "1234567890abcdef1234567890abcdef12345678";
    const readPull = async (): Promise<{ head: { sha: string } }> => ({ head: { sha: latestSha } });
    await expect(
      assertLatestPullCommit("NVIDIA/NemoClaw", "10303", COMMIT_SHA, "token", readPull),
    ).rejects.toThrow(`latest PR commit is ${latestSha}`);
  });

  it("rejects an invalid commit SHA", () => {
    expect(() => buildCompletionComment(RUN_URL, "abc123", RUNS_URL)).toThrow(
      "commit SHA must contain 40 lowercase hexadecimal characters",
    );
  });

  it("rejects an unsafe sticky-comment marker", () => {
    expect(() => buildCompletionComment(RUN_URL, COMMIT_SHA, RUNS_URL, "<!-- other -->")).toThrow(
      "marker must be a safe",
    );
  });
});
