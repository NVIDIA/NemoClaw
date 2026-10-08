// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  e2eBudgetChangeDigest,
  hasMaintainerBudgetApproval,
} from "../../helpers/e2e-budget-approval";
import { e2eAssertionBudgetGrowthViolations } from "../../helpers/growth-guardrail-checks";
import { loadGrowthGuardrailDiff } from "../../helpers/growth-guardrail-diff";

import {
  APPROVAL_REFRESH_START,
  APPROVAL_REFRESH_FINISH,
} from "../../../scripts/checks/growth-guardrails-workflow-boundary.mts";

const BUDGET = "ci/e2e-assertion-budget.json";
const POLICY = "ci/e2e-assertion-growth-exceptions.json";
const source = readFileSync(
  new URL("../../../ci/e2e-assertion-budget.json", import.meta.url),
  "utf8",
);
const PR = 123;
const HASH = "a".repeat(64);

const processReads = vi.hoisted(() => ({
  execFileSync: vi.fn<(command: string, args: string[]) => string>(),
  spawnSync: vi.fn(),
}));
vi.mock("node:child_process", () => processReads);

function changedBudget(increase = 1) {
  const budget = JSON.parse(source);
  budget.limits.unique.assertionPoints += increase;
  budget.limits.files[Object.keys(budget.limits.files)[0]][1] += increase;
  return budget;
}

function record(action = "approve", digest = HASH, login = "maintainer", type = "User") {
  return {
    body: `NemoClaw-E2E-Growth: ${action} ${digest}`,
    user: { login, type },
    created_at: "2026-10-08T00:00:00Z",
    updated_at: "2026-10-08T00:00:00Z",
  };
}

describe("E2E budget change approval", () => {
  it("preserves the approved delta after formatting and unrelated base reductions", () => {
    const original = e2eBudgetChangeDigest(source, JSON.stringify(changedBudget()));
    const base = JSON.parse(source);
    const head = changedBudget();
    base.limits.direct.expectCalls -= 1;
    head.limits.direct.expectCalls -= 1;
    head.$comment = "Updated explanation";
    expect(e2eBudgetChangeDigest(JSON.stringify(base, null, 2), JSON.stringify(head))).toBe(
      original,
    );
  });

  it("invalidates approval when the assertion increase changes", () => {
    expect(e2eBudgetChangeDigest(source, JSON.stringify(changedBudget(2)))).not.toBe(
      e2eBudgetChangeDigest(source, JSON.stringify(changedBudget(1))),
    );
  });

  it("invalidates approval when the changed assertion moves to another file", () => {
    const head = changedBudget();
    const original = e2eBudgetChangeDigest(source, JSON.stringify(head));
    const [first, second] = Object.keys(head.limits.files);
    head.limits.files[first][1] -= 1;
    head.limits.files[second][1] += 1;
    expect(e2eBudgetChangeDigest(source, JSON.stringify(head))).not.toBe(original);
  });

  it("rejects reference changes and invalid budget metadata", () => {
    const head = changedBudget();
    head.reference.mainSha = "f".repeat(40);
    expect(e2eBudgetChangeDigest(source, JSON.stringify(head))).toBeNull();
    expect(() => e2eBudgetChangeDigest(source, "{}")).toThrow();
  });

  it("binds zero-assertion file inventory changes", () => {
    const head = changedBudget();
    const before = e2eBudgetChangeDigest(source, JSON.stringify(head));
    head.limits.files["test/e2e/live/new.test.ts"] = [0, 0, 0, 0, 0];
    expect(e2eBudgetChangeDigest(source, JSON.stringify(head))).not.toBe(before);
  });

  it("accepts a verified PR record without a prerequisite policy change", async () => {
    const head = JSON.stringify(changedBudget());
    const digest = e2eBudgetChangeDigest(source, head)!;
    const approval = vi.fn(async (value: string) => value === digest);
    const diff = {
      files: [{ filename: BUDGET, status: "modified" }],
      pullRequestNumber: PR,
      exceptionPolicySource: "base" as const,
      readBase: async () => new Map([[BUDGET, source]]),
      readHead: async () => new Map([[BUDGET, head]]),
      readBudgetApproval: approval,
    };
    expect(await e2eAssertionBudgetGrowthViolations(diff)).toEqual([]);
    expect(approval).toHaveBeenCalledWith(digest);
    expect(
      await e2eAssertionBudgetGrowthViolations({ ...diff, readBudgetApproval: async () => false }),
    ).not.toEqual([]);
  });

  it("accepts a trusted delta entry only for its PR and rejects candidate self-authorization", async () => {
    const head = JSON.stringify(changedBudget());
    const policy = JSON.stringify({
      schemaVersion: 1,
      exceptions: [{ pullRequest: PR, changeSha256: e2eBudgetChangeDigest(source, head) }],
    });
    const diff = {
      files: [{ filename: BUDGET, status: "modified" }],
      pullRequestNumber: PR,
      exceptionPolicySource: "base" as const,
      readBase: async () =>
        new Map([
          [BUDGET, source],
          [POLICY, policy],
        ]),
      readHead: async () =>
        new Map([
          [BUDGET, head],
          [POLICY, policy],
        ]),
    };
    expect(await e2eAssertionBudgetGrowthViolations(diff)).toEqual([]);
    expect(
      await e2eAssertionBudgetGrowthViolations({ ...diff, pullRequestNumber: PR + 1 }),
    ).not.toEqual([]);
    expect(
      await e2eAssertionBudgetGrowthViolations({
        ...diff,
        readBase: async () => new Map([[BUDGET, source]]),
      }),
    ).not.toEqual([]);
  });
});

describe("Maintainer approval through the production diff loader", () => {
  function load(event: string, repository = "NVIDIA/NemoClaw") {
    vi.stubEnv("PR_NUMBER", String(PR));
    vi.stubEnv("BASE_SHA", BASE);
    vi.stubEnv("HEAD_SHA", HEAD);
    vi.stubEnv("GITHUB_EVENT_NAME", event);
    vi.stubEnv("GITHUB_REPOSITORY", repository);
    const head = JSON.stringify(changedBudget());
    const digest = e2eBudgetChangeDigest(source, head)!;
    const comments = [record("approve", digest)];
    const api = "gh api --hostname github.com --method GET repos/NVIDIA/NemoClaw";
    const responses = new Map<string, () => string>([
      [`git fetch --no-tags --depth=1 origin refs/pull/${PR}/head`, () => ""],
      ["git rev-parse FETCH_HEAD", () => HEAD],
      [`git diff --name-status -z -M ${BASE} ${HEAD} --`, () => `M\0${BUDGET}\0`],
      [`${api}/issues/${PR}/comments?per_page=100&page=1`, () => JSON.stringify(comments)],
      [
        `${api}/collaborators/maintainer/permission`,
        () => JSON.stringify({ permission: "write", role_name: "maintain" }),
      ],
    ]);
    processReads.execFileSync.mockImplementation((command, args) => {
      const invocation = `${command} ${args.join(" ")}`;
      const response = responses.get(invocation);
      expect(response, `Unexpected command: ${invocation}`).toBeDefined();
      return response!();
    });
    const contents = new Map([
      [`git show ${BASE}:${BUDGET}`, source],
      [`git show ${HEAD}:${BUDGET}`, head],
    ]);
    processReads.spawnSync.mockImplementation((command, args) => {
      const content = contents.get(`${command} ${args.join(" ")}`);
      return { status: Number(content === undefined), stdout: content ?? "" };
    });
    return { diff: loadGrowthGuardrailDiff(), comments };
  }

  it.each(["pull_request_target", "issue_comment"])(
    "accepts a current maintainer approval from %s and rejects its removal",
    async (event) => {
      const fixture = load(event);
      const diff = await fixture.diff;
      expect(await e2eAssertionBudgetGrowthViolations(diff)).toEqual([]);
      fixture.comments.length = 0;
      expect(await e2eAssertionBudgetGrowthViolations(diff)).not.toEqual([]);
    },
  );

  it.each([
    ["pull_request", "NVIDIA/NemoClaw"],
    ["issue_comment", "contributor/NemoClaw"],
  ])("rejects comment approval for %s in %s", async (event, repository) => {
    const { diff } = load(event, repository);
    const loaded = await diff;
    expect(loaded.readBudgetApproval).toBeUndefined();
    expect(await e2eAssertionBudgetGrowthViolations(loaded)).not.toEqual([]);
    expect(processReads.execFileSync.mock.calls.some(([command]) => command === "gh")).toBe(false);
  });
});

describe("GitHub maintainer budget records", () => {
  it.each(["write", "maintain", "admin", "read", "triage"])(
    "checks the author's %s permission",
    (permission) => {
      const api = vi.fn((endpoint: string) =>
        endpoint.includes("/comments?")
          ? [record()]
          : { permission: permission === "maintain" ? "write" : permission, role_name: permission },
      );
      expect(hasMaintainerBudgetApproval(PR, HASH, api)).toBe(
        ["maintain", "admin"].includes(permission),
      );
      expect(api).toHaveBeenCalledWith(
        `repos/NVIDIA/NemoClaw/issues/${PR}/comments?per_page=100&page=1`,
      );
      expect(api).toHaveBeenCalledWith("repos/NVIDIA/NemoClaw/collaborators/maintainer/permission");
    },
  );

  it.each([
    record("approve", "b".repeat(64)),
    { ...record(), updated_at: "2026-10-08T00:00:01Z" },
    { ...record(), created_at: undefined, updated_at: undefined },
    record("approve", HASH, "maintainer", "Bot"),
    { ...record(), body: `Example:\nNemoClaw-E2E-Growth: approve ${HASH}` },
    { ...record(), body: "```text\n" + record().body + "\n```" },
    record("approve", HASH, "../admin"),
    {
      body: `Quoted: NemoClaw-E2E-Growth: approve ${HASH}`,
      user: { login: "maintainer", type: "User" },
    },
  ])("rejects an ineligible or unrelated record %j", (comment) => {
    const api = vi.fn(() => [comment]);
    expect(hasMaintainerBudgetApproval(PR, HASH, api)).toBe(false);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("honors a later revocation across pages", () => {
    const page = Array.from({ length: 100 }, () => ({ body: "ordinary comment" }));
    page[0] = record();
    const api = vi.fn((endpoint: string) =>
      endpoint.endsWith("/permission")
        ? { permission: "write", role_name: "maintain" }
        : endpoint.endsWith("page=1")
          ? page
          : [record("revoke")],
    );
    expect(hasMaintainerBudgetApproval(PR, HASH, api)).toBe(false);
  });

  it("rejects missing records and does not let a non-maintainer revoke an approval", () => {
    expect(hasMaintainerBudgetApproval(PR, HASH, () => [])).toBe(false);
    const api = (endpoint: string) =>
      endpoint.includes("/comments?")
        ? [record(), record("revoke", HASH, "reader")]
        : {
            permission: endpoint.includes("/reader/") ? "read" : "write",
            role_name: endpoint.includes("/reader/") ? "read" : "maintain",
          };
    expect(hasMaintainerBudgetApproval(PR, HASH, api)).toBe(true);
  });

  it("fails closed on API errors or malformed responses", () => {
    expect(() =>
      hasMaintainerBudgetApproval(PR, HASH, () => {
        throw new Error("API unavailable");
      }),
    ).toThrow("API unavailable");
    expect(() => hasMaintainerBudgetApproval(PR, HASH, () => null)).toThrow("Could not read");
    expect(() => hasMaintainerBudgetApproval(0, HASH, () => [])).toThrow("Invalid");
  });
});

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
    eventName: "issue_comment",
    repo: { owner: "NVIDIA", repo: "NemoClaw" },
    serverUrl: "https://github.com",
    runId: 456,
    payload: {
      action: "created",
      pull_request: { number: 123 },
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
  it.each(["opened", "synchronize"])(
    "binds %s evaluation to the repository's required merge gate",
    async (action) => {
      const f = fixture();
      f.context.eventName = "pull_request_target";
      f.context.payload.action = action;
      f.context.payload.comment.body = "";
      await f.start();
      expect(f.status).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ sha: HEAD, context: "checks", state: "pending" }),
      );
      expect(f.outputs).toEqual({ pr_number: "123", base_sha: BASE, head_sha: HEAD });
    },
  );

  it("rejects an untrusted workflow event before publishing status", async () => {
    const f = fixture();
    f.context.eventName = "pull_request";
    await expect(f.start()).rejects.toThrow("Unexpected approval event");
    expect(f.status).not.toHaveBeenCalled();
  });
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
          context: "checks",
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
      expect(f.status.mock.calls.map(([value]) => value)).toEqual([
        expect.objectContaining({ sha: HEAD, context: "checks", state: "pending" }),
        expect.objectContaining({ sha: HEAD, context: "checks", state: "failure" }),
      ]);
    },
  );

  it("reports success only after the trusted growth check succeeds", async () => {
    const f = fixture();
    await f.start();
    await f.finish("success");
    expect(f.status).toHaveBeenLastCalledWith(
      expect.objectContaining({ sha: HEAD, context: "checks", state: "success" }),
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
      expect(f.status.mock.calls.map(([value]) => value)).toEqual([
        expect.objectContaining({ sha: HEAD, context: "checks", state: "success" }),
        expect.objectContaining({ sha: HEAD, context: "checks", state: "pending" }),
        expect.objectContaining({ sha: HEAD, context: "checks", state: "failure" }),
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
