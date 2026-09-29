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
let publishNemoclawPrBranch: (input: any) => Promise<any>;
let createNemoclawPr: (input: any) => Promise<any>;
let commitPushRefreshPr: (input: any) => Promise<any>;
let prepareIsolatedPrWorktree: (input: any) => Promise<any>;
let removeIsolatedPrWorktrees: (input: any) => Promise<any>;
let runIndependentDocumentationWriterReview: (input: any) => Promise<any>;
let summarizeNemoclawPlanningItems: (input: any) => Promise<any>;
let collectPrFeedback: (input: any) => Promise<any>;
const fixtureRoots: string[] = [];

beforeAll(async () => {
  const load = async (tool: string) => {
    const moduleUrl = pathToFileURL(path.resolve(".dsh", "tools", tool, "index.ts")).href;
    return import(/* @vite-ignore */ moduleUrl);
  };
  replyAndResolveReviewThread = (await load("reply_and_resolve_pr_review_thread")).default;
  approveNemoclawForkWorkflowRuns = (await load("approve_nemoclaw_fork_workflow_runs")).default;
  runGitHubCli = (await load("run_github_cli")).default;
  publishNemoclawPrBranch = (await load("publish_nemoclaw_pr_branch")).default;
  createNemoclawPr = (await load("create_nemoclaw_pr")).default;
  commitPushRefreshPr = (await load("commit_push_refresh_pr")).default;
  prepareIsolatedPrWorktree = (await load("prepare_isolated_pr_worktree")).default;
  removeIsolatedPrWorktrees = (await load("remove_isolated_pr_worktrees")).default;
  runIndependentDocumentationWriterReview = (
    await load("run_independent_documentation_writer_review")
  ).default;
  summarizeNemoclawPlanningItems = (await load("summarize_nemoclaw_planning_items")).default;
  collectPrFeedback = (await load("collect_pr_feedback")).default;
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

describe("publish_nemoclaw_pr_branch guarded hook bypass", () => {
  const previousSha = "b".repeat(40);
  const baseSha = "c".repeat(40);
  const workflowBlobSha = "d7bbfae8fd59660ab146ef1cc52ce69964720146";
  const competingSha = "e".repeat(40);
  const branch = "feature";
  const title = "fix(skills): guard publication";
  const body = "Signed-off-by: Contributor <contributor@example.com>";
  const receipt = {
    schemaVersion: 1,
    candidateSha: HEAD_SHA,
    canonicalBaseSha: baseSha,
    workflowPath: ".github/workflows/pr-review-advisor.yaml",
    workflowBlobSha,
    workflowJob: "review-specialists",
    draftOnly: true,
    expectedRemoteSha: previousSha,
  };

  function publicationTools(
    pushOutcome: "success" | "race" | "same-candidate-race",
    branchState:
      | "existing"
      | "absent"
      | "candidate"
      | "candidate-draft"
      | "candidate-wrong-base" = "existing",
    observed = { baseSha, workflowBlobSha },
    validationSurfaceChanged = true,
  ) {
    const bash = vi.fn(
      async ({ command: _command, description }: { command: string; description: string }) => {
        const outputs: Record<string, string> = {
          "Verify guarded fallback workflow": observed.workflowBlobSha + "\n",
          "Read changed validation surface": validationSurfaceChanged
            ? ".pre-commit-config.yaml\0"
            : "",
          "Read publication push URLs": "git@github.com:NVIDIA/NemoClaw.git\n",
          "Read commit sign-off trailers": HEAD_SHA + "\tContributor <contributor@example.com>\n",
          "Count publication commits": "1\n",
          "List publication commits": HEAD_SHA + "\n",
          "Read publication branch before push":
            branchState === "absent"
              ? ""
              : (branchState.startsWith("candidate") ? HEAD_SHA : previousSha) +
                "\trefs/heads/" +
                branch +
                "\n",
          "Reconcile publication branch":
            (pushOutcome === "race" ? competingSha : HEAD_SHA) + "\trefs/heads/" + branch + "\n",
        };
        const pushFailed =
          description === "Push pull request candidate branch" && pushOutcome !== "success";
        return {
          kind: "foreground",
          exitCode: pushFailed ? 1 : 0,
          stdout: { text: outputs[description] ?? "", truncated: false },
          stderr: { text: pushFailed ? "stale info\n" : "", truncated: false },
        };
      },
    );
    const pull = {
      number: 1,
      url: "https://github.com/NVIDIA/NemoClaw/pull/1",
      title,
      body,
      assignees: [],
      isDraft: true,
      state: "OPEN",
      baseRefName: branchState === "candidate-wrong-base" ? "release" : "main",
      headRefName: branch,
      headRefOid: branchState.startsWith("candidate") ? HEAD_SHA : previousSha,
      headRepository: { nameWithOwner: "NVIDIA/NemoClaw" },
      headRepositoryOwner: { login: "NVIDIA" },
    };
    const runGithubCli = vi.fn(async ({ args }: { args: string[] }) => {
      const command = args[0] + " " + args[1];
      const key =
        args[0] === "api"
          ? args[1].includes("/git/ref/heads/")
            ? "api base"
            : "api commit"
          : command;
      const responses: Record<string, { stdout: string }> = {
        "repo view": { stdout: "main\n" },
        "pr list": {
          stdout: JSON.stringify(
            branchState === "existing" ||
              branchState === "candidate-draft" ||
              branchState === "candidate-wrong-base"
              ? [pull]
              : [],
          ),
        },
        "pr view": { stdout: JSON.stringify(pull) },
        "api base": { stdout: observed.baseSha + "\n" },
        "api commit": { stdout: "true\tverified\n" },
      };
      return responses[key] ?? Promise.reject(new Error("unexpected GitHub CLI call: " + command));
    });
    vi.stubGlobal("tools", {
      bash,
      project_diagnostic_text: vi.fn(async ({ lines }: { lines: string[] }) => ({
        text: lines.join("\n"),
      })),
      read_git_checkout: vi.fn().mockResolvedValue({ head: HEAD_SHA, clean: true, branch }),
      run_github_cli: runGithubCli,
      publish_nemoclaw_pr_branch: publishNemoclawPrBranch,
    });
    return { bash, runGithubCli };
  }

  it("uses an exact ref lease for an authorized hook-free update", async () => {
    const { bash } = publicationTools("success");

    await expect(
      publishNemoclawPrBranch({
        workdir: "/workspace",
        expectedHeadSha: HEAD_SHA,
        expectedPullHeadSha: previousSha,
        pullNumber: 1,
        hookBypassReceipt: receipt,
        apply: true,
      }),
    ).resolves.toMatchObject({ pushed: true, remoteState: "expected-commit", allVerified: true });

    const push = bash.mock.calls.find(
      ([call]) => call.description === "Push pull request candidate branch",
    )?.[0].command;
    expect(push).toContain("--no-verify");
    expect(push).toContain("--force-with-lease=refs/heads/" + branch + ":" + previousSha);
  });

  it("uses an absent-ref lease for authorized initial draft publication", async () => {
    const { bash } = publicationTools("success", "absent");

    await expect(
      publishNemoclawPrBranch({
        workdir: "/workspace",
        expectedHeadSha: HEAD_SHA,
        hookBypassReceipt: { ...receipt, expectedRemoteSha: null },
        apply: true,
      }),
    ).resolves.toMatchObject({ pushed: true, remoteState: "expected-commit", allVerified: true });

    const push = bash.mock.calls.find(
      ([call]) => call.description === "Push pull request candidate branch",
    )?.[0].command;
    expect(push).toContain("--force-with-lease=refs/heads/" + branch + ":");
  });

  it("rejects an existing candidate branch without proof of the guarded initial write", async () => {
    const { bash } = publicationTools("success", "candidate");

    await expect(
      publishNemoclawPrBranch({
        workdir: "/workspace",
        expectedHeadSha: HEAD_SHA,
        hookBypassReceipt: { ...receipt, expectedRemoteSha: null },
        apply: true,
      }),
    ).rejects.toThrow("Publication branch changed before guarded publication");
    expect(
      bash.mock.calls.filter(([call]) => call.description === "Push pull request candidate branch"),
    ).toHaveLength(0);
  });

  it("reconciles a completed exact draft publication without repeating the branch write", async () => {
    const { bash } = publicationTools("success", "candidate-draft");

    await expect(
      publishNemoclawPrBranch({
        workdir: "/workspace",
        expectedHeadSha: HEAD_SHA,
        hookBypassReceipt: { ...receipt, expectedRemoteSha: null },
        apply: true,
      }),
    ).resolves.toMatchObject({ pushed: false, mutated: false, allVerified: true });
    expect(
      bash.mock.calls.filter(([call]) => call.description === "Push pull request candidate branch"),
    ).toHaveLength(0);
  });

  it("rejects a candidate draft PR for a different base branch", async () => {
    const { bash } = publicationTools("success", "candidate-wrong-base");

    await expect(
      publishNemoclawPrBranch({
        workdir: "/workspace",
        expectedHeadSha: HEAD_SHA,
        hookBypassReceipt: { ...receipt, expectedRemoteSha: null },
        apply: true,
      }),
    ).rejects.toThrow("does not match this base, branch, and repository");
    expect(
      bash.mock.calls.filter(([call]) => call.description === "Push pull request candidate branch"),
    ).toHaveLength(0);
  });

  it("rejects a preseeded local receipt as proof of the guarded initial write", async () => {
    const { bash } = publicationTools("success", "candidate");

    await expect(
      publishNemoclawPrBranch({
        workdir: "/workspace",
        expectedHeadSha: HEAD_SHA,
        hookBypassReceipt: { ...receipt, expectedRemoteSha: null },
        apply: true,
      }),
    ).rejects.toThrow("Publication branch changed before guarded publication");
    expect(
      bash.mock.calls.filter(([call]) => call.description === "Push pull request candidate branch"),
    ).toHaveLength(0);
    expect(
      bash.mock.calls.filter(([call]) => call.command.includes("git config --local")),
    ).toHaveLength(0);
  });

  it.each([
    ["canonical base", { baseSha: competingSha, workflowBlobSha }, "no longer canonical"],
    ["workflow blob", { baseSha, workflowBlobSha: competingSha }, "does not match"],
  ])("rejects a changed guarded fallback %s", async (_label, observed, error) => {
    const { bash } = publicationTools("success", "absent", observed);

    await expect(
      publishNemoclawPrBranch({
        workdir: "/workspace",
        expectedHeadSha: HEAD_SHA,
        hookBypassReceipt: { ...receipt, expectedRemoteSha: null },
        apply: true,
      }),
    ).rejects.toThrow(error);
    expect(
      bash.mock.calls.filter(([call]) => call.description === "Push pull request candidate branch"),
    ).toHaveLength(0);
  });

  it("rejects hook-free publication when the trusted validation surface is unchanged", async () => {
    const { bash } = publicationTools("success", "absent", undefined, false);

    await expect(
      publishNemoclawPrBranch({
        workdir: "/workspace",
        expectedHeadSha: HEAD_SHA,
        hookBypassReceipt: { ...receipt, expectedRemoteSha: null },
        apply: true,
      }),
    ).rejects.toThrow("trusted validation surface is unchanged");
    expect(
      bash.mock.calls.filter(([call]) => call.description === "Push pull request candidate branch"),
    ).toHaveLength(0);
  });

  it("enumerates guarded commits from the receipt-bound canonical base", async () => {
    const { bash } = publicationTools("success");

    await publishNemoclawPrBranch({
      workdir: "/workspace",
      expectedHeadSha: HEAD_SHA,
      expectedPullHeadSha: previousSha,
      pullNumber: 1,
      hookBypassReceipt: receipt,
      apply: true,
    });

    const count = bash.mock.calls.find(
      ([call]) => call.description === "Count publication commits",
    )?.[0].command;
    const list = bash.mock.calls.find(
      ([call]) => call.description === "List publication commits",
    )?.[0].command;
    expect(count).toContain(baseSha + ".." + HEAD_SHA);
    expect(list).toContain(baseSha + ".." + HEAD_SHA);
    expect(count).not.toContain("origin/main");
    expect(list).not.toContain("origin/main");
  });

  it("creates one draft PR after guarded initial publication reconciliation", async () => {
    const publish = vi.fn().mockResolvedValue({
      mutated: false,
      pushed: false,
      remoteState: "expected-commit",
      allVerified: true,
      blocker: null,
      commits: [{ sha: HEAD_SHA, verified: true, reason: "valid" }],
      recoveredPullUrl: null,
    });
    const preparedPull = {
      url: "https://github.com/NVIDIA/NemoClaw/pull/1",
      isDraft: true,
      title,
      body,
      assignees: [],
      baseRefName: "main",
      headRefName: branch,
      headRefOid: HEAD_SHA,
      headRepository: { nameWithOwner: "NVIDIA/NemoClaw" },
      headRepositoryOwner: { login: "NVIDIA" },
    };
    let listReads = 0;
    const runGithubCli = vi.fn(async ({ args }: { args: string[] }) => {
      const responses: Record<string, { code?: number; stdout: string; stderr?: string }> = {
        create: {
          code: 0,
          stdout: preparedPull.url + "\n",
          stderr: "",
        },
        list: { stdout: JSON.stringify(listReads++ === 0 ? [] : [preparedPull]) },
      };
      return responses[args[1]] ?? Promise.reject(new Error("unexpected GitHub CLI call"));
    });
    vi.stubGlobal("tools", {
      bash: vi.fn().mockResolvedValue({
        kind: "foreground",
        exitCode: 0,
        stdout: { text: HEAD_SHA + "\tContributor <contributor@example.com>\n", truncated: false },
        stderr: { text: "", truncated: false },
      }),
      publish_nemoclaw_pr_branch: publish,
      read_git_checkout: vi.fn().mockResolvedValue({ head: HEAD_SHA, branch, clean: true }),
      run_github_cli: runGithubCli,
    });

    await expect(
      createNemoclawPr({
        title: "fix(skills): guard publication",
        body: "Signed-off-by: Contributor <contributor@example.com>",
        workdir: "/workspace",
        apply: true,
        draft: true,
        assignee: false,
        expectedHeadSha: HEAD_SHA,
        hookBypassReceipt: { ...receipt, expectedRemoteSha: null },
      }),
    ).resolves.toMatchObject({ ok: true, draft: true, url: expect.stringContaining("/pull/1") });
    expect(publish).toHaveBeenCalledOnce();
    expect(
      runGithubCli.mock.calls.filter(
        ([call]) => call.args[0] === "pr" && call.args[1] === "create",
      ),
    ).toHaveLength(1);
    expect(
      runGithubCli.mock.calls.find(
        ([call]) => call.args[0] === "pr" && call.args[1] === "create",
      )?.[0].args,
    ).toContain("--draft");
  });

  it("returns a recovered exact draft without another push or PR creation", async () => {
    const { bash, runGithubCli } = publicationTools("success", "candidate-draft");

    await expect(
      createNemoclawPr({
        title,
        body,
        workdir: "/workspace",
        apply: true,
        draft: true,
        assignee: false,
        expectedHeadSha: HEAD_SHA,
        hookBypassReceipt: { ...receipt, expectedRemoteSha: null },
      }),
    ).resolves.toMatchObject({
      ok: true,
      mutated: false,
      url: "https://github.com/NVIDIA/NemoClaw/pull/1",
    });
    expect(
      bash.mock.calls.filter(([call]) => call.description === "Push pull request candidate branch"),
    ).toHaveLength(0);
    expect(
      runGithubCli.mock.calls.filter(
        ([call]) => call.args[0] === "pr" && call.args[1] === "create",
      ),
    ).toHaveLength(0);
  });

  it.each([
    ["title", { title: "fix(skills): stale title" }],
    ["body", { body: body + "\nStale evidence" }],
    ["assignment", { assignees: [{ login: "someone-else" }] }],
  ])("rejects a recovered draft with mismatched %s", async (_field, mismatch) => {
    const publish = vi.fn().mockResolvedValue({
      mutated: false,
      pushed: false,
      remoteState: "expected-commit",
      allVerified: true,
      blocker: null,
      commits: [{ sha: HEAD_SHA, verified: true, reason: "valid" }],
      recoveredPullUrl: "https://github.com/NVIDIA/NemoClaw/pull/1",
    });
    const recoveredPull = {
      url: "https://github.com/NVIDIA/NemoClaw/pull/1",
      isDraft: true,
      title,
      body,
      assignees: [],
      baseRefName: "main",
      headRefName: branch,
      headRefOid: HEAD_SHA,
      headRepository: { nameWithOwner: "NVIDIA/NemoClaw" },
      headRepositoryOwner: { login: "NVIDIA" },
      ...mismatch,
    };
    const runGithubCli = vi.fn().mockResolvedValue({ stdout: JSON.stringify([recoveredPull]) });
    vi.stubGlobal("tools", {
      bash: vi.fn().mockResolvedValue({
        kind: "foreground",
        exitCode: 0,
        stdout: { text: HEAD_SHA + "\tContributor <contributor@example.com>\n", truncated: false },
        stderr: { text: "", truncated: false },
      }),
      publish_nemoclaw_pr_branch: publish,
      read_git_checkout: vi.fn().mockResolvedValue({ head: HEAD_SHA, branch, clean: true }),
      run_github_cli: runGithubCli,
    });

    await expect(
      createNemoclawPr({
        title,
        body,
        workdir: "/workspace",
        apply: true,
        draft: true,
        assignee: false,
        expectedHeadSha: HEAD_SHA,
        hookBypassReceipt: { ...receipt, expectedRemoteSha: null },
      }),
    ).rejects.toThrow("does not match every prepared publication field");
    expect(
      runGithubCli.mock.calls.filter(
        ([call]) => call.args[0] === "pr" && call.args[1] === "create",
      ),
    ).toHaveLength(0);
  });

  it("retries one inconclusive PR creation after fresh matching reads", async () => {
    const publish = vi.fn().mockResolvedValue({
      mutated: true,
      pushed: true,
      remoteState: "expected-commit",
      allVerified: true,
      blocker: null,
      commits: [{ sha: HEAD_SHA, verified: true, reason: "valid" }],
      recoveredPullUrl: null,
    });
    const preparedPull = {
      url: "https://github.com/NVIDIA/NemoClaw/pull/1",
      isDraft: true,
      title,
      body,
      assignees: [],
      baseRefName: "main",
      headRefName: branch,
      headRefOid: HEAD_SHA,
      headRepository: { nameWithOwner: "NVIDIA/NemoClaw" },
      headRepositoryOwner: { login: "NVIDIA" },
    };
    let creates = 0;
    let lists = 0;
    const runGithubCli = vi.fn(async ({ args }: { args: string[] }) =>
      args[1] === "create"
        ? ((creates += 1),
          creates === 1
            ? { code: 1, stdout: "", stderr: "creation response lost" }
            : { code: 0, stdout: preparedPull.url + "\n", stderr: "" })
        : args[1] === "list"
          ? ((lists += 1), { stdout: JSON.stringify(lists < 4 ? [] : [preparedPull]) })
          : Promise.reject(new Error("unexpected GitHub CLI call")),
    );
    const bash = vi.fn(async ({ description }: { description: string }) => ({
      kind: "foreground",
      exitCode: 0,
      stdout: {
        text:
          description === "Read commit sign-off trailers"
            ? HEAD_SHA + "\tContributor <contributor@example.com>\n"
            : HEAD_SHA + "\trefs/heads/" + branch + "\n",
        truncated: false,
      },
      stderr: { text: "", truncated: false },
    }));
    vi.stubGlobal("tools", {
      bash,
      publish_nemoclaw_pr_branch: publish,
      read_git_checkout: vi.fn().mockResolvedValue({ head: HEAD_SHA, branch, clean: true }),
      run_github_cli: runGithubCli,
    });

    await expect(
      createNemoclawPr({
        title,
        body,
        workdir: "/workspace",
        apply: true,
        draft: true,
        assignee: false,
        expectedHeadSha: HEAD_SHA,
        hookBypassReceipt: { ...receipt, expectedRemoteSha: null },
      }),
    ).resolves.toMatchObject({ ok: true, url: preparedPull.url });
    expect(creates).toBe(2);
    expect(lists).toBe(4);
  });

  it("does not retry an inconclusive PR creation after the remote branch changes", async () => {
    const publish = vi.fn().mockResolvedValue({
      mutated: true,
      pushed: true,
      remoteState: "expected-commit",
      allVerified: true,
      blocker: null,
      commits: [{ sha: HEAD_SHA, verified: true, reason: "valid" }],
      recoveredPullUrl: null,
    });
    const runGithubCli = vi.fn(async ({ args }: { args: string[] }) =>
      args[1] === "create"
        ? { code: 1, stdout: "", stderr: "creation response lost" }
        : { stdout: "[]" },
    );
    let remoteReads = 0;
    const bash = vi.fn(async ({ description }: { description: string }) => {
      const readsTrailer = description === "Read commit sign-off trailers";
      const remoteSha = remoteReads === 0 ? HEAD_SHA : competingSha;
      remoteReads += readsTrailer ? 0 : 1;
      return {
        kind: "foreground",
        exitCode: 0,
        stdout: {
          text: readsTrailer
            ? HEAD_SHA + "\tContributor <contributor@example.com>\n"
            : remoteSha + "\trefs/heads/" + branch + "\n",
          truncated: false,
        },
        stderr: { text: "", truncated: false },
      };
    });
    vi.stubGlobal("tools", {
      bash,
      publish_nemoclaw_pr_branch: publish,
      read_git_checkout: vi.fn().mockResolvedValue({ head: HEAD_SHA, branch, clean: true }),
      run_github_cli: runGithubCli,
    });

    await expect(
      createNemoclawPr({
        title,
        body,
        workdir: "/workspace",
        apply: true,
        draft: true,
        assignee: false,
        expectedHeadSha: HEAD_SHA,
        hookBypassReceipt: { ...receipt, expectedRemoteSha: null },
      }),
    ).rejects.toThrow("state changed before the guarded write");
    expect(
      runGithubCli.mock.calls.filter(
        ([call]) => call.args[0] === "pr" && call.args[1] === "create",
      ),
    ).toHaveLength(1);
  });

  it("rejects a successful creation response without the prepared PR state", async () => {
    const publish = vi.fn().mockResolvedValue({
      mutated: true,
      pushed: true,
      remoteState: "expected-commit",
      allVerified: true,
      blocker: null,
      commits: [{ sha: HEAD_SHA, verified: true, reason: "valid" }],
      recoveredPullUrl: null,
    });
    const runGithubCli = vi.fn(async ({ args }: { args: string[] }) => {
      const responses: Record<string, { code?: number; stdout: string; stderr?: string }> = {
        create: {
          code: 0,
          stdout: "https://github.com/NVIDIA/NemoClaw/pull/1\n",
          stderr: "",
        },
        list: { stdout: "[]" },
      };
      return responses[args[1]] ?? Promise.reject(new Error("unexpected GitHub CLI call"));
    });
    vi.stubGlobal("tools", {
      bash: vi.fn().mockResolvedValue({
        kind: "foreground",
        exitCode: 0,
        stdout: { text: HEAD_SHA + "\tContributor <contributor@example.com>\n", truncated: false },
        stderr: { text: "", truncated: false },
      }),
      publish_nemoclaw_pr_branch: publish,
      read_git_checkout: vi.fn().mockResolvedValue({ head: HEAD_SHA, branch, clean: true }),
      run_github_cli: runGithubCli,
    });

    await expect(
      createNemoclawPr({
        title: "fix(skills): guard publication",
        body: "Signed-off-by: Contributor <contributor@example.com>",
        workdir: "/workspace",
        apply: true,
        draft: true,
        assignee: false,
        expectedHeadSha: HEAD_SHA,
        hookBypassReceipt: { ...receipt, expectedRemoteSha: null },
      }),
    ).rejects.toThrow("reported success");
  });

  it("rejects a non-draft PR observed after an inconclusive draft creation", async () => {
    const publish = vi.fn().mockResolvedValue({
      mutated: true,
      pushed: true,
      remoteState: "expected-commit",
      allVerified: true,
      blocker: null,
      commits: [{ sha: HEAD_SHA, verified: true, reason: "valid" }],
    });
    let listReads = 0;
    const runGithubCli = vi.fn(async ({ args }: { args: string[] }) => {
      const responses: Record<string, { code?: number; stdout: string; stderr?: string }> = {
        create: { code: 1, stdout: "", stderr: "creation response lost" },
        list: {
          stdout: JSON.stringify(
            listReads++ === 0
              ? []
              : [
                  {
                    url: "https://github.com/NVIDIA/NemoClaw/pull/1",
                    isDraft: false,
                    headRefName: branch,
                    headRefOid: HEAD_SHA,
                    baseRefName: "main",
                    headRepository: { nameWithOwner: "NVIDIA/NemoClaw" },
                    headRepositoryOwner: { login: "NVIDIA" },
                  },
                ],
          ),
        },
      };
      return responses[args[1]] ?? Promise.reject(new Error("unexpected GitHub CLI call"));
    });
    vi.stubGlobal("tools", {
      bash: vi.fn().mockResolvedValue({
        kind: "foreground",
        exitCode: 0,
        stdout: { text: HEAD_SHA + "\tContributor <contributor@example.com>\n", truncated: false },
        stderr: { text: "", truncated: false },
      }),
      publish_nemoclaw_pr_branch: publish,
      read_git_checkout: vi.fn().mockResolvedValue({ head: HEAD_SHA, branch, clean: true }),
      run_github_cli: runGithubCli,
    });

    await expect(
      createNemoclawPr({
        title: "fix(skills): guard publication",
        body: "Signed-off-by: Contributor <contributor@example.com>",
        workdir: "/workspace",
        apply: true,
        draft: true,
        assignee: false,
        expectedHeadSha: HEAD_SHA,
        hookBypassReceipt: { ...receipt, expectedRemoteSha: null },
      }),
    ).rejects.toThrow("does not match the prepared draft publication");
  });

  it("forwards a newly bound fallback receipt for an open draft PR update", async () => {
    const nextSha = "f".repeat(40);
    let stagedReads = 0;
    const publish = vi.fn().mockResolvedValue({
      pushed: true,
      remoteState: "expected-commit",
      allVerified: true,
      headSha: nextSha,
      commits: [{ sha: nextSha, verified: true, reason: "valid" }],
      blocker: null,
    });
    const bash = vi.fn(async ({ description }: { command: string; description: string }) => ({
      kind: "foreground",
      exitCode: 0,
      stdout: {
        text:
          description === "Read staged paths"
            ? stagedReads++ === 0
              ? ""
              : "AGENTS.md\0"
            : description === "Record index state"
              ? "tree\n"
              : "",
        truncated: false,
      },
      stderr: { text: "", truncated: false },
    }));
    const pull = {
      headRefName: branch,
      headRefOid: previousSha,
      baseRefName: "main",
      url: "https://github.com/NVIDIA/NemoClaw/pull/1",
      title: "fix(skills): guard publication",
      state: "OPEN",
      isDraft: true,
    };
    vi.stubGlobal("tools", {
      bash,
      project_diagnostic_text: vi.fn(async ({ lines }: { lines: string[] }) => ({
        text: lines.join("\n"),
      })),
      read_git_checkout: vi
        .fn()
        .mockResolvedValueOnce({ head: previousSha })
        .mockResolvedValueOnce({ head: nextSha })
        .mockResolvedValueOnce({ head: nextSha, clean: true }),
      run_github_cli: vi.fn().mockResolvedValue({ stdout: JSON.stringify(pull) }),
      publish_nemoclaw_pr_branch: publish,
      read_nemoclaw_pr: vi.fn().mockResolvedValue({ state: "OPEN", headRefOid: nextSha }),
      summarize_pr_readiness: vi.fn().mockResolvedValue({ ready: false }),
    });

    await commitPushRefreshPr({
      workdir: "/workspace",
      pullNumber: 1,
      message: "fix(skills): repair guarded publication",
      files: ["AGENTS.md"],
      hookBypassReceipt: {
        schemaVersion: 1,
        canonicalBaseSha: baseSha,
        workflowPath: receipt.workflowPath,
        workflowBlobSha,
        workflowJob: receipt.workflowJob,
        draftOnly: true,
      },
      refreshBody: false,
      apply: true,
    });

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedHeadSha: nextSha,
        expectedPullHeadSha: previousSha,
        hookBypassReceipt: expect.objectContaining({
          candidateSha: nextSha,
          canonicalBaseSha: baseSha,
          expectedRemoteSha: previousSha,
          draftOnly: true,
        }),
      }),
    );
  });

  it("rejects a non-draft PR before forwarding an open-PR fallback receipt", async () => {
    const publish = vi.fn();
    vi.stubGlobal("tools", {
      run_github_cli: vi.fn().mockResolvedValue({
        stdout: JSON.stringify({
          headRefName: branch,
          headRefOid: previousSha,
          baseRefName: "main",
          state: "OPEN",
          isDraft: false,
        }),
      }),
    });

    await expect(
      commitPushRefreshPr({
        workdir: "/workspace",
        pullNumber: 1,
        message: "fix(skills): repair guarded publication",
        files: ["AGENTS.md"],
        hookBypassReceipt: {
          schemaVersion: 1,
          canonicalBaseSha: baseSha,
          workflowPath: receipt.workflowPath,
          workflowBlobSha,
          workflowJob: receipt.workflowJob,
          draftOnly: true,
        },
        refreshBody: false,
        apply: true,
      }),
    ).rejects.toThrow("Hook-free updates require a draft pull request");
    expect(publish).not.toHaveBeenCalled();
  });

  it("rejects a concurrent remote update at the atomic write boundary", async () => {
    const { bash } = publicationTools("race");

    await expect(
      publishNemoclawPrBranch({
        workdir: "/workspace",
        expectedHeadSha: HEAD_SHA,
        expectedPullHeadSha: previousSha,
        pullNumber: 1,
        hookBypassReceipt: receipt,
        apply: true,
      }),
    ).resolves.toMatchObject({ pushed: false, mutated: false, remoteState: "unknown" });
    expect(
      bash.mock.calls.filter(([call]) => call.description === "Push pull request candidate branch"),
    ).toHaveLength(1);
  });

  it("does not mint an initial receipt after a failed absent-ref write", async () => {
    const { bash } = publicationTools("same-candidate-race", "absent");

    await expect(
      publishNemoclawPrBranch({
        workdir: "/workspace",
        expectedHeadSha: HEAD_SHA,
        hookBypassReceipt: { ...receipt, expectedRemoteSha: null },
        apply: true,
      }),
    ).resolves.toMatchObject({
      pushed: false,
      mutated: false,
      remoteState: "unknown",
      allVerified: false,
    });
    expect(
      bash.mock.calls.filter(
        ([call]) => call.description === "Record guarded initial publication receipt",
      ),
    ).toHaveLength(0);
  });

  it("rejects an invalid candidate binding before any operation", async () => {
    const readGitCheckout = vi.fn();
    vi.stubGlobal("tools", { read_git_checkout: readGitCheckout });

    await expect(
      publishNemoclawPrBranch({
        workdir: "/workspace",
        expectedHeadSha: HEAD_SHA,
        hookBypassReceipt: { ...receipt, candidateSha: competingSha },
      }),
    ).rejects.toThrow("not a valid trusted fallback record");
    expect(readGitCheckout).not.toHaveBeenCalled();
  });

  it.each([
    ["job", { ...receipt, workflowJob: "publish" }],
    ["workflow blob", { ...receipt, workflowBlobSha: "d".repeat(40) }],
  ])("rejects an untrusted fallback %s before any operation", async (_label, invalidReceipt) => {
    const readGitCheckout = vi.fn();
    vi.stubGlobal("tools", { read_git_checkout: readGitCheckout });

    await expect(
      publishNemoclawPrBranch({
        workdir: "/workspace",
        expectedHeadSha: HEAD_SHA,
        hookBypassReceipt: invalidReceipt,
      }),
    ).rejects.toThrow("does not name a trusted fallback job");
    expect(readGitCheckout).not.toHaveBeenCalled();
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
    ).resolves.toMatchObject({
      action: "planned",
      dryRun: true,
      path: "1",
      absolutePath: target,
    });
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

describe("bounded PR feedback pagination", () => {
  it("treats ten full pages without a next link as complete", async () => {
    const pullResponse = {
      ok: true,
      code: 0,
      stdout: JSON.stringify({
        url: "https://github.com/NVIDIA/NemoClaw/pull/1",
        state: "OPEN",
        headRefOid: HEAD_SHA,
        baseRefOid: "b".repeat(40),
        mergeStateStatus: "CLEAN",
        reviewDecision: "",
      }),
      stderr: "",
    };
    const checksResponse = { ok: true, code: 0, stdout: "[]", stderr: "" };
    const runGithubCli = vi.fn(async ({ args }: { args: string[] }) => {
      const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
      const page = Number(new URL("https://github.invalid/" + endpoint).searchParams.get("page"));
      const isReviews = endpoint.includes("/reviews?");
      const values = isReviews
        ? Array.from({ length: 10 }, (_, index) => ({
            id: (page - 1) * 10 + index + 1,
            user: "reviewer",
            state: "COMMENTED",
            commitId: HEAD_SHA,
            body: "r".repeat(100),
          }))
        : [];
      const link =
        isReviews && page < 10 ? 'Link: <https://api.github.com/next>; rel="next"\n' : "";
      const apiResponse = {
        ok: true,
        code: 0,
        stdout: "HTTP/2.0 200 OK\r\n" + link + "\r\n" + JSON.stringify(values),
        stderr: "",
      };
      const command = args[0] + " " + args[1];
      return command === "pr view"
        ? pullResponse
        : command === "pr checks"
          ? checksResponse
          : apiResponse;
    });
    vi.stubGlobal("tools", { run_github_cli: runGithubCli });

    const result = await collectPrFeedback({
      repository: "NVIDIA/NemoClaw",
      pullNumber: 1,
      workdir: "/workspace",
      bodyLimit: 100,
    });

    expect(result.reviews).toHaveLength(100);
    expect(result.reviews[0].body).toBe("r".repeat(100));
    expect(result.truncation.reviews).toBe(false);
    expect(
      runGithubCli.mock.calls
        .filter(([call]) => call.args.some((arg: string) => arg.includes("/reviews?")))
        .every(([call]) => call.args.some((arg: string) => arg.includes("[:100]"))),
    ).toBe(true);
    expect(
      runGithubCli.mock.calls.filter(([call]) =>
        call.args.some((arg: string) => arg.includes("/reviews?")),
      ),
    ).toHaveLength(10);
  });
});
