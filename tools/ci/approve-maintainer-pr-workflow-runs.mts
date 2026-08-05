// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type MaintainerApprovalRuntime = {
  github: unknown;
  context: unknown;
  core: unknown;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  createTimeoutSignal?: (delayMs: number) => AbortSignal;
};

type RequestInput = { request?: { signal?: AbortSignal } };
type ApiError = { code?: unknown; status?: unknown; response?: { status?: unknown } };
type EventPullRequest = { number?: unknown; head?: { sha?: unknown } };
type ApprovalResult = { approved: boolean; noOp?: boolean; stop: boolean };

type PullRequest = {
  number?: number;
  state?: string;
  base?: { repo?: { full_name?: string } };
  head?: { repo?: { full_name?: string }; sha?: string };
  user?: { login?: string };
};
type Permission = {
  permission?: string;
  role_name?: string;
  user?: { login?: string };
};
type WorkflowRun = {
  id?: number;
  event?: string;
  head_sha?: string;
  head_repository?: { full_name?: string };
  pull_requests?: Array<{ number?: number; head?: { sha?: string } }>;
  status?: string;
  conclusion?: string | null;
};
type GitHubClient = {
  rest: {
    pulls: {
      get(
        input: RequestInput & { owner: string; repo: string; pull_number: number },
      ): Promise<{ data: PullRequest }>;
    };
    repos: {
      getCollaboratorPermissionLevel(
        input: RequestInput & { owner: string; repo: string; username: string },
      ): Promise<{ data: Permission }>;
    };
    actions: {
      approveWorkflowRun(
        input: RequestInput & { owner: string; repo: string; run_id: number },
      ): Promise<unknown>;
      getWorkflowRun(
        input: RequestInput & { owner: string; repo: string; run_id: number },
      ): Promise<{ data: WorkflowRun }>;
      listWorkflowRunsForRepo(
        input: RequestInput & {
          owner: string;
          repo: string;
          event: string;
          head_sha: string;
          status: string;
          page: number;
          per_page: number;
        },
      ): Promise<{ data: { workflow_runs?: WorkflowRun[] } }>;
    };
  };
};
type WorkflowContext = {
  repo: { owner: string; repo: string };
  payload: { pull_request?: unknown };
};
type WorkflowCore = {
  info(message: string): void;
  warning(message: string): void;
};

export async function approveMaintainerPrWorkflowRuns(
  runtime: MaintainerApprovalRuntime,
): Promise<void> {
  const github = runtime.github as GitHubClient;
  const context = runtime.context as WorkflowContext;
  const core = runtime.core as WorkflowCore;
  const now = runtime.now ?? Date.now;
  const sleep =
    runtime.sleep ??
    ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const createTimeoutSignal =
    runtime.createTimeoutSignal ?? ((delayMs: number) => AbortSignal.timeout(delayMs));

  // A workflow with `actions: write` must load this helper from the PR base SHA or another trusted commit SHA.
  // Loading it from the PR head SHA would execute untrusted code with GitHub Actions write access.
  const SHA_PATTERN = /^[0-9a-f]{40}$/i;
  const TRUSTED_BASE_PERMISSIONS = new Set(["write", "admin"]);
  const POLL_ATTEMPTS = 12;
  const POLL_INTERVAL_MS = 5000;
  const API_RETRY_ATTEMPTS = 3;
  const API_RETRY_BASE_DELAY_MS = 250;
  const API_RETRY_MAX_DELAY_MS = 1000;
  const API_REQUEST_TIMEOUT_MS = 10000;
  const SCRIPT_BUDGET_MS = 105000;
  const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
  // Treat 403, 404, 409, and 422 as ambiguous approval responses.
  // Record success only when an exact-run GET shows that approval is no longer required.
  const APPROVAL_POST_STATE_HTTP_STATUSES = new Set([403, 404, 409, 422]);
  const RETRYABLE_NETWORK_CODES = new Set(["EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"]);
  const { owner, repo } = context.repo;
  const scriptDeadlineMs = now() + SCRIPT_BUDGET_MS;

  function remainingScriptBudgetMs(): number {
    return Math.max(0, scriptDeadlineMs - now());
  }

  function requestSignalFor(label: string): AbortSignal {
    const remainingMs = remainingScriptBudgetMs();
    if (remainingMs <= 0) {
      throw new Error(`${label} exceeded the bounded ${SCRIPT_BUDGET_MS}ms script budget`);
    }
    // @octokit/request 10.x consumes request.signal, not the legacy
    // request.timeout option. A fresh signal is required per retry.
    return createTimeoutSignal(Math.min(API_REQUEST_TIMEOUT_MS, remainingMs));
  }

  async function waitWithinScriptBudget(label: string, delayMs: number): Promise<void> {
    if (remainingScriptBudgetMs() <= delayMs) {
      throw new Error(`${label} exceeded the bounded ${SCRIPT_BUDGET_MS}ms script budget`);
    }
    await sleep(delayMs);
  }

  function apiErrorStatus(error: unknown): number | null {
    const apiError = error as ApiError;
    const status = Number(apiError.status ?? apiError.response?.status);
    return Number.isInteger(status) ? status : null;
  }

  function apiErrorCode(error: unknown): string {
    const code = (error as ApiError).code;
    return typeof code === "string" ? code.toUpperCase() : "";
  }

  function isRetryableApiError(error: unknown): boolean {
    const status = apiErrorStatus(error);
    return (
      (status !== null && RETRYABLE_HTTP_STATUSES.has(status)) ||
      RETRYABLE_NETWORK_CODES.has(apiErrorCode(error))
    );
  }

  async function withTransientApiRetry<T>(label: string, operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= API_RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!isRetryableApiError(error) || attempt === API_RETRY_ATTEMPTS) {
          throw error;
        }
        const delayMs = Math.min(
          API_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
          API_RETRY_MAX_DELAY_MS,
        );
        const status = apiErrorStatus(error);
        const identity = status === null ? apiErrorCode(error) : `HTTP ${status}`;
        core.warning(
          `${label} failed transiently with ${identity}; retrying attempt ${attempt + 1}/${API_RETRY_ATTEMPTS} in ${delayMs}ms`,
        );
        await waitWithinScriptBudget(label, delayMs);
      }
    }
    throw new Error(`${label} exhausted its bounded retry loop`);
  }

  function validateEventPullRequest(value: unknown): { number: number; headSha: string } {
    if (!value || typeof value !== "object") {
      throw new Error("Invalid pull_request_target payload: pull_request is missing");
    }
    const pullRequest = value as EventPullRequest;
    if (
      typeof pullRequest.number !== "number" ||
      !Number.isInteger(pullRequest.number) ||
      pullRequest.number <= 0
    ) {
      throw new Error(`Invalid pull request number: ${pullRequest.number}`);
    }
    if (typeof pullRequest.head?.sha !== "string" || !SHA_PATTERN.test(pullRequest.head.sha)) {
      throw new Error(`Invalid event head SHA for PR #${pullRequest.number}`);
    }
    return { number: pullRequest.number, headSha: pullRequest.head.sha.toLowerCase() };
  }

  function liveHeadSha(pullRequest: PullRequest, prNumber: number): string {
    const headSha = pullRequest?.head?.sha;
    if (typeof headSha !== "string" || !SHA_PATTERN.test(headSha)) {
      throw new Error(`Invalid live head SHA for PR #${prNumber}`);
    }
    return headSha.toLowerCase();
  }

  function repositoryName(value: unknown): string {
    return typeof value === "string" ? value.toLowerCase() : "";
  }

  function isSameRepositoryHead(pullRequest: PullRequest): boolean {
    return (
      repositoryName(pullRequest?.head?.repo?.full_name) === repositoryName(`${owner}/${repo}`)
    );
  }

  async function loadLivePullRequest(prNumber: number): Promise<PullRequest> {
    const response = await withTransientApiRetry(`Load live PR #${prNumber}`, () =>
      github.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
        request: { signal: requestSignalFor(`Load live PR #${prNumber}`) },
      }),
    );
    const pullRequest = response.data;
    if (pullRequest?.number !== prNumber || pullRequest?.state !== "open") {
      throw new Error(`PR #${prNumber} is not an open pull request`);
    }
    const baseRepository = pullRequest.base?.repo?.full_name;
    if (
      typeof baseRepository !== "string" ||
      baseRepository.toLowerCase() !== `${owner}/${repo}`.toLowerCase()
    ) {
      throw new Error(`PR #${prNumber} does not target ${owner}/${repo}`);
    }
    return pullRequest;
  }

  async function loadAuthorPermission(author: string): Promise<Permission | null> {
    try {
      const response = await withTransientApiRetry(
        `Load collaborator permission for ${author}`,
        () =>
          github.rest.repos.getCollaboratorPermissionLevel({
            owner,
            repo,
            username: author,
            request: {
              signal: requestSignalFor(`Load collaborator permission for ${author}`),
            },
          }),
      );
      const responseLogin = response.data.user?.login;
      if (
        typeof responseLogin !== "string" ||
        responseLogin.toLowerCase() !== author.toLowerCase()
      ) {
        throw new Error(`Permission response did not match PR author ${author}`);
      }
      return response.data;
    } catch (error) {
      if (apiErrorStatus(error) === 404) return null;
      throw error;
    }
  }

  function hasWritePermission(permission: Permission | null): boolean {
    const basePermission = String(permission?.permission ?? "").toLowerCase();
    // GitHub maps maintain to the write base permission.
    // Do not use role_name as authorization evidence because it can contain a custom-role label.
    return TRUSTED_BASE_PERMISSIONS.has(basePermission);
  }

  function hasExactWorkflowRunIdentity(
    run: WorkflowRun,
    prNumber: number,
    headSha: string,
    runId: number,
  ): boolean {
    const exactRunId = run.id;

    if (
      typeof exactRunId !== "number" ||
      !Number.isInteger(exactRunId) ||
      exactRunId <= 0 ||
      exactRunId !== runId ||
      run.event !== "pull_request" ||
      String(run.head_sha ?? "").toLowerCase() !== headSha ||
      repositoryName(run.head_repository?.full_name) !== repositoryName(`${owner}/${repo}`)
    ) {
      return false;
    }
    return (
      Array.isArray(run.pull_requests) &&
      run.pull_requests.some(
        (pullRequest) =>
          pullRequest?.number === prNumber &&
          String(pullRequest.head?.sha ?? "").toLowerCase() === headSha,
      )
    );
  }

  function belongsToExactPullRequest(run: WorkflowRun, prNumber: number, headSha: string): boolean {
    return (
      typeof run.id === "number" &&
      hasExactWorkflowRunIdentity(run, prNumber, headSha, run.id) &&
      run.status === "completed" &&
      run.conclusion === "action_required"
    );
  }

  async function exactWorkflowRunStillRequiresApproval(
    prNumber: number,
    headSha: string,
    runId: number,
  ): Promise<boolean> {
    const label = `Recheck exact workflow run ${runId}`;
    const response = await withTransientApiRetry(label, () =>
      github.rest.actions.getWorkflowRun({
        owner,
        repo,
        run_id: runId,
        request: { signal: requestSignalFor(label) },
      }),
    );
    const run = response.data;
    if (!hasExactWorkflowRunIdentity(run, prNumber, headSha, runId)) {
      throw new Error(
        `Workflow run ${runId} no longer matches exact PR #${prNumber} at ${headSha}`,
      );
    }
    if (typeof run.status !== "string" || run.status.length === 0) {
      throw new Error(`Workflow run ${runId} returned an invalid status`);
    }
    return run.status === "completed" && run.conclusion === "action_required";
  }

  async function approveExactWorkflowRun(
    prNumber: number,
    headSha: string,
    author: string,
    runId: number,
  ): Promise<ApprovalResult> {
    const label = `Approve workflow run ${runId}`;
    let approvalMayHaveSucceeded = false;
    for (let attempt = 1; attempt <= API_RETRY_ATTEMPTS; attempt += 1) {
      // The PR head, head repository, author, and author permission can change between attempts.
      // Revalidate them before each approval request.
      const liveBeforeApproval = await loadLivePullRequest(prNumber);
      if (liveHeadSha(liveBeforeApproval, prNumber) !== headSha) {
        core.warning(
          `PR #${prNumber} head changed before workflow-run approval; no further runs approved`,
        );
        return { approved: false, stop: true };
      }
      if (!isSameRepositoryHead(liveBeforeApproval)) {
        core.warning(`PR #${prNumber} head repository changed; no further runs approved`);
        return { approved: false, stop: true };
      }
      if (String(liveBeforeApproval.user?.login ?? "").toLowerCase() !== author.toLowerCase()) {
        throw new Error(`PR #${prNumber} author changed during workflow-run discovery`);
      }
      const livePermission = await loadAuthorPermission(author);
      if (!livePermission || !hasWritePermission(livePermission)) {
        core.warning(
          `PR #${prNumber} author ${author} no longer has write, maintain, or admin permission; no further runs approved`,
        );
        return { approved: false, stop: true };
      }

      try {
        await github.rest.actions.approveWorkflowRun({
          owner,
          repo,
          run_id: runId,
          request: { signal: requestSignalFor(label) },
        });
        return { approved: true, noOp: false, stop: false };
      } catch (error) {
        const status = apiErrorStatus(error);
        const transient = isRetryableApiError(error);
        const postStateResponse = status !== null && APPROVAL_POST_STATE_HTTP_STATUSES.has(status);
        if (!transient && !postStateResponse) throw error;

        if (transient) {
          approvalMayHaveSucceeded = true;
        }

        const delayMs = Math.min(
          API_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
          API_RETRY_MAX_DELAY_MS,
        );
        const identity = status === null ? apiErrorCode(error) : `HTTP ${status}`;
        const ambiguity = approvalMayHaveSucceeded
          ? "an approval request may have succeeded"
          : "another approver may have completed the request";
        core.warning(
          `${label} returned ${identity}; ${ambiguity}, rechecking exact run state in ${delayMs}ms`,
        );
        await waitWithinScriptBudget(label, delayMs);

        const stillRequiresApproval = await exactWorkflowRunStillRequiresApproval(
          prNumber,
          headSha,
          runId,
        );
        if (!stillRequiresApproval) {
          core.info(
            `Workflow run ${runId} no longer requires approval after an ambiguous approval response; recording success without another approval request`,
          );
          return { approved: true, noOp: true, stop: false };
        }
        if (!transient || attempt === API_RETRY_ATTEMPTS) throw error;
      }
    }
    throw new Error(`${label} exhausted its bounded retry loop`);
  }

  async function listExactHeadWorkflowRunsRequiringApproval(
    prNumber: number,
    headSha: string,
  ): Promise<WorkflowRun[]> {
    const runs: WorkflowRun[] = [];
    const perPage = 100;
    for (let page = 1; ; page += 1) {
      const label = `List exact-head workflow runs for PR #${prNumber}, page ${page}`;
      const response = await withTransientApiRetry(label, () =>
        github.rest.actions.listWorkflowRunsForRepo({
          owner,
          repo,
          event: "pull_request",
          head_sha: headSha,
          status: "action_required",
          page,
          per_page: perPage,
          request: { signal: requestSignalFor(label) },
        }),
      );
      const pageRuns = response.data?.workflow_runs;
      if (!Array.isArray(pageRuns)) {
        throw new Error(`${label} returned an invalid workflow_runs value`);
      }
      runs.push(...pageRuns);
      if (pageRuns.length < perPage) return runs;
    }
  }

  const eventPullRequest = validateEventPullRequest(context.payload.pull_request);
  const initialPullRequest = await loadLivePullRequest(eventPullRequest.number);
  const expectedHeadSha = liveHeadSha(initialPullRequest, eventPullRequest.number);
  if (expectedHeadSha !== eventPullRequest.headSha) {
    core.info(
      `PR #${eventPullRequest.number} moved from event head ${eventPullRequest.headSha} to ${expectedHeadSha}; no workflow runs approved`,
    );
    return;
  }
  if (!isSameRepositoryHead(initialPullRequest)) {
    core.info(
      `PR #${eventPullRequest.number} head repository is not ${owner}/${repo}; workflow runs remain gated`,
    );
    return;
  }

  const author = initialPullRequest.user?.login;
  if (typeof author !== "string" || author.length === 0) {
    throw new Error(`PR #${eventPullRequest.number} has no live author`);
  }
  const permission = await loadAuthorPermission(author);
  if (!permission || !hasWritePermission(permission)) {
    core.info(
      `PR #${eventPullRequest.number} author ${author} does not have write, maintain, or admin permission; workflow runs remain gated`,
    );
    return;
  }

  const resolvedRunIds = new Set<number>();
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const currentPullRequest = await loadLivePullRequest(eventPullRequest.number);
    if (liveHeadSha(currentPullRequest, eventPullRequest.number) !== expectedHeadSha) {
      core.warning(
        `PR #${eventPullRequest.number} head changed during workflow-run discovery; no further runs approved`,
      );
      return;
    }

    const runs = await listExactHeadWorkflowRunsRequiringApproval(
      eventPullRequest.number,
      expectedHeadSha,
    );

    for (const run of runs) {
      const runId = run.id;

      if (
        typeof runId !== "number" ||
        resolvedRunIds.has(runId) ||
        !belongsToExactPullRequest(run, eventPullRequest.number, expectedHeadSha)
      ) {
        continue;
      }

      const approval = await approveExactWorkflowRun(
        eventPullRequest.number,
        expectedHeadSha,
        author,
        runId,
      );
      if (approval.stop) return;
      if (!approval.approved) continue;
      resolvedRunIds.add(runId);
      if (!approval.noOp) {
        core.info(
          `Approved pull_request workflow run ${runId} for PR #${eventPullRequest.number} at ${expectedHeadSha}`,
        );
      }
    }

    if (attempt + 1 < POLL_ATTEMPTS) {
      if (remainingScriptBudgetMs() <= POLL_INTERVAL_MS) {
        core.warning(
          `Workflow-run polling stopped after ${attempt + 1}/${POLL_ATTEMPTS} attempts because the bounded ${SCRIPT_BUDGET_MS}ms script budget ended`,
        );
        break;
      }
      await waitWithinScriptBudget("Workflow-run polling", POLL_INTERVAL_MS);
    }
  }

  core.info(
    `Exact-head workflow runs that no longer require approval for PR #${eventPullRequest.number}: ${resolvedRunIds.size}`,
  );
}
