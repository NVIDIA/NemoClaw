// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { readYaml, type WorkflowJob } from "./helpers/e2e-workflow-contract";

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...parameters: string[]
) => (...args: unknown[]) => Promise<unknown>;

type ApprovalWorkflow = {
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  on?: {
    pull_request_target?: {
      types?: string[];
    };
  };
  permissions?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
};

type HarnessOptions = {
  author?: string;
  eventHead?: string;
  headRepository?: string;
  liveHeads?: string[];
  permission?: {
    permission?: string;
    role_name?: string;
    user?: { login?: string };
  };
  permissionError?: { status: number };
  runsByPoll?: unknown[][];
};

const WORKFLOW_PATH = ".github/workflows/approve-maintainer-pr-workflow-runs.yaml";
const HEAD_SHA = "a".repeat(40);
const MOVED_HEAD_SHA = "b".repeat(40);
const PR_NUMBER = 42;
const workflow = readYaml<ApprovalWorkflow>(WORKFLOW_PATH);
const job = workflow.jobs.approve;
const actionStep = job.steps?.find(
  (step) => step.name === "Approve exact-head maintainer workflow runs",
);
const script = actionStep?.with?.script;

function actionRequiredRun(id: number, overrides: Record<string, unknown> = {}) {
  return {
    actor: { login: "github-actions[bot]" },
    conclusion: "action_required",
    event: "pull_request",
    head_repository: { full_name: "NVIDIA/NemoClaw" },
    head_sha: HEAD_SHA,
    id,
    pull_requests: [{ head: { sha: HEAD_SHA }, number: PR_NUMBER }],
    status: "completed",
    ...overrides,
  };
}

function createHarness(options: HarnessOptions = {}) {
  const author = options.author ?? "maintainer";
  const liveHeads = options.liveHeads ?? [HEAD_SHA];
  let pullRequestRead = 0;
  let workflowRunPoll = 0;

  const getPullRequest = vi.fn(async () => {
    const headSha = liveHeads[Math.min(pullRequestRead, liveHeads.length - 1)];
    pullRequestRead += 1;
    return {
      data: {
        base: { repo: { full_name: "NVIDIA/NemoClaw" } },
        head: {
          repo: { full_name: options.headRepository ?? "NVIDIA/NemoClaw" },
          sha: headSha,
        },
        number: PR_NUMBER,
        state: "open",
        user: { login: author },
      },
    };
  });
  const permissionResponse =
    (options.permission
      ? { ...options.permission, user: options.permission.user ?? { login: author } }
      : undefined) ??
    ({
      permission: "write",
      role_name: "write",
      user: { login: author },
    } as const);
  const getCollaboratorPermissionLevel = vi.fn(
    options.permissionError
      ? async () => Promise.reject(options.permissionError)
      : async () => ({ data: permissionResponse }),
  );
  const listWorkflowRunsForRepo = vi.fn(async () => {
    const runs = options.runsByPoll?.[workflowRunPoll] ?? [];
    workflowRunPoll += 1;
    return { data: { total_count: runs.length, workflow_runs: runs } };
  });
  const approveWorkflowRun = vi.fn().mockResolvedValue({ status: 201 });
  const paginate = vi.fn(
    async (
      endpoint: () => Promise<{ data: { workflow_runs: unknown[] } }>,
      _parameters: Record<string, unknown>,
    ) => (await endpoint()).data.workflow_runs,
  );
  const info = vi.fn();
  const warning = vi.fn();
  const setTimeout = vi.fn((resolve: () => void, _delay: number) => {
    resolve();
    return 0;
  });

  return {
    approveWorkflowRun,
    context: {
      payload: {
        pull_request: {
          head: { sha: options.eventHead ?? HEAD_SHA },
          number: PR_NUMBER,
        },
      },
      repo: { owner: "NVIDIA", repo: "NemoClaw" },
    },
    core: { info, warning },
    getCollaboratorPermissionLevel,
    getPullRequest,
    github: {
      paginate,
      rest: {
        actions: { approveWorkflowRun, listWorkflowRunsForRepo },
        pulls: { get: getPullRequest },
        repos: { getCollaboratorPermissionLevel },
      },
    },
    info,
    listWorkflowRunsForRepo,
    paginate,
    setTimeout,
    warning,
  };
}

async function runScript(harness: ReturnType<typeof createHarness>): Promise<void> {
  expect(script).toEqual(expect.any(String));
  await new AsyncFunction("github", "context", "core", "setTimeout", script as string)(
    harness.github,
    harness.context,
    harness.core,
    harness.setTimeout,
  );
}

describe("maintainer PR workflow-run approval", () => {
  // source-shape-contract: security -- The write-capable pull_request_target workflow must keep its exact trigger, permission, action, and no-checkout execution boundary
  it("keeps workflow approval inside the trusted metadata boundary", () => {
    expect(workflow.on?.pull_request_target).toEqual({
      types: ["opened", "synchronize", "reopened", "edited", "ready_for_review"],
    });
    expect(workflow.permissions).toEqual({
      actions: "write",
      contents: "read",
      "pull-requests": "read",
    });
    expect(workflow.concurrency).toEqual({
      group:
        "approve-maintainer-pr-workflow-runs-${{ github.event.pull_request.number }}-${{ github.event.pull_request.head.sha }}",
      "cancel-in-progress": false,
    });
    expect(job.if).toBe("${{ github.repository == 'NVIDIA/NemoClaw' }}");
    expect(job["timeout-minutes"]).toBe(2);
    expect(job.steps).toHaveLength(1);
    expect(actionStep?.uses).toMatch(/^actions\/github-script@[0-9a-f]{40}$/u);
    expect(job.steps?.some((step) => step.uses?.startsWith("actions/checkout@"))).toBe(false);
    expect(job.steps?.some((step) => typeof step.run === "string")).toBe(false);
    expect(script).not.toContain("github.rest.repos.getContent");
    expect(script).not.toContain("github.rest.git");
    expect(script).not.toContain("require(");
  });

  it.each([
    ["write", { permission: "write", role_name: "custom-write" }],
    ["maintain", { permission: "write", role_name: "maintain" }],
    ["admin", { permission: "admin", role_name: "admin" }],
  ])("approves an exact same-repository bot-restack run for a PR author with %s permission", async (_name, role) => {
    const harness = createHarness({
      permission: { ...role, user: { login: "MAINTAINER" } },
      runsByPoll: [[actionRequiredRun(101)]],
    });

    await runScript(harness);

    expect(harness.getCollaboratorPermissionLevel).toHaveBeenCalledWith({
      owner: "NVIDIA",
      repo: "NemoClaw",
      username: "maintainer",
    });
    expect(harness.approveWorkflowRun).toHaveBeenCalledOnce();
    expect(harness.approveWorkflowRun).toHaveBeenCalledWith({
      owner: "NVIDIA",
      repo: "NemoClaw",
      run_id: 101,
    });
  });

  it("polls boundedly and approves exact-head runs that appear asynchronously", async () => {
    const firstRun = actionRequiredRun(101);
    const secondRun = actionRequiredRun(102);
    const harness = createHarness({
      runsByPoll: [[], [firstRun], [firstRun], [firstRun, secondRun]],
    });

    await runScript(harness);

    expect(harness.listWorkflowRunsForRepo).toHaveBeenCalledTimes(12);
    expect(harness.paginate).toHaveBeenCalledWith(harness.listWorkflowRunsForRepo, {
      event: "pull_request",
      head_sha: HEAD_SHA,
      owner: "NVIDIA",
      per_page: 100,
      repo: "NemoClaw",
      status: "action_required",
    });
    expect(harness.setTimeout).toHaveBeenCalledTimes(11);
    expect(harness.setTimeout).toHaveBeenCalledWith(expect.any(Function), 5000);
    expect(harness.approveWorkflowRun.mock.calls.map(([input]) => input.run_id)).toEqual([
      101, 102,
    ]);
  });

  it.each([
    ["read permission", { permission: { permission: "read", role_name: "maintain" } }],
    ["no collaborator record", { permissionError: { status: 404 } }],
  ])("leaves an external author's runs gated for %s", async (_name, options) => {
    const harness = createHarness({
      author: "external-contributor",
      ...options,
      runsByPoll: [[actionRequiredRun(101)]],
    });

    await runScript(harness);

    expect(harness.listWorkflowRunsForRepo).not.toHaveBeenCalled();
    expect(harness.approveWorkflowRun).not.toHaveBeenCalled();
    expect(harness.info).toHaveBeenCalledWith(
      expect.stringContaining("workflow runs remain gated"),
    );
  });

  it("does not approve from a stale pull_request_target event", async () => {
    const harness = createHarness({ liveHeads: [MOVED_HEAD_SHA] });

    await runScript(harness);

    expect(harness.getCollaboratorPermissionLevel).not.toHaveBeenCalled();
    expect(harness.listWorkflowRunsForRepo).not.toHaveBeenCalled();
    expect(harness.approveWorkflowRun).not.toHaveBeenCalled();
  });

  it("leaves a write-author PR gated when an external repository controls its head", async () => {
    const harness = createHarness({
      headRepository: "external-contributor/NemoClaw",
      runsByPoll: [[actionRequiredRun(101)]],
    });

    await runScript(harness);

    expect(harness.getCollaboratorPermissionLevel).not.toHaveBeenCalled();
    expect(harness.listWorkflowRunsForRepo).not.toHaveBeenCalled();
    expect(harness.approveWorkflowRun).not.toHaveBeenCalled();
    expect(harness.info).toHaveBeenCalledWith(
      expect.stringContaining("head repository is not NVIDIA/NemoClaw"),
    );
  });

  it("stops when the live PR head changes before approval", async () => {
    const harness = createHarness({
      liveHeads: [HEAD_SHA, HEAD_SHA, MOVED_HEAD_SHA],
      runsByPoll: [[actionRequiredRun(101)]],
    });

    await runScript(harness);

    expect(harness.approveWorkflowRun).not.toHaveBeenCalled();
    expect(harness.warning).toHaveBeenCalledWith(
      expect.stringContaining("head changed before workflow-run approval"),
    );
  });

  it("stops when the PR author loses write permission before approval", async () => {
    const harness = createHarness({ runsByPoll: [[actionRequiredRun(101)]] });
    harness.getCollaboratorPermissionLevel
      .mockResolvedValueOnce({
        data: { permission: "write", role_name: "write", user: { login: "maintainer" } },
      })
      .mockResolvedValueOnce({
        data: { permission: "read", role_name: "triage", user: { login: "maintainer" } },
      });

    await runScript(harness);

    expect(harness.approveWorkflowRun).not.toHaveBeenCalled();
    expect(harness.warning).toHaveBeenCalledWith(
      expect.stringContaining("no longer has write, maintain, or admin permission"),
    );
  });

  it("ignores runs that do not bind the exact PR number and head SHA", async () => {
    const harness = createHarness({
      runsByPoll: [
        [
          actionRequiredRun(101, {
            pull_requests: [{ head: { sha: HEAD_SHA }, number: PR_NUMBER + 1 }],
          }),
          actionRequiredRun(102, {
            pull_requests: [{ head: { sha: MOVED_HEAD_SHA }, number: PR_NUMBER }],
          }),
          actionRequiredRun(103, { head_sha: MOVED_HEAD_SHA }),
          actionRequiredRun(104, { conclusion: "success" }),
          actionRequiredRun(105, { event: "workflow_dispatch" }),
          actionRequiredRun(106, {
            head_repository: { full_name: "external-contributor/NemoClaw" },
          }),
        ],
      ],
    });

    await runScript(harness);

    expect(harness.approveWorkflowRun).not.toHaveBeenCalled();
  });

  it("rejects a permission response for a different user", async () => {
    const harness = createHarness({
      permission: {
        permission: "admin",
        role_name: "admin",
        user: { login: "different-user" },
      },
    });

    await expect(runScript(harness)).rejects.toThrow(
      "Permission response did not match PR author maintainer",
    );
    expect(harness.listWorkflowRunsForRepo).not.toHaveBeenCalled();
    expect(harness.approveWorkflowRun).not.toHaveBeenCalled();
  });
});
