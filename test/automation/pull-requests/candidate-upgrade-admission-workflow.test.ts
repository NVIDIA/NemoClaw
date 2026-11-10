// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { readYaml, type WorkflowJob } from "../../helpers/e2e-workflow-contract";

const workflow = readYaml<{
  on: { workflow_run: { workflows: string[]; types: string[] } };
  jobs: Record<string, WorkflowJob>;
}>(".github/workflows/candidate-upgrade-admission.yaml");
const reviewSignal = readYaml<{
  name: string;
  on: { pull_request_review: { types: string[] } };
}>(".github/workflows/candidate-review-signal.yaml");
const steps = workflow.jobs["candidate-upgrade-admission"]!.steps!;
const start = steps.find((step) => step.id === "identity")!.with!.script as string;
const finish = steps.find((step) => step.name === "Report current candidate upgrade admission")!
  .with!.script as string;
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor;
const head = "a".repeat(40);
const base = "b".repeat(40);

function packagingFixture() {
  const step = workflow.jobs["candidate-sdk-package"]!.steps!.find(
    (item) => item.id === "package",
  )!;
  const script = step
    .run!.split("\n")
    .filter((line) => !line.startsWith("import ") && line !== "NODE" && !line.startsWith("node "))
    .join("\n");
  const append = vi.fn();
  const request = vi.fn(async () => ({ authenticated: true }));
  const packageSdk = vi.fn(
    async (_output: string, _identity: unknown, fetch: (path: string) => Promise<unknown>) => {
      await fetch("/repos/NVIDIA/NemoClaw/pulls/123");
      return { required: true, bundleName: "approved-bundle", artifactName: "sdk.tgz" };
    },
  );
  const run = () =>
    new AsyncFunction(
      "appendFileSync",
      "join",
      "packageCandidateOpenShellSdkIfRequired",
      "githubRequest",
      "process",
      script,
    )(append, join, packageSdk, request, {
      env: {
        UPGRADE_PR_NUMBER: "123",
        CANDIDATE_SHA: head,
        UPGRADE_BASE_SHA: base,
        RUNNER_TEMP: "/fixture-temp",
        GITHUB_OUTPUT: "/fixture-output",
        GITHUB_TOKEN: "synthetic-read-token",
      },
    });
  return { append, request, packageSdk, run };
}

function fixture() {
  const pr = {
    state: "open",
    head: { sha: head, ref: "codex/candidate", repo: { full_name: "NVIDIA/NemoClaw" } },
    base: { sha: base, ref: "main", repo: { full_name: "NVIDIA/NemoClaw" } },
  };
  const context = {
    eventName: "pull_request_target",
    repo: { owner: "NVIDIA", repo: "NemoClaw" },
    serverUrl: "https://github.com",
    runId: 456,
    payload: {
      pull_request: { number: 123 },
      workflow_run: {
        event: "pull_request_review",
        name: "Security / Candidate Review Signal",
        head_repository: { full_name: "NVIDIA/NemoClaw" },
        head_branch: "codex/candidate",
        pull_requests: [] as { number: number }[],
      },
    },
  };
  const outputs: Record<string, string> = {};
  const status = vi.fn(async (_value: unknown) => ({}));
  const get = vi.fn(async () => ({ data: pr }));
  const list = vi.fn(async () => ({ data: [{ number: 123 }] }));
  const github = { rest: { pulls: { get, list }, repos: { createCommitStatus: status } } };
  return {
    pr,
    context,
    status,
    outputs,
    get,
    list,
    start: () =>
      new AsyncFunction("github", "context", "core", start)(github, context, {
        setOutput: (name: string, value: string) => {
          outputs[name] = value;
        },
      }),
    finish: (outcome: string) =>
      new AsyncFunction("github", "context", "process", finish)(github, context, {
        env: {
          UPGRADE_PR_NUMBER: "123",
          UPGRADE_CANDIDATE_SHA: head,
          UPGRADE_BASE_SHA: base,
          UPGRADE_OUTCOME: outcome,
        },
      }),
  };
}

describe("candidate upgrade admission status", () => {
  it("passes captured commits and the API credential to the trusted package producer", async () => {
    const f = packagingFixture();
    await f.run();
    expect(f.packageSdk).toHaveBeenCalledExactlyOnceWith(
      "/fixture-temp/candidate-sdk",
      { prNumber: 123, candidateSha: head, baseSha: base },
      expect.any(Function),
    );
    expect(f.request).toHaveBeenCalledExactlyOnceWith(
      "/repos/NVIDIA/NemoClaw/pulls/123",
      "synthetic-read-token",
    );
    expect(f.append.mock.calls).toEqual([
      ["/fixture-output", "required=true\n"],
      ["/fixture-output", "bundle_name=approved-bundle\nartifact_name=sdk.tgz\n"],
    ]);
  });

  it("does not release upload outputs when the package producer rejects admission", async () => {
    const f = packagingFixture();
    f.packageSdk.mockRejectedValueOnce(new Error("revoked admission"));
    await expect(f.run()).rejects.toThrow("revoked admission");
    expect(f.append).not.toHaveBeenCalled();
  });

  it("does not request a candidate upload for a trusted SDK", async () => {
    const f = packagingFixture();
    f.packageSdk.mockResolvedValueOnce({ required: false, bundleName: "", artifactName: "" });
    await f.run();
    expect(f.append).toHaveBeenCalledExactlyOnceWith("/fixture-output", "required=false\n");
  });

  it("does not admit a PR closed during verification", async () => {
    const f = fixture();
    await f.start();
    f.pr.state = "closed";
    await f.finish("success");
    expect(f.status).toHaveBeenLastCalledWith(expect.objectContaining({ state: "failure" }));
  });

  // source-shape-contract: security -- GitHub must relay every review change to the trusted admission controller so dismissed approvals cannot leave candidate authorization stale.
  it.each([
    ["submitted", "success"],
    ["edited", "success"],
    ["dismissed", "success"],
    ["dismissed", "failure"],
    ["dismissed", "cancelled"],
    ["dismissed", "skipped"],
  ])(
    "refreshes admission through the configured %s review handoff after %s",
    async (action, conclusion) => {
      expect(reviewSignal.on.pull_request_review.types).toContain(action);
      expect(workflow.on.workflow_run).toEqual({
        workflows: [reviewSignal.name],
        types: ["completed"],
      });
      const f = fixture();
      f.context.eventName = "workflow_run";
      f.context.payload.workflow_run.name = reviewSignal.name;
      f.context.payload.workflow_run.event = Object.keys(reviewSignal.on)[0]!;
      const condition = String(workflow.jobs["candidate-upgrade-admission"]!.if).slice(3, -2);
      const selected = (repository: string, conclusion: string) =>
        new Function("github", `return (${condition});`)({
          repository: "NVIDIA/NemoClaw",
          event_name: "workflow_run",
          event: {
            workflow_run: {
              ...f.context.payload.workflow_run,
              conclusion,
              head_repository: { full_name: repository },
            },
          },
        });
      expect(selected("NVIDIA/NemoClaw", conclusion)).toBe(true);
      expect(selected("other/NemoClaw", conclusion)).toBe(false);
      await f.start();
      expect(f.status).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ sha: head, context: "check-hash", state: "pending" }),
      );
      expect(f.outputs).toEqual({ pr_number: "123", head_sha: head, base_sha: base });
      expect(f.list).toHaveBeenCalledExactlyOnceWith({
        owner: "NVIDIA",
        repo: "NemoClaw",
        head: "NVIDIA:codex/candidate",
        base: "main",
        state: "open",
        per_page: 2,
      });
    },
  );

  it.each(["wrong-event", "wrong-workflow", "fork", "missing-branch"])(
    "rejects a %s review signal",
    async (kind) => {
      const f = fixture();
      f.context.eventName = "workflow_run";
      const signal = f.context.payload.workflow_run;
      const mutate: Record<string, () => unknown> = {
        "wrong-event": () => {
          signal.event = "push";
        },
        "wrong-workflow": () => {
          signal.name = "Other workflow";
        },
        fork: () => {
          signal.head_repository.full_name = "other/NemoClaw";
        },
        "missing-branch": () => {
          signal.head_branch = "";
        },
      };
      mutate[kind]!();
      await expect(f.start()).rejects.toThrow(/Invalid candidate review signal/);
      expect(f.status).not.toHaveBeenCalled();
    },
  );

  it("ignores a review signal after its branch has no open PR", async () => {
    const f = fixture();
    f.context.eventName = "workflow_run";
    f.list.mockResolvedValueOnce({ data: [] });
    await f.start();
    expect(f.status).not.toHaveBeenCalled();
    expect(f.outputs).toEqual({});
  });

  it("rejects ambiguous open PRs for a review branch", async () => {
    const f = fixture();
    f.context.eventName = "workflow_run";
    f.list.mockResolvedValueOnce({ data: [{ number: 123 }, { number: 124 }] });
    await expect(f.start()).rejects.toThrow(/Ambiguous/);
    expect(f.status).not.toHaveBeenCalled();
  });

  it("rejects a branch mismatch after resolving the review signal", async () => {
    const f = fixture();
    f.context.eventName = "workflow_run";
    f.pr.head.ref = "other-branch";
    await expect(f.start()).rejects.toThrow(/branch changed/);
    expect(f.status).not.toHaveBeenCalled();
  });

  it.each(["pull_request", "push", "workflow_dispatch", "issue_comment", "pull_request_review"])(
    "rejects untrusted or unrelated event %s",
    async (event) => {
      const f = fixture();
      f.context.eventName = event;
      await expect(f.start()).rejects.toThrow(/Unexpected upgrade event/);
      expect(f.status).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "fork",
      (f: ReturnType<typeof fixture>) => {
        f.pr.head.repo.full_name = "other/NemoClaw";
      },
    ],
    [
      "base",
      (f: ReturnType<typeof fixture>) => {
        f.pr.base.ref = "release";
      },
    ],
    [
      "commit",
      (f: ReturnType<typeof fixture>) => {
        f.pr.head.sha = "main";
      },
    ],
    [
      "number",
      (f: ReturnType<typeof fixture>) => {
        f.context.payload.pull_request.number = 0;
      },
    ],
  ] as const)("rejects invalid %s before writing status", async (_label, mutate) => {
    const f = fixture();
    mutate(f);
    await expect(f.start()).rejects.toThrow();
    expect(f.status).not.toHaveBeenCalled();
  });

  it.each(["failure", "cancelled", "skipped", ""])(
    "does not turn %s into admission",
    async (outcome) => {
      const f = fixture();
      await f.finish(outcome);
      expect(f.status).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          sha: head,
          context: "check-hash",
          state: "failure",
        }),
      );
    },
  );

  it.each(["head", "base"] as const)("denies stale success when the %s changes", async (key) => {
    const f = fixture();
    f.pr[key].sha = "c".repeat(40);
    await f.finish("success");
    expect(f.status).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ state: "failure" }));
  });

  it("reports success only for a completed check on the current open PR", async () => {
    const f = fixture();
    await f.start();
    await f.finish("success");
    expect(f.status.mock.calls.map(([value]) => value)).toEqual([
      expect.objectContaining({ sha: head, context: "check-hash", state: "pending" }),
      expect.objectContaining({ sha: head, context: "check-hash", state: "success" }),
    ]);
  });
});
