// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let replyAndResolveReviewThread: (input: any) => Promise<any>;
let runGitHubCli: (input: any) => Promise<any>;

beforeAll(async () => {
  const load = async (tool: string) => {
    const moduleUrl = pathToFileURL(path.resolve(".dsh", "tools", tool, "index.ts")).href;
    return import(/* @vite-ignore */ moduleUrl);
  };
  replyAndResolveReviewThread = (await load("reply_and_resolve_pr_review_thread")).default;
  runGitHubCli = (await load("run_github_cli")).default;
});

const HEAD_SHA = "a".repeat(40);
const ORIGINAL_COMMENT = {
  id: "PRRC_original",
  databaseId: 101,
  body: "blocking finding",
  path: "src/example.ts",
  line: 10,
  url: "https://github.com/NVIDIA/NemoClaw/pull/1#discussion_r101",
  author: "reviewer",
};
const REPLY = {
  id: "PRRC_reply",
  databaseId: 202,
  body: "Fixed in the latest commit.",
  path: "src/example.ts",
  line: 10,
  url: "https://github.com/NVIDIA/NemoClaw/pull/1#discussion_r202",
  author: "author",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("run_github_cli", () => {
  it.each([
    [["api", "rate_limit", "-X", "GET", "-X", "POST"]],
    [["api", "rate_limit", "--method=GET", "--method", "POST"]],
    [["api", "rate_limit", "-XGET", "--method=POST"]],
  ])("rejects duplicate method options before execution", async (args) => {
    const bash = vi.fn();
    vi.stubGlobal("tools", { bash });

    await expect(runGitHubCli({ workdir: "/workspace", args, apply: false })).rejects.toThrow(
      "must not be specified more than once",
    );
    expect(bash).not.toHaveBeenCalled();
  });
});

describe("reply_and_resolve_pr_review_thread", () => {
  it("returns a durable reply after a resolve failure and reuses it on retry", async () => {
    const unresolvedWithoutReply = {
      pagesRead: 1,
      complete: true,
      total: 1,
      unresolved: 1,
      threads: [{ id: "PRRT_thread", isResolved: false, comments: [ORIGINAL_COMMENT] }],
    };
    const unresolvedWithReply = {
      ...unresolvedWithoutReply,
      threads: [{ id: "PRRT_thread", isResolved: false, comments: [ORIGINAL_COMMENT, REPLY] }],
    };
    const readNemoclawPr = vi.fn().mockResolvedValue({
      state: "OPEN",
      headRefOid: HEAD_SHA,
      url: "https://github.com/NVIDIA/NemoClaw/pull/1",
    });
    const readReviewThreads = vi
      .fn()
      .mockResolvedValueOnce(unresolvedWithoutReply)
      .mockResolvedValueOnce(unresolvedWithReply)
      .mockResolvedValueOnce(unresolvedWithReply);
    const runGithubCli = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "author\n" })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ id: 202, html_url: REPLY.url }) })
      .mockRejectedValueOnce(new Error("resolve temporarily unavailable"))
      .mockResolvedValueOnce({ stdout: "author\n" })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: { resolveReviewThread: { thread: { id: "PRRT_thread", isResolved: true } } },
        }),
      });
    vi.stubGlobal("tools", {
      read_nemoclaw_pr: readNemoclawPr,
      read_nemoclaw_review_threads: readReviewThreads,
      run_github_cli: runGithubCli,
    });
    const input = {
      number: 1,
      commentId: 101,
      body: REPLY.body,
      expectedHeadSha: HEAD_SHA,
      workdir: "/workspace",
      apply: true,
    };

    await expect(replyAndResolveReviewThread(input)).resolves.toMatchObject({
      mutated: true,
      replyCommentId: 202,
      replyUrl: REPLY.url,
      resolutionError: "resolve temporarily unavailable",
      resolved: false,
      wouldResolve: true,
    });
    await expect(replyAndResolveReviewThread(input)).resolves.toMatchObject({
      mutated: true,
      replyCommentId: 202,
      replyUrl: REPLY.url,
      resolutionError: null,
      resolved: true,
    });

    const replyCalls = runGithubCli.mock.calls.filter(([call]) =>
      call?.args?.some((arg: string) => arg.endsWith("/replies")),
    );
    expect(replyCalls).toHaveLength(1);
  });
});
