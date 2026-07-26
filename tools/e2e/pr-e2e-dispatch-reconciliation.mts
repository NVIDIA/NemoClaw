// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  GitHubApiError,
  type GitHubApiResponse,
  type GitHubRequestOptions,
  githubApi,
} from "../advisors/github.mts";
import {
  type DispatchFailureKind,
  type DispatchNotObservedReceipt,
  dispatchNotObservedReceiptMarker,
  MAX_DISPATCH_RECONCILIATION_WINDOW_MS,
} from "./pr-e2e-retry-receipt.mts";

const E2E_WORKFLOW = "e2e.yaml";
const E2E_WORKFLOW_PATH = `.github/workflows/${E2E_WORKFLOW}`;
const USER_AGENT = "nemoclaw-pr-e2e-dispatch-reconciliation";
const DEFAULT_RECONCILIATION_WINDOW_MS = 45_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_CLOCK_SKEW_MS = 10_000;
const DEFAULT_DISPATCH_TIMEOUT_MS = 10_000;
const DEFAULT_API_TIMEOUT_MS = 5_000;
const MAX_DISPATCH_TIMEOUT_MS = 30_000;
const MAX_API_TIMEOUT_MS = 10_000;
const MAX_DISPATCH_AND_RECONCILIATION_BUDGET_MS = 65_000;
const MAX_WORKFLOW_RUNS = 100;
const MAX_WORKFLOW_RUN_PAGES = 10;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const CORRELATION_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const GITHUB_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

export type WorkflowDispatchDetails = {
  workflow_run_id: number;
  run_url: string;
  html_url: string;
};

export type DispatchReconciliationResult = {
  runId: number;
  source: "dispatch-response" | "workflow-run-inventory";
};

type WorkflowRun = {
  id: number;
  name: string;
  path: string;
  workflowId: number;
  createdAt: string;
  event: string;
  headBranch: string;
  headSha: string;
  runAttempt: number;
  status: string;
  conclusion: string | null;
  displayTitle: string;
  apiUrl: string;
  htmlUrl: string;
  repository: string;
  headRepository: string;
  actor: string;
  triggeringActor: string;
};

type WorkflowRunInventory = {
  totalCount: number;
  runs: WorkflowRun[];
};

type DispatchDiagnostics = {
  failureKind: DispatchFailureKind;
  status?: number;
  requestId?: string;
};

type GithubApi = (
  apiPath: string,
  token: string,
  options?: GitHubRequestOptions,
) => Promise<unknown>;

export type DispatchReconciliationDeps = {
  api?: GithubApi;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  reconciliationWindowMs?: number;
  pollIntervalMs?: number;
  clockSkewMs?: number;
  dispatchTimeoutMs?: number;
  apiTimeoutMs?: number;
};

export class DispatchNotObservedError extends Error {
  readonly receipt: DispatchNotObservedReceipt;

  constructor(receipt: DispatchNotObservedReceipt) {
    const diagnostics = [
      `kind=${receipt.failureKind}`,
      receipt.status === undefined ? undefined : `status=${receipt.status}`,
      receipt.requestId === undefined ? undefined : `request_id=${receipt.requestId}`,
      `correlation=${receipt.correlationId}`,
    ]
      .filter((part): part is string => Boolean(part))
      .join(" ");
    super(`Workflow dispatch was not observed after bounded reconciliation (${diagnostics})`);
    this.name = "DispatchNotObservedError";
    this.receipt = receipt;
  }

  marker(): string {
    return dispatchNotObservedReceiptMarker(this.receipt);
  }
}

export class DispatchReconciliationError extends Error {
  readonly candidateRunIds: readonly number[];

  constructor(message: string, candidateRunIds: readonly number[] = [], cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DispatchReconciliationError";
    this.candidateRunIds = [...candidateRunIds];
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

async function boundedOperation<T>(
  label: string,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function validatedTimeout(value: number, name: string, maximum: number): number {
  if (!positiveSafeInteger(value) || value > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}ms`);
  }
  return value;
}

function assertDispatchIdentity(options: {
  repository: string;
  workflowSha: string;
  correlationId: string;
  prNumber: number;
}): void {
  if (
    !REPOSITORY_PATTERN.test(options.repository) ||
    !SHA_PATTERN.test(options.workflowSha) ||
    !CORRELATION_PATTERN.test(options.correlationId) ||
    !positiveSafeInteger(options.prNumber)
  ) {
    throw new Error("Workflow dispatch reconciliation identity is invalid");
  }
}

function assertTimingOptions(options: {
  sentAtMs: number;
  reconciliationWindowMs: number;
  pollIntervalMs: number;
  clockSkewMs: number;
}): void {
  if (
    !positiveSafeInteger(options.sentAtMs) ||
    !positiveSafeInteger(options.reconciliationWindowMs) ||
    options.reconciliationWindowMs > MAX_DISPATCH_RECONCILIATION_WINDOW_MS ||
    !positiveSafeInteger(options.pollIntervalMs) ||
    options.pollIntervalMs > options.reconciliationWindowMs ||
    !Number.isSafeInteger(options.clockSkewMs) ||
    options.clockSkewMs < 0 ||
    options.clockSkewMs > 30_000
  ) {
    throw new Error("Workflow dispatch reconciliation timing is invalid");
  }
}

export function validateWorkflowDispatchDetails(
  value: unknown,
  repository: string,
): WorkflowDispatchDetails {
  if (!isObjectRecord(value)) throw new Error("GitHub returned invalid workflow dispatch details");
  const runId = value.workflow_run_id;
  if (!positiveSafeInteger(runId)) {
    throw new Error("GitHub returned an invalid dispatched workflow run id");
  }
  const expectedApiUrl = `https://api.github.com/repos/${repository}/actions/runs/${runId}`;
  const expectedHtmlUrl = `https://github.com/${repository}/actions/runs/${runId}`;
  if (value.run_url !== expectedApiUrl || value.html_url !== expectedHtmlUrl) {
    throw new Error("GitHub returned mismatched workflow dispatch URLs");
  }
  return value as WorkflowDispatchDetails;
}

function validateWorkflowRun(value: unknown): WorkflowRun {
  if (
    !isObjectRecord(value) ||
    !positiveSafeInteger(value.id) ||
    typeof value.name !== "string" ||
    typeof value.path !== "string" ||
    !positiveSafeInteger(value.workflow_id) ||
    typeof value.created_at !== "string" ||
    !GITHUB_TIMESTAMP_PATTERN.test(value.created_at) ||
    !Number.isFinite(Date.parse(value.created_at)) ||
    typeof value.event !== "string" ||
    typeof value.head_branch !== "string" ||
    typeof value.head_sha !== "string" ||
    !SHA_PATTERN.test(value.head_sha) ||
    !positiveSafeInteger(value.run_attempt) ||
    typeof value.status !== "string" ||
    (value.conclusion !== null && typeof value.conclusion !== "string") ||
    typeof value.display_title !== "string" ||
    typeof value.url !== "string" ||
    typeof value.html_url !== "string" ||
    !isObjectRecord(value.repository) ||
    typeof value.repository.full_name !== "string" ||
    !isObjectRecord(value.head_repository) ||
    typeof value.head_repository.full_name !== "string" ||
    !isObjectRecord(value.actor) ||
    typeof value.actor.login !== "string" ||
    !isObjectRecord(value.triggering_actor) ||
    typeof value.triggering_actor.login !== "string"
  ) {
    throw new Error("GitHub returned an invalid workflow run");
  }
  return {
    id: value.id,
    name: value.name,
    path: value.path,
    workflowId: value.workflow_id,
    createdAt: value.created_at,
    event: value.event,
    headBranch: value.head_branch,
    headSha: value.head_sha,
    runAttempt: value.run_attempt,
    status: value.status,
    conclusion: value.conclusion,
    displayTitle: value.display_title,
    apiUrl: value.url,
    htmlUrl: value.html_url,
    repository: value.repository.full_name,
    headRepository: value.head_repository.full_name,
    actor: value.actor.login,
    triggeringActor: value.triggering_actor.login,
  };
}

function validateWorkflowRunInventoryPage(value: unknown): WorkflowRunInventory {
  if (
    !isObjectRecord(value) ||
    !Number.isSafeInteger(value.total_count) ||
    (value.total_count as number) < 0 ||
    !Array.isArray(value.workflow_runs) ||
    value.workflow_runs.length > MAX_WORKFLOW_RUNS ||
    value.workflow_runs.length > (value.total_count as number)
  ) {
    throw new Error("GitHub returned an invalid or incomplete workflow run listing");
  }
  const runs = value.workflow_runs.map(validateWorkflowRun);
  if (new Set(runs.map((run) => run.id)).size !== runs.length) {
    throw new Error("GitHub returned duplicate workflow run IDs");
  }
  return { totalCount: value.total_count as number, runs };
}

function validateWorkflowRunInventory(value: unknown): WorkflowRunInventory {
  const inventory = validateWorkflowRunInventoryPage(value);
  if (inventory.runs.length !== inventory.totalCount) {
    throw new Error("GitHub returned an invalid or incomplete workflow run listing");
  }
  return inventory;
}

function inventoryApiPath(options: {
  repository: string;
  workflowSha: string;
  lowerBoundMs: number;
  upperBoundMs: number;
  page?: number;
}): string {
  const created = `${new Date(options.lowerBoundMs).toISOString()}..${new Date(options.upperBoundMs).toISOString()}`;
  const query = new URLSearchParams({
    branch: "main",
    event: "workflow_dispatch",
    head_sha: options.workflowSha,
    created,
    per_page: String(MAX_WORKFLOW_RUNS),
    ...(options.page === undefined ? {} : { page: String(options.page) }),
  });
  return `repos/${options.repository}/actions/workflows/${E2E_WORKFLOW}/runs?${query}`;
}

async function readPaginatedInventory(
  options: {
    repository: string;
    token: string;
    workflowSha: string;
    lowerBoundMs: number;
    upperBoundMs: number;
  },
  api: GithubApi,
  timeoutMs: number,
): Promise<WorkflowRunInventory> {
  return boundedOperation("Paginated workflow run inventory read", timeoutMs, async (signal) => {
    const runs: WorkflowRun[] = [];
    const runIds = new Set<number>();
    let totalCount: number | undefined;
    for (let page = 1; page <= MAX_WORKFLOW_RUN_PAGES; page += 1) {
      const inventory = validateWorkflowRunInventoryPage(
        await api(inventoryApiPath({ ...options, page }), options.token, {
          userAgent: USER_AGENT,
          signal,
        }),
      );
      totalCount ??= inventory.totalCount;
      if (
        inventory.totalCount !== totalCount ||
        totalCount > MAX_WORKFLOW_RUNS * MAX_WORKFLOW_RUN_PAGES
      ) {
        throw new Error("GitHub returned an unstable or oversized workflow run listing");
      }
      for (const run of inventory.runs) {
        if (runIds.has(run.id)) {
          throw new Error("GitHub returned duplicate workflow run IDs across pages");
        }
        runIds.add(run.id);
        runs.push(run);
      }
      if (runs.length === totalCount) return { totalCount, runs };
      if (runs.length > totalCount || inventory.runs.length < MAX_WORKFLOW_RUNS) {
        throw new Error("GitHub returned an invalid or incomplete workflow run listing");
      }
    }
    throw new Error("GitHub returned an incomplete workflow run listing after pagination");
  });
}

async function readInventory(
  options: {
    repository: string;
    token: string;
    workflowSha: string;
    lowerBoundMs: number;
    upperBoundMs: number;
  },
  api: GithubApi,
  timeoutMs: number,
): Promise<WorkflowRunInventory> {
  return validateWorkflowRunInventory(
    await boundedOperation("Workflow run inventory read", timeoutMs, (signal) =>
      api(inventoryApiPath(options), options.token, { userAgent: USER_AGENT, signal }),
    ),
  );
}

function expectedRunTitle(prNumber: number, correlationId: string): string {
  return `E2E PR #${prNumber} (${correlationId})`;
}

function workflowRunIdentity(run: WorkflowRun): string {
  return JSON.stringify({
    id: run.id,
    name: run.name,
    path: run.path,
    workflowId: run.workflowId,
    createdAt: run.createdAt,
    event: run.event,
    headBranch: run.headBranch,
    headSha: run.headSha,
    runAttempt: run.runAttempt,
    displayTitle: run.displayTitle,
    apiUrl: run.apiUrl,
    htmlUrl: run.htmlUrl,
    repository: run.repository,
    headRepository: run.headRepository,
    actor: run.actor,
    triggeringActor: run.triggeringActor,
  });
}

function candidateMismatch(
  run: WorkflowRun,
  options: {
    repository: string;
    workflowSha: string;
    correlationId: string;
    prNumber: number;
    lowerBoundMs: number;
    upperBoundMs: number;
  },
): string | undefined {
  const expectedApiUrl = `https://api.github.com/repos/${options.repository}/actions/runs/${run.id}`;
  const expectedHtmlUrl = `https://github.com/${options.repository}/actions/runs/${run.id}`;
  const createdAtMs = Date.parse(run.createdAt);
  const title = expectedRunTitle(options.prNumber, options.correlationId);
  const checks: Array<[string, boolean]> = [
    ["name", run.name === title],
    ["path", run.path === E2E_WORKFLOW_PATH],
    ["event", run.event === "workflow_dispatch"],
    ["head_branch", run.headBranch === "main"],
    ["head_sha", run.headSha === options.workflowSha],
    ["run_attempt", run.runAttempt === 1],
    ["display_title", run.displayTitle === title],
    ["url", run.apiUrl === expectedApiUrl],
    ["html_url", run.htmlUrl === expectedHtmlUrl],
    ["repository", run.repository === options.repository],
    ["head_repository", run.headRepository === options.repository],
    ["actor", run.actor === "github-actions[bot]"],
    ["triggering_actor", run.triggeringActor === "github-actions[bot]"],
    ["created_at", createdAtMs >= options.lowerBoundMs && createdAtMs <= options.upperBoundMs],
  ];
  return checks.find(([, matches]) => !matches)?.[0];
}

function scanInventory(
  inventory: WorkflowRunInventory,
  options: {
    repository: string;
    workflowSha: string;
    correlationId: string;
    prNumber: number;
    lowerBoundMs: number;
    upperBoundMs: number;
  },
  candidates: Map<number, WorkflowRun>,
  correlatedRunIds: Set<number>,
): string | undefined {
  let contradiction: string | undefined;
  for (const run of inventory.runs) {
    if (
      !run.name.includes(options.correlationId) &&
      !run.displayTitle.includes(options.correlationId)
    ) {
      continue;
    }
    correlatedRunIds.add(run.id);
    const mismatch = candidateMismatch(run, options);
    if (mismatch) {
      contradiction ??= `correlated workflow run failed ${mismatch} validation`;
      continue;
    }
    const existing = candidates.get(run.id);
    if (existing && workflowRunIdentity(existing) !== workflowRunIdentity(run)) {
      contradiction ??= "correlated workflow run identity changed between inventory reads";
      continue;
    }
    candidates.set(run.id, run);
  }
  return contradiction;
}

function dispatchDiagnostics(error: unknown): DispatchDiagnostics {
  if (error instanceof GitHubApiError) {
    return {
      failureKind: error.kind,
      status: error.status,
      requestId: error.requestId,
    };
  }
  return { failureKind: "transport" };
}

function diagnosticsText(diagnostics: DispatchDiagnostics): string {
  return [
    `kind=${diagnostics.failureKind}`,
    diagnostics.status === undefined ? undefined : `status=${diagnostics.status}`,
    diagnostics.requestId === undefined ? undefined : `request_id=${diagnostics.requestId}`,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

async function reconcileWorkflowDispatch(
  options: {
    repository: string;
    token: string;
    workflowSha: string;
    correlationId: string;
    prNumber: number;
    sentAtMs: number;
    diagnostics: DispatchDiagnostics;
  },
  deps: DispatchReconciliationDeps,
): Promise<DispatchReconciliationResult> {
  const api =
    deps.api ??
    ((apiPath, token, requestOptions) => githubApi<unknown>(apiPath, token, requestOptions));
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
      }));
  const reconciliationWindowMs = deps.reconciliationWindowMs ?? DEFAULT_RECONCILIATION_WINDOW_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const clockSkewMs = deps.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
  const apiTimeoutMs = validatedTimeout(
    deps.apiTimeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    "GitHub API timeout",
    MAX_API_TIMEOUT_MS,
  );
  assertTimingOptions({
    sentAtMs: options.sentAtMs,
    reconciliationWindowMs,
    pollIntervalMs,
    clockSkewMs,
  });
  const reconciliationStartedAtMs = Math.max(now(), options.sentAtMs);
  const deadlineAtMs = reconciliationStartedAtMs + reconciliationWindowMs;
  const lowerBoundMs = options.sentAtMs - clockSkewMs;
  const upperBoundMs = deadlineAtMs + clockSkewMs;
  const candidates = new Map<number, WorkflowRun>();
  const correlatedRunIds = new Set<number>();
  let contradiction: string | undefined;

  console.warn(
    `Workflow dispatch response uncertain: correlation=${options.correlationId} ${diagnosticsText(options.diagnostics)} result=reconciling`,
  );
  while (true) {
    let inventory: WorkflowRunInventory;
    try {
      inventory = await readInventory(
        {
          repository: options.repository,
          token: options.token,
          workflowSha: options.workflowSha,
          lowerBoundMs,
          upperBoundMs,
        },
        api,
        apiTimeoutMs,
      );
    } catch (error) {
      throw new DispatchReconciliationError(
        `Workflow dispatch reconciliation could not read a complete run inventory (${diagnosticsText(options.diagnostics)})`,
        [...correlatedRunIds].sort((left, right) => left - right),
        error,
      );
    }
    const inventoryContradiction = scanInventory(
      inventory,
      {
        repository: options.repository,
        workflowSha: options.workflowSha,
        correlationId: options.correlationId,
        prNumber: options.prNumber,
        lowerBoundMs,
        upperBoundMs,
      },
      candidates,
      correlatedRunIds,
    );
    contradiction ??= inventoryContradiction;
    const currentTime = now();
    if (currentTime >= deadlineAtMs) break;
    await sleep(Math.min(pollIntervalMs, deadlineAtMs - currentTime));
  }

  const candidateRunIds = [...correlatedRunIds].sort((left, right) => left - right);
  if (contradiction || candidateRunIds.length > 1) {
    throw new DispatchReconciliationError(
      `Workflow dispatch reconciliation is ambiguous: ${contradiction ?? "multiple correlated runs were observed"} (${diagnosticsText(options.diagnostics)})`,
      candidateRunIds,
    );
  }
  if (candidateRunIds.length === 0) {
    const receipt: DispatchNotObservedReceipt = {
      correlationId: options.correlationId,
      workflowSha: options.workflowSha,
      sentAtMs: options.sentAtMs,
      deadlineAtMs,
      result: "not-observed",
      failureKind: options.diagnostics.failureKind,
      ...(options.diagnostics.status === undefined ? {} : { status: options.diagnostics.status }),
      ...(options.diagnostics.requestId === undefined
        ? {}
        : { requestId: options.diagnostics.requestId }),
    };
    console.warn(
      `Workflow dispatch reconciliation complete: correlation=${options.correlationId} ${diagnosticsText(options.diagnostics)} result=not-observed`,
    );
    throw new DispatchNotObservedError(receipt);
  }

  const runId = candidateRunIds[0]!;
  let confirmed: WorkflowRun;
  try {
    confirmed = validateWorkflowRun(
      await boundedOperation("Correlated workflow run read", apiTimeoutMs, (signal) =>
        api(`repos/${options.repository}/actions/runs/${runId}`, options.token, {
          userAgent: USER_AGENT,
          signal,
        }),
      ),
    );
  } catch (error) {
    throw new DispatchReconciliationError(
      `Workflow dispatch reconciliation could not authenticate correlated run ${runId}`,
      candidateRunIds,
      error,
    );
  }
  const mismatch = candidateMismatch(confirmed, {
    repository: options.repository,
    workflowSha: options.workflowSha,
    correlationId: options.correlationId,
    prNumber: options.prNumber,
    lowerBoundMs,
    upperBoundMs,
  });
  if (mismatch || workflowRunIdentity(confirmed) !== workflowRunIdentity(candidates.get(runId)!)) {
    throw new DispatchReconciliationError(
      `Workflow dispatch reconciliation could not confirm correlated run ${runId}${mismatch ? ` (${mismatch})` : ""}`,
      candidateRunIds,
    );
  }
  console.log(
    `Workflow dispatch reconciliation complete: correlation=${options.correlationId} run=${runId} ${diagnosticsText(options.diagnostics)} result=adopted`,
  );
  return { runId, source: "workflow-run-inventory" };
}

export async function dispatchWorkflowWithReconciliation(
  options: {
    repository: string;
    token: string;
    workflowSha: string;
    correlationId: string;
    prNumber: number;
    dispatch: (signal: AbortSignal) => Promise<GitHubApiResponse<unknown>>;
  },
  deps: DispatchReconciliationDeps = {},
): Promise<DispatchReconciliationResult> {
  assertDispatchIdentity(options);
  if (!options.token) throw new Error("GitHub token is required");
  const now = deps.now ?? Date.now;
  const sentAtMs = now();
  const dispatchTimeoutMs = validatedTimeout(
    deps.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS,
    "Workflow dispatch timeout",
    MAX_DISPATCH_TIMEOUT_MS,
  );
  const reconciliationWindowMs = deps.reconciliationWindowMs ?? DEFAULT_RECONCILIATION_WINDOW_MS;
  const apiTimeoutMs = validatedTimeout(
    deps.apiTimeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    "GitHub API timeout",
    MAX_API_TIMEOUT_MS,
  );
  assertTimingOptions({
    sentAtMs,
    reconciliationWindowMs,
    pollIntervalMs: deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    clockSkewMs: deps.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS,
  });
  if (
    dispatchTimeoutMs + reconciliationWindowMs + apiTimeoutMs * 2 >
    MAX_DISPATCH_AND_RECONCILIATION_BUDGET_MS
  ) {
    throw new Error("Workflow dispatch and reconciliation exceed the authorization time budget");
  }
  let response: GitHubApiResponse<unknown>;
  try {
    response = await boundedOperation("Workflow dispatch request", dispatchTimeoutMs, (signal) =>
      options.dispatch(signal),
    );
  } catch (error) {
    if (
      error instanceof GitHubApiError &&
      error.kind === "http" &&
      error.status >= 400 &&
      error.status < 500
    ) {
      throw error;
    }
    return reconcileWorkflowDispatch(
      {
        ...options,
        sentAtMs,
        diagnostics: dispatchDiagnostics(error),
      },
      deps,
    );
  }
  try {
    const details = validateWorkflowDispatchDetails(response.data, options.repository);
    return { runId: details.workflow_run_id, source: "dispatch-response" };
  } catch {
    return reconcileWorkflowDispatch(
      {
        ...options,
        sentAtMs,
        diagnostics: {
          failureKind: "validation",
          status: response.status,
          requestId: response.requestId,
        },
      },
      deps,
    );
  }
}

export async function assertDispatchStillNotObserved(
  options: {
    repository: string;
    token: string;
    prNumber: number;
    receipt: DispatchNotObservedReceipt;
  },
  deps: Pick<DispatchReconciliationDeps, "api" | "apiTimeoutMs" | "clockSkewMs" | "now"> = {},
): Promise<void> {
  assertDispatchIdentity({
    repository: options.repository,
    workflowSha: options.receipt.workflowSha,
    correlationId: options.receipt.correlationId,
    prNumber: options.prNumber,
  });
  if (!options.token) throw new Error("GitHub token is required");
  const clockSkewMs = deps.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
  const reconciliationWindowMs = options.receipt.deadlineAtMs - options.receipt.sentAtMs;
  assertTimingOptions({
    sentAtMs: options.receipt.sentAtMs,
    reconciliationWindowMs,
    pollIntervalMs: reconciliationWindowMs,
    clockSkewMs,
  });
  const api =
    deps.api ??
    ((apiPath, token, requestOptions) => githubApi<unknown>(apiPath, token, requestOptions));
  const apiTimeoutMs = validatedTimeout(
    deps.apiTimeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    "GitHub API timeout",
    MAX_API_TIMEOUT_MS,
  );
  const recheckUpperBoundMs =
    Math.max((deps.now ?? Date.now)(), options.receipt.deadlineAtMs) + clockSkewMs;
  const candidates = new Map<number, WorkflowRun>();
  const correlatedRunIds = new Set<number>();
  let inventory: WorkflowRunInventory;
  try {
    inventory = await readPaginatedInventory(
      {
        repository: options.repository,
        token: options.token,
        workflowSha: options.receipt.workflowSha,
        lowerBoundMs: options.receipt.sentAtMs - clockSkewMs,
        upperBoundMs: recheckUpperBoundMs,
      },
      api,
      apiTimeoutMs,
    );
  } catch (error) {
    throw new DispatchReconciliationError(
      "The earlier dispatch correlation could not be rechecked before replacement",
      [],
      error,
    );
  }
  const contradiction = scanInventory(
    inventory,
    {
      repository: options.repository,
      workflowSha: options.receipt.workflowSha,
      correlationId: options.receipt.correlationId,
      prNumber: options.prNumber,
      lowerBoundMs: options.receipt.sentAtMs - clockSkewMs,
      upperBoundMs: recheckUpperBoundMs,
    },
    candidates,
    correlatedRunIds,
  );
  if (contradiction || correlatedRunIds.size > 0) {
    throw new DispatchReconciliationError(
      `The earlier dispatch correlation is no longer unobserved: ${contradiction ?? "a correlated run appeared"}`,
      [...correlatedRunIds].sort((left, right) => left - right),
    );
  }
}
