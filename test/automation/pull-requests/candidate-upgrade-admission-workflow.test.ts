// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { readYaml, type WorkflowJob } from "../../helpers/e2e-workflow-contract";

const workflow = readYaml<{ jobs: Record<string, WorkflowJob> }>(
  ".github/workflows/candidate-upgrade-admission.yaml",
);
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
    head: { sha: head, repo: { full_name: "NVIDIA/NemoClaw" } },
    base: { sha: base, ref: "main", repo: { full_name: "NVIDIA/NemoClaw" } },
  };
  const context = {
    eventName: "pull_request_target",
    repo: { owner: "NVIDIA", repo: "NemoClaw" },
    serverUrl: "https://github.com",
    runId: 456,
    payload: {
      pull_request: { number: 123 },
      issue: { number: 123, pull_request: {} },
      comment: { body: `NemoClaw-Upgrade-E2E: approve ${head} ${base}` },
      changes: { body: { from: "" } },
    },
  };
  const outputs: Record<string, string> = {};
  const status = vi.fn(async (_value: unknown) => ({}));
  const get = vi.fn(async () => ({ data: pr }));
  const github = { rest: { pulls: { get }, repos: { createCommitStatus: status } } };
  return {
    pr,
    context,
    status,
    outputs,
    get,
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

  it.each(["approve", "revoke", "quoted approve"])(
    "invalidates the merge status for %s without granting permission",
    async (action) => {
      const f = fixture();
      f.context.eventName = "issue_comment";
      f.context.payload.comment.body = `NemoClaw-Upgrade-E2E: ${action} ${head} ${base}`;
      await f.start();
      expect(f.status).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          sha: head,
          context: "check-hash",
          state: "pending",
        }),
      );
      expect(f.outputs).toEqual({ pr_number: "123", head_sha: head, base_sha: base });
    },
  );

  it("refreshes when editing removes the approval marker", async () => {
    const f = fixture();
    f.context.eventName = "issue_comment";
    f.context.payload.changes.body.from = f.context.payload.comment.body;
    f.context.payload.comment.body = "removed";
    await f.start();
    expect(f.status).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ state: "pending" }));
  });

  it.each(["pull_request", "push", "workflow_dispatch"])(
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
