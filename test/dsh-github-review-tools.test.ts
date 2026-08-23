// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let replyAndResolveReviewThread: (input: any) => Promise<any>;
let runGitHubCli: (input: any) => Promise<any>;
let prepareIsolatedPrWorktree: (input: any) => Promise<any>;
let removeIsolatedPrWorktrees: (input: any) => Promise<any>;
const fixtureRoots: string[] = [];

beforeAll(async () => {
  const load = async (tool: string) => {
    const moduleUrl = pathToFileURL(path.resolve(".dsh", "tools", tool, "index.ts")).href;
    return import(/* @vite-ignore */ moduleUrl);
  };
  replyAndResolveReviewThread = (await load("reply_and_resolve_pr_review_thread")).default;
  runGitHubCli = (await load("run_github_cli")).default;
  prepareIsolatedPrWorktree = (await load("prepare_isolated_pr_worktree")).default;
  removeIsolatedPrWorktrees = (await load("remove_isolated_pr_worktrees")).default;
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
  for (const root of fixtureRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function symlinkedWorktreeFixture(kind: "root" | "intermediate") {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dsh-worktree-"));
  fixtureRoots.push(fixture);
  const outside = path.join(fixture, "outside");
  fs.mkdirSync(outside);
  const isolationKey = "session";
  const root = path.join(fixture, "root");
  const target = {
    root: () => {
      fs.symlinkSync(outside, root, "dir");
      return path.join(root, isolationKey, "1");
    },
    intermediate: () => {
      fs.mkdirSync(path.join(root, isolationKey), { recursive: true });
      const redirected = path.join(root, isolationKey, "redirected");
      fs.symlinkSync(outside, redirected, "dir");
      return path.join(redirected, "1");
    },
  }[kind]();
  return { fixture, isolationKey, root, target };
}

function shellBashSpy() {
  return vi.fn(async ({ command, workdir }: { command: string; workdir: string }) => {
    const result = spawnSync("bash", ["-c", command], { cwd: workdir, encoding: "utf8" });
    return {
      kind: "foreground",
      exitCode: result.status ?? 1,
      stdout: { text: result.stdout ?? "", truncated: false },
      stderr: { text: result.stderr ?? "", truncated: false },
    };
  });
}

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

describe("isolated worktree namespace guards", () => {
  it("allows a canonical missing namespace during preparation planning", async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dsh-worktree-"));
    fixtureRoots.push(fixture);
    const root = path.join(fixture, "root");
    const target = path.join(root, "session", "1");
    const bash = shellBashSpy();
    vi.stubGlobal("tools", {
      bash,
      read_git_checkout: vi.fn().mockResolvedValue({ clean: true }),
      read_nemoclaw_pr: vi.fn().mockResolvedValue({
        number: 1,
        url: "https://github.com/NVIDIA/NemoClaw/pull/1",
        state: "OPEN",
        isDraft: false,
        headRefOid: HEAD_SHA,
        baseRefName: "main",
      }),
      run_github_cli: vi.fn().mockResolvedValue({
        stdout: JSON.stringify({
          number: 1,
          url: "https://github.com/NVIDIA/NemoClaw/pull/1",
          state: "OPEN",
          isDraft: false,
          headRefOid: HEAD_SHA,
          baseRefOid: "b".repeat(40),
          baseRefName: "main",
          headRefName: "feature",
          headRepository: { nameWithOwner: "NVIDIA/NemoClaw" },
          headRepositoryOwner: { login: "NVIDIA" },
          maintainerCanModify: true,
        }),
      }),
    });

    await expect(
      prepareIsolatedPrWorktree({
        workdir: fixture,
        number: 1,
        root,
        path: target,
        isolationKey: "session",
      }),
    ).resolves.toMatchObject({ action: "planned", dryRun: true, path: "1" });
  });

  it.each(["root", "intermediate"] as const)(
    "rejects a symlinked %s path before worktree preparation",
    async (kind) => {
      const fixture = symlinkedWorktreeFixture(kind);
      const bash = shellBashSpy();
      vi.stubGlobal("tools", { bash });

      await expect(
        prepareIsolatedPrWorktree({
          workdir: fixture.fixture,
          number: 1,
          root: fixture.root,
          path: fixture.target,
          isolationKey: fixture.isolationKey,
          dryRun: false,
          apply: true,
        }),
      ).rejects.toThrow("symlinked path component");
      expect(bash.mock.calls.some(([call]) => call.command.includes("git worktree"))).toBe(false);
    },
  );

  it.each(["root", "intermediate"] as const)(
    "rejects a symlinked %s path before worktree cleanup",
    async (kind) => {
      const fixture = symlinkedWorktreeFixture(kind);
      const bash = shellBashSpy();
      vi.stubGlobal("tools", { bash });

      await expect(
        removeIsolatedPrWorktrees({
          workdir: fixture.fixture,
          paths: [fixture.target],
          root: fixture.root,
          isolationKey: fixture.isolationKey,
          dryRun: false,
          apply: true,
        }),
      ).rejects.toThrow("symlinked path component");
      expect(bash.mock.calls.some(([call]) => call.command.includes("git worktree"))).toBe(false);
    },
  );
});
