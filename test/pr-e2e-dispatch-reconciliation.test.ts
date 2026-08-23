// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { GitHubApiError, type GitHubApiResponse } from "../tools/advisors/github.mts";
import {
  assertDispatchStillNotObserved,
  DispatchNotObservedError,
  DispatchReconciliationError,
  dispatchWorkflowWithReconciliation,
} from "../tools/e2e/pr-e2e-dispatch-reconciliation.mts";
import type { DispatchNotObservedReceipt } from "../tools/e2e/pr-e2e-retry-receipt.mts";

const REPOSITORY = "NVIDIA/NemoClaw";
const WORKFLOW_SHA = "d".repeat(40);
const CORRELATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const SENT_AT_MS = 1_785_050_400_000;
const WINDOW_MS = 100;
const POLL_MS = 25;

afterEach(() => {
  vi.restoreAllMocks();
});

function dispatchDetails(runId = 23) {
  return {
    workflow_run_id: runId,
    run_url: `https://api.github.com/repos/${REPOSITORY}/actions/runs/${runId}`,
    html_url: `https://github.com/${REPOSITORY}/actions/runs/${runId}`,
  };
}

function dispatchResponse(
  data: unknown,
  status = 200,
  requestId?: string,
): GitHubApiResponse<unknown> {
  return { data, status, ...(requestId === undefined ? {} : { requestId }) };
}

function workflowRun(runId = 23, overrides: Record<string, unknown> = {}) {
  return {
    id: runId,
    name: `E2E PR #42 (${CORRELATION_ID})`,
    path: ".github/workflows/e2e.yaml",
    workflow_id: 901,
    created_at: new Date(SENT_AT_MS + 10).toISOString(),
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: WORKFLOW_SHA,
    run_attempt: 1,
    status: "queued",
    conclusion: null,
    display_title: `E2E PR #42 (${CORRELATION_ID})`,
    url: `https://api.github.com/repos/${REPOSITORY}/actions/runs/${runId}`,
    html_url: `https://github.com/${REPOSITORY}/actions/runs/${runId}`,
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    actor: { login: "github-actions[bot]" },
    triggering_actor: { login: "github-actions[bot]" },
    ...overrides,
  };
}

function unrelatedWorkflowRun(runId: number) {
  return workflowRun(runId, {
    name: `E2E unrelated run ${runId}`,
    display_title: `E2E unrelated run ${runId}`,
  });
}

function inventory(runs: unknown[]) {
  return { total_count: runs.length, workflow_runs: runs };
}

function oldReceipt(
  overrides: Partial<DispatchNotObservedReceipt> = {},
): DispatchNotObservedReceipt {
  return {
    correlationId: CORRELATION_ID,
    workflowSha: WORKFLOW_SHA,
    sentAtMs: SENT_AT_MS,
    deadlineAtMs: SENT_AT_MS + WINDOW_MS,
    result: "not-observed",
    failureKind: "transport",
    ...overrides,
  };
}

function oldReceiptOptions(overrides: Partial<DispatchNotObservedReceipt> = {}) {
  return {
    repository: REPOSITORY,
    token: "token",
    prNumber: 42,
    receipt: oldReceipt(overrides),
  };
}

function paginatedInventoryApi(runs: unknown[]) {
  return vi.fn(async (apiPath: string) => {
    const page = Number(new URL(`https://api.github.com/${apiPath}`).searchParams.get("page"));
    return {
      total_count: runs.length,
      workflow_runs: runs.slice((page - 1) * 100, page * 100),
    };
  });
}

function reconciliationDeps(
  list: () => unknown | Promise<unknown>,
  getRun: (runId: number) => unknown | Promise<unknown> = (runId) => workflowRun(runId),
) {
  let clock = SENT_AT_MS;
  const api = vi.fn(async (apiPath: string) => {
    const runMatch = /\/actions\/runs\/([1-9][0-9]*)$/u.exec(apiPath);
    return runMatch ? getRun(Number(runMatch[1])) : list();
  });
  return {
    deps: {
      api,
      now: () => clock,
      sleep: async (milliseconds: number) => {
        clock += milliseconds;
      },
      reconciliationWindowMs: WINDOW_MS,
      pollIntervalMs: POLL_MS,
      clockSkewMs: 10,
    },
    api,
  };
}

function dispatchOptions(dispatch: (signal: AbortSignal) => Promise<GitHubApiResponse<unknown>>) {
  return {
    repository: REPOSITORY,
    token: "token",
    workflowSha: WORKFLOW_SHA,
    correlationId: CORRELATION_ID,
    prNumber: 42,
    dispatch,
  };
}

describe("PR E2E workflow dispatch reconciliation", () => {
  it("accepts exact synchronous dispatch details without reading inventory", async () => {
    const dispatch = vi.fn().mockResolvedValue(dispatchResponse(dispatchDetails()));
    const { deps, api } = reconciliationDeps(() => inventory([]));

    await expect(
      dispatchWorkflowWithReconciliation(dispatchOptions(dispatch), deps),
    ).resolves.toEqual({
      runId: 23,
      source: "dispatch-response",
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(api).not.toHaveBeenCalled();
  });

  it.each([
    400, 401, 403, 404, 409, 422,
  ])("treats HTTP %i as a definitive rejection without polling", async (status) => {
    const rejection = new GitHubApiError({
      kind: "http",
      method: "POST",
      apiPath: `repos/${REPOSITORY}/actions/workflows/e2e.yaml/dispatches`,
      status,
      responseText: "rejected",
    });
    const dispatch = vi.fn().mockRejectedValue(rejection);
    const { deps, api } = reconciliationDeps(() => inventory([]));

    await expect(dispatchWorkflowWithReconciliation(dispatchOptions(dispatch), deps)).rejects.toBe(
      rejection,
    );
    expect(dispatch).toHaveBeenCalledOnce();
    expect(api).not.toHaveBeenCalled();
  });

  it("adopts one exact child after a server error and a full settling window", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const dispatch = vi.fn().mockRejectedValue(
      new GitHubApiError({
        kind: "http",
        method: "POST",
        apiPath: `repos/${REPOSITORY}/actions/workflows/e2e.yaml/dispatches`,
        status: 500,
        requestId: "ABCD:1234",
        responseText: "unavailable",
      }),
    );
    const { deps, api } = reconciliationDeps(() => inventory([workflowRun()]));

    await expect(
      dispatchWorkflowWithReconciliation(dispatchOptions(dispatch), deps),
    ).resolves.toEqual({
      runId: 23,
      source: "workflow-run-inventory",
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(api.mock.calls.filter(([apiPath]) => String(apiPath).includes("/runs?"))).toHaveLength(
      5,
    );
    expect(api.mock.calls.at(-1)?.[0]).toBe(`repos/${REPOSITORY}/actions/runs/23`);
  });

  it("waits for delayed run visibility after transport response loss", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const dispatch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    let reads = 0;
    const { deps } = reconciliationDeps(() => {
      reads += 1;
      return inventory(reads < 3 ? [] : [workflowRun()]);
    });

    await expect(
      dispatchWorkflowWithReconciliation(dispatchOptions(dispatch), deps),
    ).resolves.toEqual({
      runId: 23,
      source: "workflow-run-inventory",
    });
    expect(reads).toBe(5);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("bounds a lost dispatch response before entering read-only reconciliation", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let dispatchSignal: AbortSignal | undefined;
    const dispatch = vi.fn(
      (signal: AbortSignal) =>
        new Promise<GitHubApiResponse<unknown>>(() => {
          dispatchSignal = signal;
        }),
    );
    const { deps } = reconciliationDeps(() => inventory([]));

    await expect(
      dispatchWorkflowWithReconciliation(dispatchOptions(dispatch), {
        ...deps,
        dispatchTimeoutMs: 10,
      }),
    ).rejects.toBeInstanceOf(DispatchNotObservedError);
    expect(dispatchSignal?.aborted).toBe(true);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("fails closed when a workflow inventory read exceeds its request deadline", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dispatch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const { deps } = reconciliationDeps(() => new Promise<never>(() => undefined));

    await expect(
      dispatchWorkflowWithReconciliation(dispatchOptions(dispatch), {
        ...deps,
        apiTimeoutMs: 10,
      }),
    ).rejects.toThrow(/complete run inventory/u);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("records a strict retry receipt only after a complete zero-match window", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dispatch = vi
      .fn()
      .mockResolvedValue(dispatchResponse({ malformed: true }, 200, "MALFORMED:1234"));
    const { deps, api } = reconciliationDeps(() => inventory([]));

    const error = await dispatchWorkflowWithReconciliation(dispatchOptions(dispatch), deps).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(DispatchNotObservedError);
    expect(error).toMatchObject({
      receipt: {
        correlationId: CORRELATION_ID,
        workflowSha: WORKFLOW_SHA,
        sentAtMs: SENT_AT_MS,
        deadlineAtMs: SENT_AT_MS + WINDOW_MS,
        result: "not-observed",
        failureKind: "validation",
        status: 200,
        requestId: "MALFORMED:1234",
      },
    });
    expect((error as DispatchNotObservedError).marker()).toMatch(
      /^<!-- nemoclaw-pr-e2e-dispatch:v1:[A-Za-z0-9_-]+ -->$/u,
    );
    expect(api).toHaveBeenCalledTimes(5);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("fails closed when two correlated children become visible", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dispatch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    let reads = 0;
    const { deps } = reconciliationDeps(() => {
      reads += 1;
      return inventory(reads < 3 ? [workflowRun(23)] : [workflowRun(23), workflowRun(24)]);
    });

    await expect(
      dispatchWorkflowWithReconciliation(dispatchOptions(dispatch), deps),
    ).rejects.toMatchObject({
      name: "DispatchReconciliationError",
      candidateRunIds: [23, 24],
    });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("keeps collecting correlated run IDs after a malformed child", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dispatch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    let reads = 0;
    const malformedRun = workflowRun(24, { path: ".github/workflows/other.yaml" });
    const { deps } = reconciliationDeps(() => {
      reads += 1;
      return inventory(reads === 1 ? [malformedRun] : [malformedRun, workflowRun(23)]);
    });

    await expect(
      dispatchWorkflowWithReconciliation(dispatchOptions(dispatch), deps),
    ).rejects.toMatchObject({
      name: "DispatchReconciliationError",
      message: expect.stringMatching(/failed path validation/u),
      candidateRunIds: [23, 24],
    });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("retains malformed correlated run IDs when a later inventory read fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dispatch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    let reads = 0;
    const { deps } = reconciliationDeps(() => {
      reads += 1;
      return reads > 1
        ? Promise.reject(new TypeError("inventory unavailable"))
        : inventory([workflowRun(24, { path: ".github/workflows/other.yaml" })]);
    });

    await expect(
      dispatchWorkflowWithReconciliation(dispatchOptions(dispatch), deps),
    ).rejects.toMatchObject({
      name: "DispatchReconciliationError",
      message: expect.stringMatching(/complete run inventory/u),
      candidateRunIds: [24],
    });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it.each([
    ["run name", { name: "E2E / Main and Manual Suite" }],
    ["display title", { display_title: "E2E unrelated" }],
    ["workflow path", { path: ".github/workflows/other.yaml" }],
    ["main branch", { head_branch: "release" }],
    ["workflow SHA", { head_sha: "e".repeat(40) }],
    ["first attempt", { run_attempt: 2 }],
    ["canonical API URL", { url: `https://api.github.com/repos/${REPOSITORY}/actions/runs/24` }],
    ["canonical HTML URL", { html_url: `https://github.com/${REPOSITORY}/actions/runs/24` }],
    ["creation window", { created_at: new Date(SENT_AT_MS - 11).toISOString() }],
    ["GitHub Actions actor", { actor: { login: "maintainer" } }],
  ])("rejects a correlated run with the wrong %s", async (_label, overrides) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dispatch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const { deps } = reconciliationDeps(() => inventory([workflowRun(23, overrides)]));

    await expect(
      dispatchWorkflowWithReconciliation(dispatchOptions(dispatch), deps),
    ).rejects.toBeInstanceOf(DispatchReconciliationError);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("fails closed when the run inventory is incomplete", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dispatch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const { deps } = reconciliationDeps(() => ({
      total_count: 2,
      workflow_runs: [workflowRun()],
    }));

    await expect(
      dispatchWorkflowWithReconciliation(dispatchOptions(dispatch), deps),
    ).rejects.toThrow(/complete run inventory/u);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("fails closed when the final run read changes authenticated identity", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dispatch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const { deps } = reconciliationDeps(
      () => inventory([workflowRun()]),
      () => workflowRun(23, { head_branch: "release" }),
    );

    await expect(
      dispatchWorkflowWithReconciliation(dispatchOptions(dispatch), deps),
    ).rejects.toMatchObject({
      name: "DispatchReconciliationError",
      candidateRunIds: [23],
    });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("rechecks an old zero-match receipt before replacement", async () => {
    const { deps, api } = reconciliationDeps(() => inventory([]));

    await expect(
      assertDispatchStillNotObserved(oldReceiptOptions({ failureKind: "http", status: 500 }), deps),
    ).resolves.toBeUndefined();
    expect(api).toHaveBeenCalledOnce();
  });

  it("paginates a stale zero-match receipt before allowing replacement", async () => {
    const runs = Array.from({ length: 101 }, (_value, index) => unrelatedWorkflowRun(index + 100));
    const api = paginatedInventoryApi(runs);

    await expect(
      assertDispatchStillNotObserved(oldReceiptOptions(), {
        api,
        now: () => SENT_AT_MS + WINDOW_MS + 2_000,
        clockSkewMs: 10,
      }),
    ).resolves.toBeUndefined();
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("accepts a complete stale receipt inventory at GitHub's filtered-result cap", async () => {
    const runs = Array.from({ length: 1_000 }, (_value, index) =>
      unrelatedWorkflowRun(index + 100),
    );
    const api = paginatedInventoryApi(runs);

    await expect(
      assertDispatchStillNotObserved(oldReceiptOptions(), {
        api,
        now: () => SENT_AT_MS + WINDOW_MS + 2_000,
        clockSkewMs: 10,
      }),
    ).resolves.toBeUndefined();
    expect(api).toHaveBeenCalledTimes(10);
    expect(
      api.mock.calls.map(([apiPath]) =>
        Number(new URL(`https://api.github.com/${apiPath}`).searchParams.get("page")),
      ),
    ).toEqual(Array.from({ length: 10 }, (_value, index) => index + 1));
  });

  it("blocks replacement when the old correlation appears after the first inventory page", async () => {
    const recheckTime = SENT_AT_MS + WINDOW_MS + 2_000;
    const runs = [
      ...Array.from({ length: 100 }, (_value, index) => unrelatedWorkflowRun(index + 100)),
      workflowRun(501, {
        created_at: new Date(SENT_AT_MS + WINDOW_MS + 1_000).toISOString(),
      }),
    ];
    const api = paginatedInventoryApi(runs);

    await expect(
      assertDispatchStillNotObserved(oldReceiptOptions(), {
        api,
        now: () => recheckTime,
        clockSkewMs: 10,
      }),
    ).rejects.toMatchObject({
      name: "DispatchReconciliationError",
      candidateRunIds: [501],
    });
    expect(api).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      label: "the total count changes",
      secondPage: {
        total_count: 102,
        workflow_runs: [unrelatedWorkflowRun(500)],
      },
    },
    {
      label: "a run ID is duplicated",
      secondPage: {
        total_count: 101,
        workflow_runs: [unrelatedWorkflowRun(100)],
      },
    },
  ])("fails closed when paginated receipt inventory $label", async ({ secondPage }) => {
    const firstPageRuns = Array.from({ length: 100 }, (_value, index) =>
      unrelatedWorkflowRun(index + 100),
    );
    const pages = [{ total_count: 101, workflow_runs: firstPageRuns }, secondPage];
    const api = vi.fn(async (apiPath: string) => {
      const page = Number(new URL(`https://api.github.com/${apiPath}`).searchParams.get("page"));
      return pages[page - 1];
    });

    await expect(
      assertDispatchStillNotObserved(oldReceiptOptions(), {
        api,
        now: () => SENT_AT_MS + WINDOW_MS + 2_000,
        clockSkewMs: 10,
      }),
    ).rejects.toThrow(/could not be rechecked/u);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("fails closed when a stale receipt inventory exceeds GitHub's filtered-result cap", async () => {
    const api = vi.fn().mockResolvedValue({
      total_count: 1_001,
      workflow_runs: Array.from({ length: 100 }, (_value, index) =>
        unrelatedWorkflowRun(index + 100),
      ),
    });

    await expect(
      assertDispatchStillNotObserved(oldReceiptOptions(), {
        api,
        now: () => SENT_AT_MS + WINDOW_MS + 2_000,
        clockSkewMs: 10,
      }),
    ).rejects.toThrow(/could not be rechecked/u);
    expect(api).toHaveBeenCalledOnce();
  });

  it("blocks replacement when a late child appears for the old correlation", async () => {
    const recheckTime = SENT_AT_MS + WINDOW_MS + 2_000;
    const lateRun = workflowRun(23, {
      created_at: new Date(SENT_AT_MS + WINDOW_MS + 1_000).toISOString(),
    });
    const { deps, api } = reconciliationDeps(() => inventory([lateRun]));

    await expect(
      assertDispatchStillNotObserved(oldReceiptOptions(), { ...deps, now: () => recheckTime }),
    ).rejects.toMatchObject({
      name: "DispatchReconciliationError",
      candidateRunIds: [23],
    });
    const inventoryUrl = new URL(`https://api.github.com/${String(api.mock.calls[0]?.[0])}`);
    expect(inventoryUrl.searchParams.get("created")).toBe(
      `${new Date(SENT_AT_MS - 10).toISOString()}..${new Date(recheckTime + 10).toISOString()}`,
    );
  });
});
