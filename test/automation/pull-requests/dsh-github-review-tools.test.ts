// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let replyAndResolveReviewThread: (input: any) => Promise<any>;
let approveNemoclawForkWorkflowRuns: (input: any) => Promise<any>;
let runGitHubCli: (input: any) => Promise<any>;
let prepareIsolatedPrWorktree: (input: any) => Promise<any>;
let removeIsolatedPrWorktrees: (input: any) => Promise<any>;
let runIndependentDocumentationWriterReview: (input: any) => Promise<any>;
let summarizeNemoclawPlanningItems: (input: any) => Promise<any>;
const fixtureRoots: string[] = [];

beforeAll(async () => {
  const load = async (tool: string) => {
    const moduleUrl = pathToFileURL(path.resolve(".dsh", "tools", tool, "index.ts")).href;
    return import(/* @vite-ignore */ moduleUrl);
  };
  replyAndResolveReviewThread = (await load("reply_and_resolve_pr_review_thread")).default;
  approveNemoclawForkWorkflowRuns = (await load("approve_nemoclaw_fork_workflow_runs")).default;
  runGitHubCli = (await load("run_github_cli")).default;
  prepareIsolatedPrWorktree = (await load("prepare_isolated_pr_worktree")).default;
  removeIsolatedPrWorktrees = (await load("remove_isolated_pr_worktrees")).default;
  runIndependentDocumentationWriterReview = (
    await load("run_independent_documentation_writer_review")
  ).default;
  summarizeNemoclawPlanningItems = (await load("summarize_nemoclaw_planning_items")).default;
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

function shellBashSpy(primaryRoot?: string) {
  return vi.fn(async ({ command, workdir }: { command: string; workdir: string }) => {
    const result =
      command === "git rev-parse --show-toplevel" && primaryRoot !== undefined
        ? { status: 0, stdout: primaryRoot + "\n", stderr: "" }
        : spawnSync("bash", ["-c", command], { cwd: workdir, encoding: "utf8" });
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

describe("remaining shared tool guards", () => {
  it.each([
    ["relevantPattern", { relevantPattern: 0 }],
    ["commentMarker", { commentMarker: 0 }],
  ])("rejects a non-string %s before reading GitHub", async (field, invalid) => {
    const runGithubCli = vi.fn();
    vi.stubGlobal("tools", { run_github_cli: runGithubCli });

    await expect(
      summarizeNemoclawPlanningItems({
        workdir: "/workspace",
        issues: [1],
        ...invalid,
      }),
    ).rejects.toThrow(field + " must be a string");
    expect(runGithubCli).not.toHaveBeenCalled();
  });

  it("does not allow a dirty checkout to bypass read-only review guards", async () => {
    const readGitCheckout = vi.fn();
    vi.stubGlobal("tools", { read_git_checkout: readGitCheckout });

    await expect(
      runIndependentDocumentationWriterReview({
        workdir: "/workspace",
        expectedHeadSha: HEAD_SHA,
        summary: "Review documentation impact",
        validationEvidence: "Focused checks passed",
        requireClean: false,
        apply: true,
      }),
    ).rejects.toThrow("requireClean must be true when provided");
    expect(readGitCheckout).not.toHaveBeenCalled();
  });

  it("rejects a worktree identity change after documentation review", async () => {
    const baseSha = "b".repeat(40);
    const agentsBlobSha = "c".repeat(40);
    const outputs: Record<string, string> = {
      "Verify documentation review refs": baseSha + "\n" + agentsBlobSha + "\n",
      "List documentation review files": Buffer.from("docs/example.md\0").toString("base64"),
      "Measure documentation review diff": "100\n",
    };
    const bash = vi.fn(async ({ description }: { description: string }) => ({
      kind: "foreground",
      exitCode: 0,
      stdout: { text: outputs[description] ?? "", truncated: false },
      stderr: { text: "", truncated: false },
    }));
    const readGitCheckout = vi
      .fn()
      .mockResolvedValueOnce({
        rootPresent: true,
        head: HEAD_SHA,
        clean: true,
        statusFingerprint: "before",
      })
      .mockResolvedValueOnce({ head: HEAD_SHA, clean: false, statusFingerprint: "after" });
    const subagent = vi.fn().mockResolvedValue({ kind: "foreground", output: [] });
    vi.stubGlobal("tools", { bash, read_git_checkout: readGitCheckout, subagent });

    await expect(
      runIndependentDocumentationWriterReview({
        workdir: "/workspace",
        expectedHeadSha: HEAD_SHA,
        summary: "Review documentation impact",
        validationEvidence: "Focused checks passed",
        apply: true,
      }),
    ).rejects.toThrow("read-only documentation review changed the worktree");
    expect(subagent).toHaveBeenCalledOnce();
  });
});

describe("approve_nemoclaw_fork_workflow_runs", () => {
  const workflow = ".github/workflows/ci.yml";
  const action = ".github/actions/setup/action.yml";
  const script = "scripts/setup.sh";
  const pull = (headRefOid = HEAD_SHA) => ({
    number: 1,
    url: "https://github.com/NVIDIA/NemoClaw/pull/1",
    state: "OPEN",
    isDraft: false,
    headRefOid,
    baseRefName: "main",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
  });
  const forkDetails = (changedFiles: number) => ({
    number: 1,
    isCrossRepository: true,
    maintainerCanModify: true,
    changedFiles,
  });
  const actionRequiredRun = {
    databaseId: 10,
    workflowName: "CI",
    event: "pull_request",
    status: "completed",
    conclusion: "action_required",
    url: "https://github.com/NVIDIA/NemoClaw/actions/runs/10",
    headSha: HEAD_SHA,
  };

  function forkApprovalTools(files: string[], pullReads = [pull()]) {
    const readNemoclawPr = vi.fn();
    pullReads.forEach((value) => readNemoclawPr.mockResolvedValueOnce(value));
    const readGithubPages = vi.fn().mockResolvedValue({
      items: files.map((filename) => ({ filename })),
      pagesRead: 1,
      truncated: false,
    });
    const runGithubCli = vi.fn(async ({ args }: { args: string[] }) => {
      const responses: Record<string, { stdout: string }> = {
        pr: { stdout: JSON.stringify(forkDetails(files.length)) },
        run: { stdout: JSON.stringify([actionRequiredRun]) },
        api: { stdout: "" },
      };
      return responses[args[0]] ?? Promise.reject(new Error("unexpected GitHub CLI call"));
    });
    vi.stubGlobal("tools", {
      read_nemoclaw_pr: readNemoclawPr,
      read_github_pages: readGithubPages,
      run_github_cli: runGithubCli,
    });
    return { readNemoclawPr, readGithubPages, runGithubCli };
  }

  it("rejects a changed local action that is absent from the reviewed file scope", async () => {
    const github = forkApprovalTools([action, script]);

    await expect(
      approveNemoclawForkWorkflowRuns({
        items: [{ number: 1, expectedHeadSha: HEAD_SHA, reviewedFiles: [script] }],
        workdir: "/workspace",
        apply: true,
      }),
    ).rejects.toThrow("reviewedFiles must exactly match all changed files");
    expect(github.runGithubCli.mock.calls.some(([call]) => call.args.includes("POST"))).toBe(false);
  });

  it("rejects mixed workflow and script changes without the complete reviewed scope", async () => {
    const github = forkApprovalTools([workflow, script]);

    await expect(
      approveNemoclawForkWorkflowRuns({
        items: [{ number: 1, expectedHeadSha: HEAD_SHA, reviewedFiles: [workflow] }],
        workdir: "/workspace",
        apply: true,
      }),
    ).rejects.toThrow("reviewedFiles must exactly match all changed files");
    expect(github.runGithubCli.mock.calls.some(([call]) => call.args.includes("POST"))).toBe(false);
  });

  it("accepts a commit-bound reviewed scope that contains every changed file", async () => {
    forkApprovalTools([workflow, action, script]);

    await expect(
      approveNemoclawForkWorkflowRuns({
        items: [
          {
            number: 1,
            expectedHeadSha: HEAD_SHA,
            reviewedFiles: [workflow, action, script],
          },
        ],
        workdir: "/workspace",
        apply: false,
      }),
    ).resolves.toMatchObject({
      apply: false,
      mutated: false,
      actionRequiredRuns: 1,
      prs: [{ headSha: HEAD_SHA, runs: [{ id: 10, action: "would-approve" }] }],
    });
  });

  it("rejects a changed PR commit before workflow approval", async () => {
    const changedSha = "d".repeat(40);
    const github = forkApprovalTools([script], [pull(), pull(changedSha)]);

    await expect(
      approveNemoclawForkWorkflowRuns({
        items: [{ number: 1, expectedHeadSha: HEAD_SHA, reviewedFiles: [script] }],
        workdir: "/workspace",
        apply: true,
      }),
    ).rejects.toThrow(`commit changed: expected ${HEAD_SHA}, found ${changedSha}`);
    expect(github.readNemoclawPr).toHaveBeenCalledTimes(2);
    expect(github.runGithubCli.mock.calls.some(([call]) => call.args.includes("POST"))).toBe(false);
  });
});

describe("isolated worktree namespace guards", () => {
  it("allows a canonical missing namespace during preparation planning", async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dsh-worktree-"));
    fixtureRoots.push(fixture);
    const primary = path.join(fixture, "checkout");
    fs.mkdirSync(primary);
    const root = path.join(fixture, "root");
    const target = path.join(root, "session", "1");
    const bash = shellBashSpy(primary);
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
        workdir: primary,
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
      const bash = shellBashSpy(path.join(fixture.fixture, "primary"));
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
      const bash = shellBashSpy(path.join(fixture.fixture, "primary"));
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

  it("rejects a preparation root inside the primary checkout before mutation", async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dsh-worktree-"));
    fixtureRoots.push(fixture);
    const primary = path.join(fixture, "checkout");
    fs.mkdirSync(primary);
    const root = path.join(primary, "isolated");
    const target = path.join(root, "session", "1");
    const bash = shellBashSpy(primary);
    vi.stubGlobal("tools", { bash });

    await expect(
      prepareIsolatedPrWorktree({
        workdir: primary,
        number: 1,
        root,
        path: target,
        isolationKey: "session",
        dryRun: false,
        apply: true,
      }),
    ).rejects.toThrow("outside the primary checkout");
    expect(bash.mock.calls.some(([call]) => call.command.includes("mkdir -p"))).toBe(false);
    expect(bash.mock.calls.some(([call]) => call.command.includes("git worktree"))).toBe(false);
  });

  it("rejects a cleanup root inside the primary checkout before worktree inspection", async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dsh-worktree-"));
    fixtureRoots.push(fixture);
    const primary = path.join(fixture, "checkout");
    fs.mkdirSync(primary);
    const root = path.join(primary, "isolated");
    const target = path.join(root, "session", "1");
    const bash = shellBashSpy(primary);
    vi.stubGlobal("tools", { bash });

    await expect(
      removeIsolatedPrWorktrees({
        workdir: primary,
        paths: [target],
        root,
        isolationKey: "session",
        dryRun: false,
        apply: true,
      }),
    ).rejects.toThrow("outside the primary checkout");
    expect(bash.mock.calls.some(([call]) => call.command.includes("mkdir -p"))).toBe(false);
    expect(bash.mock.calls.some(([call]) => call.command.includes("git worktree"))).toBe(false);
  });
});
