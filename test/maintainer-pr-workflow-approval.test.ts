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

type ApiFailure = {
  code?: string;
  status?: number;
};

type ApiRequestInput = {
  request?: { signal?: AbortSignal };
};

type HarnessOptions = {
  abortSignalsImmediately?: boolean;
  approvalErrors?: ApiFailure[];
  author?: string;
  dateNowValues?: number[];
  eventHead?: string;
  headRepository?: string;
  hungPullRequestAttempts?: number;
  liveHeads?: string[];
  permission?: {
    permission?: string;
    role_name?: string;
    user?: { login?: string };
  };
  permissionError?: { status: number };
  pullRequestErrors?: ApiFailure[];
  runsByPoll?: unknown[][];
  workflowRunGetErrors?: ApiFailure[];
  workflowRunsByGet?: unknown[];
  workflowRunErrors?: ApiFailure[];
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
const rawScript = actionStep?.with?.script;
const script = typeof rawScript === "string" ? rawScript : undefined;

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
  const approvalErrors = [...(options.approvalErrors ?? [])];
  const pullRequestErrors = [...(options.pullRequestErrors ?? [])];
  const workflowRunGetErrors = [...(options.workflowRunGetErrors ?? [])];
  const workflowRunErrors = [...(options.workflowRunErrors ?? [])];
  const dateNowValues = options.dateNowValues ?? [0];
  let dateNowRead = 0;
  let hungPullRequestAttempts = options.hungPullRequestAttempts ?? 0;
  let pullRequestRead = 0;
  let workflowRunRead = 0;
  let workflowRunPoll = 0;

  const dateNow = vi.fn(
    () => dateNowValues[Math.min(dateNowRead++, dateNowValues.length - 1)] ?? 0,
  );
  const abortSignalTimeout = vi.fn((_delayMs: number) => {
    const controller = new AbortController();
    options.abortSignalsImmediately ? queueMicrotask(() => controller.abort()) : undefined;
    return controller.signal;
  });
  const abortSignal = { timeout: abortSignalTimeout };

  const getPullRequest = vi.fn(async (input: ApiRequestInput) => {
    const hungRequest =
      hungPullRequestAttempts > 0
        ? new Promise<void>((_resolve, reject) => {
            const signal = input.request?.signal;
            const rejectRequest = () =>
              reject(
                Object.assign(new Error("request aborted"), { code: "ETIMEDOUT", status: 500 }),
              );
            signal?.addEventListener("abort", rejectRequest, { once: true });
            signal?.aborted ? rejectRequest() : undefined;
          })
        : Promise.resolve();
    hungPullRequestAttempts = Math.max(0, hungPullRequestAttempts - 1);
    await hungRequest;
    const failure = pullRequestErrors.shift();
    await (failure ? Promise.reject(failure) : Promise.resolve());
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
    const failure = workflowRunErrors.shift();
    await (failure ? Promise.reject(failure) : Promise.resolve());
    const runs = options.runsByPoll?.[workflowRunPoll] ?? [];
    workflowRunPoll += 1;
    return { data: { total_count: runs.length, workflow_runs: runs } };
  });
  const approveWorkflowRun = vi.fn(
    async (_input: ApiRequestInput & { owner: string; repo: string; run_id: number }) => {
      const failure = approvalErrors.shift();
      await (failure ? Promise.reject(failure) : Promise.resolve());
      return { status: 201 };
    },
  );
  const getWorkflowRun = vi.fn(async ({ run_id: runId }: { run_id: number }) => {
    const failure = workflowRunGetErrors.shift();
    await (failure ? Promise.reject(failure) : Promise.resolve());
    const configuredRuns = options.workflowRunsByGet ?? [];
    const run =
      configuredRuns[Math.min(workflowRunRead, configuredRuns.length - 1)] ??
      actionRequiredRun(runId);
    workflowRunRead += 1;
    return { data: run };
  });
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
    abortSignal,
    abortSignalTimeout,
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
    dateNow,
    getCollaboratorPermissionLevel,
    getPullRequest,
    getWorkflowRun,
    github: {
      paginate,
      rest: {
        actions: { approveWorkflowRun, getWorkflowRun, listWorkflowRunsForRepo },
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
  await new AsyncFunction(
    "github",
    "context",
    "core",
    "setTimeout",
    "AbortSignal",
    "Date",
    script as string,
  )(harness.github, harness.context, harness.core, harness.setTimeout, harness.abortSignal, {
    now: harness.dateNow,
  });
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
    expect(script).not.toContain("requestTimeoutFor");
    expect(script).not.toContain("request: { timeout:");
    const scriptBudgetMs = Number(script?.match(/const SCRIPT_BUDGET_MS = (\d+);/u)?.[1]);
    expect(scriptBudgetMs).toBeGreaterThan(0);
    expect(scriptBudgetMs).toBeLessThan(Number(job["timeout-minutes"]) * 60_000);
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
      request: { signal: expect.anything() },
      username: "maintainer",
    });
    expect(harness.approveWorkflowRun).toHaveBeenCalledOnce();
    expect(harness.approveWorkflowRun).toHaveBeenCalledWith({
      owner: "NVIDIA",
      repo: "NemoClaw",
      request: { signal: expect.anything() },
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
      request: { signal: expect.anything() },
      repo: "NemoClaw",
      status: "action_required",
    });
    expect(harness.setTimeout).toHaveBeenCalledTimes(11);
    expect(harness.setTimeout).toHaveBeenCalledWith(expect.any(Function), 5000);
    expect(harness.approveWorkflowRun.mock.calls.map(([input]) => input.run_id)).toEqual([
      101, 102,
    ]);
  });

  it("reports completed approvals when the polling budget ends", async () => {
    const harness = createHarness({
      dateNowValues: [0, 0, 0, 0, 0, 101_000],
      runsByPoll: [[actionRequiredRun(101)]],
    });

    await runScript(harness);

    expect(harness.listWorkflowRunsForRepo).toHaveBeenCalledOnce();
    expect(harness.approveWorkflowRun).toHaveBeenCalledOnce();
    expect(harness.setTimeout).not.toHaveBeenCalled();
    expect(harness.warning).toHaveBeenCalledWith(
      expect.stringContaining("Workflow-run polling stopped after 1/12 attempts"),
    );
    expect(harness.info).toHaveBeenCalledWith("Approved 1 exact-head workflow run(s) for PR #42");
  });

  it("recovers from a transient pulls.get failure before trusting live PR metadata", async () => {
    const harness = createHarness({
      pullRequestErrors: [{ status: 504 }],
      runsByPoll: [[actionRequiredRun(101)]],
    });

    await runScript(harness);

    expect(harness.approveWorkflowRun).toHaveBeenCalledOnce();
    expect(harness.warning).toHaveBeenCalledWith(
      expect.stringContaining("Load live PR #42 failed transiently with HTTP 504"),
    );
    expect(harness.setTimeout).toHaveBeenCalledWith(expect.any(Function), 250);
  });

  it("aborts and retries a hung API request with a fresh bounded signal", async () => {
    const harness = createHarness({
      abortSignalsImmediately: true,
      hungPullRequestAttempts: 3,
    });

    await expect(runScript(harness)).rejects.toMatchObject({
      code: "ETIMEDOUT",
      status: 500,
    });

    expect(harness.getPullRequest).toHaveBeenCalledTimes(3);
    expect(harness.abortSignalTimeout).toHaveBeenCalledTimes(3);
    expect(harness.abortSignalTimeout).toHaveBeenNthCalledWith(1, 10_000);
    expect(harness.abortSignalTimeout).toHaveBeenNthCalledWith(2, 10_000);
    expect(harness.abortSignalTimeout).toHaveBeenNthCalledWith(3, 10_000);
    const requestSignals = harness.getPullRequest.mock.calls.map(
      ([input]) => input.request?.signal,
    );
    expect(new Set(requestSignals).size).toBe(3);
  });

  it("bounds an aborting request by the remaining script budget", async () => {
    const harness = createHarness({
      abortSignalsImmediately: true,
      dateNowValues: [0, 104_500, 105_000],
      hungPullRequestAttempts: 1,
    });

    await expect(runScript(harness)).rejects.toThrow(
      "Load live PR #42 exceeded the bounded 105000ms script budget",
    );

    expect(harness.getPullRequest).toHaveBeenCalledOnce();
    expect(harness.abortSignalTimeout).toHaveBeenCalledOnce();
    expect(harness.abortSignalTimeout).toHaveBeenCalledWith(500);
  });

  it("recovers from transient workflow-run listing failures with bounded backoff", async () => {
    const harness = createHarness({
      runsByPoll: [[actionRequiredRun(101)]],
      workflowRunErrors: [{ status: 502 }, { status: 504 }],
    });

    await runScript(harness);

    expect(harness.listWorkflowRunsForRepo).toHaveBeenCalledTimes(14);
    expect(harness.approveWorkflowRun).toHaveBeenCalledOnce();
    expect(harness.setTimeout).toHaveBeenCalledWith(expect.any(Function), 250);
    expect(harness.setTimeout).toHaveBeenCalledWith(expect.any(Function), 500);
  });

  it("revalidates exact-head authority before retrying a transient approval failure", async () => {
    const harness = createHarness({
      approvalErrors: [{ status: 504 }],
      runsByPoll: [[actionRequiredRun(101)]],
    });

    await runScript(harness);

    expect(harness.approveWorkflowRun).toHaveBeenCalledTimes(2);
    expect(harness.getCollaboratorPermissionLevel).toHaveBeenCalledTimes(3);
    expect(harness.warning).toHaveBeenCalledWith(
      expect.stringContaining("Approve workflow run 101 returned HTTP 504"),
    );
    expect(harness.setTimeout).toHaveBeenCalledWith(expect.any(Function), 250);
  });

  it("records an accepted-but-504 approval as success after an exact-run recheck", async () => {
    const harness = createHarness({
      approvalErrors: [{ status: 504 }, { status: 403 }],
      runsByPoll: [[actionRequiredRun(101)]],
      workflowRunsByGet: [
        actionRequiredRun(101),
        actionRequiredRun(101, { conclusion: null, status: "queued" }),
      ],
    });

    await runScript(harness);

    expect(harness.approveWorkflowRun).toHaveBeenCalledTimes(2);
    expect(harness.getWorkflowRun).toHaveBeenCalledTimes(2);
    expect(harness.getWorkflowRun).toHaveBeenLastCalledWith({
      owner: "NVIDIA",
      repo: "NemoClaw",
      request: { signal: expect.anything() },
      run_id: 101,
    });
    expect(harness.info).toHaveBeenCalledWith(
      expect.stringContaining("no longer requires approval after an ambiguous approval response"),
    );
    expect(harness.info).not.toHaveBeenCalledWith(
      expect.stringContaining("Approved pull_request workflow run 101"),
    );
    expect(harness.info).toHaveBeenCalledWith("Approved 1 exact-head workflow run(s) for PR #42");
  });

  it.each([
    403, 404,
  ])("records a concurrent approval as an exact-state no-op after HTTP %i", async (status) => {
    const harness = createHarness({
      approvalErrors: [{ status }],
      runsByPoll: [[actionRequiredRun(101)]],
      workflowRunsByGet: [actionRequiredRun(101, { conclusion: null, status: "queued" })],
    });

    await runScript(harness);

    expect(harness.approveWorkflowRun).toHaveBeenCalledOnce();
    expect(harness.getWorkflowRun).toHaveBeenCalledOnce();
    expect(harness.info).toHaveBeenCalledWith(
      expect.stringContaining("no longer requires approval after an ambiguous approval response"),
    );
    expect(harness.info).toHaveBeenCalledWith("Approved 1 exact-head workflow run(s) for PR #42");
  });

  it("fails closed after exhausting ambiguous approval retries", async () => {
    const finalFailure = { status: 504 };
    const harness = createHarness({
      approvalErrors: [{ status: 504 }, { status: 504 }, finalFailure],
      runsByPoll: [[actionRequiredRun(101)]],
    });

    await expect(runScript(harness)).rejects.toBe(finalFailure);

    expect(harness.approveWorkflowRun).toHaveBeenCalledTimes(3);
    expect(harness.getWorkflowRun).toHaveBeenCalledTimes(3);
    expect(harness.getCollaboratorPermissionLevel).toHaveBeenCalledTimes(4);
  });

  it("fails closed when exact-run reconciliation cannot be read", async () => {
    const recheckFailure = { status: 403 };
    const harness = createHarness({
      approvalErrors: [{ status: 504 }],
      runsByPoll: [[actionRequiredRun(101)]],
      workflowRunGetErrors: [recheckFailure],
    });

    await expect(runScript(harness)).rejects.toBe(recheckFailure);

    expect(harness.approveWorkflowRun).toHaveBeenCalledOnce();
    expect(harness.getWorkflowRun).toHaveBeenCalledOnce();
  });

  it("fails closed when an ambiguous approval recheck returns another run identity", async () => {
    const harness = createHarness({
      approvalErrors: [{ status: 504 }],
      runsByPoll: [[actionRequiredRun(101)]],
      workflowRunsByGet: [actionRequiredRun(101, { head_sha: MOVED_HEAD_SHA })],
    });

    await expect(runScript(harness)).rejects.toThrow(
      `Workflow run 101 no longer matches exact PR #${PR_NUMBER} at ${HEAD_SHA}`,
    );

    expect(harness.approveWorkflowRun).toHaveBeenCalledOnce();
    expect(harness.getWorkflowRun).toHaveBeenCalledOnce();
  });

  it("abandons an approval retry when the PR head changes during backoff", async () => {
    const harness = createHarness({
      approvalErrors: [{ status: 504 }],
      liveHeads: [HEAD_SHA, HEAD_SHA, HEAD_SHA, MOVED_HEAD_SHA],
      runsByPoll: [[actionRequiredRun(101)]],
    });

    await runScript(harness);

    expect(harness.approveWorkflowRun).toHaveBeenCalledOnce();
    expect(harness.warning).toHaveBeenCalledWith(
      expect.stringContaining("head changed before workflow-run approval"),
    );
    expect(harness.info).not.toHaveBeenCalledWith(
      expect.stringContaining("Approved pull_request workflow run 101"),
    );
  });

  it("abandons an approval retry when the author loses permission", async () => {
    const harness = createHarness({
      approvalErrors: [{ status: 504 }],
      runsByPoll: [[actionRequiredRun(101)]],
    });
    harness.getCollaboratorPermissionLevel
      .mockResolvedValueOnce({
        data: { permission: "write", role_name: "write", user: { login: "maintainer" } },
      })
      .mockResolvedValueOnce({
        data: { permission: "write", role_name: "write", user: { login: "maintainer" } },
      })
      .mockResolvedValueOnce({
        data: { permission: "read", role_name: "triage", user: { login: "maintainer" } },
      });

    await runScript(harness);

    expect(harness.approveWorkflowRun).toHaveBeenCalledOnce();
    expect(harness.getWorkflowRun).toHaveBeenCalledOnce();
    expect(harness.warning).toHaveBeenCalledWith(
      expect.stringContaining("no longer has write, maintain, or admin permission"),
    );
  });

  it("does not retry a non-transient GitHub API failure", async () => {
    const failure = { status: 403 };
    const harness = createHarness({ workflowRunErrors: [failure] });

    await expect(runScript(harness)).rejects.toBe(failure);

    expect(harness.listWorkflowRunsForRepo).toHaveBeenCalledOnce();
    expect(harness.approveWorkflowRun).not.toHaveBeenCalled();
    expect(harness.setTimeout).not.toHaveBeenCalled();
    expect(harness.warning).not.toHaveBeenCalledWith(expect.stringContaining("failed transiently"));
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
