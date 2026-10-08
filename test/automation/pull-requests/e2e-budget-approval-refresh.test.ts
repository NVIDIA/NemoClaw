// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  e2eBudgetChangeDigest,
  hasMaintainerBudgetApproval,
} from "../../helpers/e2e-budget-approval";
import { e2eAssertionBudgetGrowthViolations } from "../../helpers/growth-guardrail-checks";
import {
  APPROVAL_REFRESH_START,
  APPROVAL_REFRESH_FINISH,
} from "../../../scripts/checks/growth-guardrails-workflow-boundary.mts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const command = "NemoClaw-E2E-Growth: approve " + "c".repeat(64);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

function fixture() {
  const pr = {
    state: "open",
    head: { sha: HEAD },
    base: { sha: BASE, ref: "main", repo: { full_name: "NVIDIA/NemoClaw" } },
  };
  const outputs: Record<string, string> = {};
  const status = vi.fn(async (_value: unknown) => ({}));
  const get = vi.fn(async () => ({ data: pr }));
  const context = {
    repo: { owner: "NVIDIA", repo: "NemoClaw" },
    serverUrl: "https://github.com",
    runId: 456,
    payload: {
      comment: { body: command },
      issue: { number: 123, pull_request: {} as unknown },
      repository: { default_branch: "main" },
      changes: {} as { body?: { from: string } },
    },
  };
  const github = { rest: { pulls: { get }, repos: { createCommitStatus: status } } };
  const core = {
    setOutput: (name: string, value: string) => {
      outputs[name] = value;
    },
  };
  return {
    pr,
    outputs,
    status,
    get,
    context,
    start: () =>
      new AsyncFunction("github", "context", "core", APPROVAL_REFRESH_START)(github, context, core),
    finish: (outcome: string | undefined, sha = HEAD) =>
      new AsyncFunction("github", "context", "process", APPROVAL_REFRESH_FINISH)(github, context, {
        env: { APPROVAL_HEAD_SHA: sha, APPROVAL_CHECK_OUTCOME: outcome },
      }),
  };
}

describe("budget approval status refresh", () => {
  it.each(["approve", "revoke"])(
    "invalidates a previous green result after %s without granting approval",
    async (action) => {
      const f = fixture();
      f.context.payload.comment.body = command.replace("approve", action);
      await f.start();
      expect(f.get).toHaveBeenCalledWith({ owner: "NVIDIA", repo: "NemoClaw", pull_number: 123 });
      expect(f.status).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          sha: HEAD,
          context: "codebase-growth-guardrails",
          state: "pending",
        }),
      );
      expect(f.outputs).toEqual({ pr_number: "123", base_sha: BASE, head_sha: HEAD });
    },
  );

  it("invalidates an approval edited into an ordinary comment", async () => {
    const f = fixture();
    f.context.payload.comment.body = "Withdrawn";
    f.context.payload.changes.body = { from: command };
    await f.start();
    expect(f.status).toHaveBeenCalledWith(expect.objectContaining({ state: "pending" }));
  });

  it("reevaluates quoted or malformed records instead of dropping a queued revocation", async () => {
    const f = fixture();
    f.context.payload.comment.body = "Example: NemoClaw-E2E-Growth: approve placeholder";
    await f.start();
    expect(f.status).toHaveBeenCalledWith(expect.objectContaining({ state: "pending" }));
  });

  it("uses the current PR commit even when the event predates a push", async () => {
    const f = fixture();
    f.pr.head.sha = "d".repeat(40);
    await f.start();
    expect(f.outputs.head_sha).toBe(f.pr.head.sha);
    expect(f.status).toHaveBeenCalledWith(expect.objectContaining({ sha: f.pr.head.sha }));
  });

  it.each([
    [
      "unrelated comment",
      (f: ReturnType<typeof fixture>) => {
        f.context.payload.comment.body = "Thanks";
      },
    ],
    [
      "closed PR",
      (f: ReturnType<typeof fixture>) => {
        f.pr.state = "closed";
      },
    ],
  ] as const)("does not write a status for an %s", async (_reason, arrange) => {
    const f = fixture();
    arrange(f);
    await f.start();
    expect(f.status).not.toHaveBeenCalled();
  });

  it.each([
    [
      "repository",
      (f: ReturnType<typeof fixture>) => {
        f.context.repo.owner = "fork";
      },
    ],
    [
      "base repository",
      (f: ReturnType<typeof fixture>) => {
        f.pr.base.repo.full_name = "fork/NemoClaw";
      },
    ],
    [
      "base branch",
      (f: ReturnType<typeof fixture>) => {
        f.pr.base.ref = "feature";
      },
    ],
    [
      "commit",
      (f: ReturnType<typeof fixture>) => {
        f.pr.head.sha = "not-a-sha";
      },
    ],
    [
      "issue",
      (f: ReturnType<typeof fixture>) => {
        f.context.payload.issue.pull_request = undefined;
      },
    ],
  ] as const)("rejects an invalid %s before a status write", async (_field, arrange) => {
    const f = fixture();
    arrange(f);
    await expect(f.start()).rejects.toThrow();
    expect(f.status).not.toHaveBeenCalled();
  });

  it("does not publish checkout inputs when invalidation fails", async () => {
    const f = fixture();
    f.status.mockRejectedValueOnce(new Error("API unavailable"));
    await expect(f.start()).rejects.toThrow("API unavailable");
    expect(f.outputs).toEqual({});
  });

  it.each(["failure", "cancelled", "skipped", undefined])(
    "keeps a %s refresh from reusing a green result",
    async (outcome) => {
      const f = fixture();
      await f.start();
      await f.finish(outcome);
      expect(f.status.mock.calls.map(([value]) => (value as { state: string }).state)).toEqual([
        "pending",
        "failure",
      ]);
    },
  );

  it("reports success only after the trusted growth check succeeds", async () => {
    const f = fixture();
    await f.start();
    await f.finish("success");
    expect(f.status).toHaveBeenLastCalledWith(
      expect.objectContaining({ sha: HEAD, state: "success" }),
    );
  });

  it.each(["revoked", "deleted", "edited"] as const)(
    "replaces a green approval with failure when the record is %s",
    async (change) => {
      const f = fixture();
      const path = "ci/e2e-assertion-budget.json";
      const base = readFileSync(
        new URL("../../../ci/e2e-assertion-budget.json", import.meta.url),
        "utf8",
      );
      const budget = JSON.parse(base);
      budget.limits.unique.assertionPoints += 1;
      const head = JSON.stringify(budget);
      const digest = e2eBudgetChangeDigest(base, head)!;
      const approved = {
        body: `NemoClaw-E2E-Growth: approve ${digest}`,
        user: { login: "maintainer", type: "User" },
        created_at: "2026-10-08T00:00:00Z",
        updated_at: "2026-10-08T00:00:00Z",
      };
      let comments = [approved];
      const api = (endpoint: string) =>
        endpoint.includes("/comments?") ? comments : { permission: "write", role_name: "maintain" };
      const diff = {
        files: [{ filename: path, status: "modified" }],
        pullRequestNumber: 123,
        exceptionPolicySource: "base" as const,
        readBase: async () => new Map([[path, base]]),
        readHead: async () => new Map([[path, head]]),
        readBudgetApproval: async (value: string) => hasMaintainerBudgetApproval(123, value, api),
      };
      expect(await e2eAssertionBudgetGrowthViolations(diff)).toEqual([]);
      await f.finish("success");
      const revoked = { ...approved, body: approved.body.replace("approve", "revoke") };
      const edited = { ...approved, body: "Withdrawn", updated_at: "2026-10-08T00:00:01Z" };
      const next = {
        revoked: { comments: [approved, revoked], body: revoked.body, changes: {} },
        deleted: { comments: [], body: approved.body, changes: {} },
        edited: {
          comments: [edited],
          body: edited.body,
          changes: { body: { from: approved.body } },
        },
      }[change];
      comments = next.comments;
      f.context.payload.comment.body = next.body;
      f.context.payload.changes = next.changes;
      await f.start();
      const violations = await e2eAssertionBudgetGrowthViolations(diff);
      expect(violations.length).toBeGreaterThan(0);
      await f.finish("failure");
      expect(f.status.mock.calls.map(([value]) => (value as { state: string }).state)).toEqual([
        "success",
        "pending",
        "failure",
      ]);
    },
  );

  it("propagates report failures and rejects an invalid target commit", async () => {
    const f = fixture();
    await expect(f.finish("success", "bad")).rejects.toThrow("Invalid");
    expect(f.status).not.toHaveBeenCalled();
    f.status.mockRejectedValueOnce(new Error("API unavailable"));
    await expect(f.finish("success")).rejects.toThrow("API unavailable");
  });
});
