// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { githubApi } from "../tools/advisors/github.mts";
import {
  ARCHIVE_FILE,
  cancelActiveExactImageQualification,
  DISPATCH_INTENT_FILE,
  DISPATCH_RECONCILIATION_FILE,
  downloadExactImageManifest,
  EVIDENCE_FILE,
  extractExactManifestArchive,
  finalizeExactImageQualification,
  GITHUB_API_VERSION,
  MANIFEST_ARTIFACT_FILE,
  PRODUCER_REPOSITORY,
  PRODUCER_WORKFLOW_FILE,
  PRODUCER_WORKFLOW_PATH,
  parseExactImageQualificationCommand,
  preflightExactImageQualification,
  type QualificationDependencies,
  readExactImageQualificationState,
  STATE_FILE,
  startExactImageQualification,
  VALIDATED_MANIFEST_FILE,
  validateExactImageQualificationRequest,
  validateQualificationArtifactList,
  validateQualificationWorkflowRun,
  validateWorkflowDispatchDetails,
  waitForExactImageQualification,
} from "../tools/e2e/exact-image-qualification-controller.mts";
import {
  API_RUN_URL,
  artifactList,
  BASE_TIME,
  CANDIDATE_SHA,
  CORRELATION_ID,
  createApi,
  createArchiveRunCommand,
  createRoutedApi,
  dependencies,
  dispatchDetails,
  dispatchIntent,
  HTML_RUN_URL,
  PRODUCER_SHA,
  qualificationApiRoute,
  REQUEST,
  RUN_ID,
  startedState,
  tempDirectory,
  WORKFLOW_SHA,
  WORKFLOW_ID,
  workflowRun,
} from "./helpers/exact-image-qualification-controller-fixture.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("exact image qualification request", () => {
  it("accepts the current trusted main candidate while rejecting malformed boundaries", () => {
    expect(validateExactImageQualificationRequest(REQUEST)).toEqual(REQUEST);
    expect(
      validateExactImageQualificationRequest({
        ...REQUEST,
        candidateSha: "c".repeat(40),
        eventName: "schedule",
        requesterRunAttempt: 2,
      }),
    ).toMatchObject({
      candidateSha: "c".repeat(40),
      eventName: "schedule",
      requesterRunAttempt: 2,
    });
    expect(() =>
      validateExactImageQualificationRequest({ ...REQUEST, eventName: "pull_request" }),
    ).toThrow(/workflow_dispatch or schedule/u);
    expect(() =>
      validateExactImageQualificationRequest({ ...REQUEST, ref: "refs/pull/1/merge" }),
    ).toThrow(/trusted main branch/u);
    expect(() =>
      validateExactImageQualificationRequest({ ...REQUEST, ref: "refs/heads/feature" }),
    ).toThrow(/trusted main branch/u);
    expect(() =>
      validateExactImageQualificationRequest({ ...REQUEST, candidateSha: "d".repeat(40) }),
    ).toThrow(/must equal the trusted main workflow SHA/u);
    expect(() => validateExactImageQualificationRequest({ ...REQUEST, reason: " bad " })).toThrow(
      /reason/u,
    );
  });

  it("rejects non-main requests before authorization API access", async () => {
    const api = vi.fn();

    await expect(
      preflightExactImageQualification({ ...REQUEST, ref: "refs/heads/feature" }, "core-token", {
        api: api as QualificationDependencies["api"],
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    expect(api).not.toHaveBeenCalled();
  });

  it("rejects a candidate other than the trusted workflow SHA before authorization API access", async () => {
    const api = vi.fn();

    await expect(
      preflightExactImageQualification({ ...REQUEST, candidateSha: "d".repeat(40) }, "core-token", {
        api: api as QualificationDependencies["api"],
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    expect(api).not.toHaveBeenCalled();
  });

  it("parses the fixed CLI surface and rejects undeclared controls", () => {
    expect(
      parseExactImageQualificationCommand([
        "--mode",
        "preflight",
        "--actor",
        REQUEST.actor,
        "--candidate-sha",
        CANDIDATE_SHA,
        "--event-name",
        "workflow_dispatch",
        "--reason",
        REQUEST.reason,
        "--ref",
        "refs/heads/main",
        "--requester-run-attempt",
        "2",
        "--requester-run-id",
        REQUEST.requesterRunId,
        "--workflow-sha",
        WORKFLOW_SHA,
      ]),
    ).toEqual({ mode: "preflight", request: REQUEST });
    expect(() =>
      parseExactImageQualificationCommand([
        "--mode",
        "wait",
        "--work-dir",
        "/tmp/work",
        "--producer-ref",
        "feature",
      ]),
    ).toThrow(/unknown argument/u);
  });
});

describe("exact producer dispatch binding", () => {
  it("binds the selected candidate to the trusted main workflow SHA", async () => {
    expect(REQUEST.candidateSha).toBe(REQUEST.workflowSha);
    const { state, workDir } = await startedState();
    try {
      expect(readExactImageQualificationState(workDir).request).toMatchObject({
        candidateSha: CANDIDATE_SHA,
        workflowSha: WORKFLOW_SHA,
      });
      await expect(
        waitForExactImageQualification(
          { workDir, producerToken: "producer-token" },
          dependencies(
            createApi({ run: workflowRun({ status: "completed", conclusion: "success" }) }),
            { now: () => BASE_TIME + 1_000 },
          ),
        ),
      ).resolves.toMatchObject({ id: state.producer.runId, conclusion: "success" });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("accepts GitHub's maintain role mapping but rejects ordinary write access", async () => {
    const accepted = await startedState(createApi({ permission: "write", roleName: "maintain" }));
    fs.rmSync(accepted.workDir, { recursive: true, force: true });

    const workDir = tempDirectory();
    try {
      await expect(
        startExactImageQualification(
          {
            request: REQUEST,
            coreToken: "core-token",
            producerToken: "producer-token",
            workDir,
          },
          dependencies(createApi({ permission: "write", roleName: "write" })),
        ),
      ).rejects.toMatchObject({ code: "DISPATCH_FORBIDDEN" });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("uses the 2026 API contract and binds the returned run without listing runs", async () => {
    const api = createApi();
    const { state, workDir } = await startedState(api);
    try {
      const dispatchCall = api.mock.calls.find(([apiPath]) =>
        String(apiPath).endsWith(`/workflows/${PRODUCER_WORKFLOW_FILE}/dispatches`),
      );
      expect(dispatchCall?.[2]).toMatchObject({
        method: "POST",
        apiVersion: GITHUB_API_VERSION,
        expectedStatus: 200,
        body: {
          ref: "main",
          inputs: {
            nemoclaw_sha: CANDIDATE_SHA,
            correlation_id: CORRELATION_ID,
            requester_workflow_run_id: REQUEST.requesterRunId,
            requester_workflow_run_attempt: "2",
          },
          return_run_details: true,
        },
        signal: expect.any(AbortSignal),
      });
      expect(api.mock.calls.some(([apiPath]) => /actions\/runs\?/u.test(String(apiPath)))).toBe(
        false,
      );
      expect(state.producer.runId).toBe(RUN_ID);
      expect(state.producer.repositorySha).toBe(PRODUCER_SHA);
      expect(readExactImageQualificationState(workDir)).toEqual(state);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("keeps the previous state intact when atomic replacement is interrupted", async () => {
    const workDir = tempDirectory();
    const previousState = "previous state evidence\n";
    fs.writeFileSync(path.join(workDir, STATE_FILE), previousState, { mode: 0o600 });
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("simulated interruption before atomic replacement");
    });
    try {
      await expect(
        startExactImageQualification(
          {
            request: REQUEST,
            coreToken: "core-token",
            producerToken: "producer-token",
            workDir,
          },
          dependencies(createApi()),
        ),
      ).rejects.toMatchObject({ code: "OUTPUT_WRITE_FAILED" });
      expect(fs.readFileSync(path.join(workDir, STATE_FILE), "utf8")).toBe(previousState);
      expect(fs.readdirSync(workDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("requires HTTP 200 and sends the explicit API-version header", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      githubApi("repos/example/actions/workflows/build.yml/dispatches", "token", {
        method: "POST",
        apiVersion: GITHUB_API_VERSION,
        expectedStatus: 200,
        body: { return_run_details: true },
      }),
    ).rejects.toThrow(/204/u);
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("X-GitHub-Api-Version")).toBe(GITHUB_API_VERSION);
  });

  it.each([
    null,
    {},
    { workflow_run_id: Number(RUN_ID) },
  ])("fails closed when dispatch returns no complete run details: %j", async (dispatch) => {
    const workDir = tempDirectory();
    try {
      const api = createApi({ dispatch });
      let clock = BASE_TIME;
      await expect(
        startExactImageQualification(
          {
            request: REQUEST,
            coreToken: "core-token",
            producerToken: "producer-token",
            workDir,
          },
          dependencies(api, {
            now: () => clock,
            sleep: async () => {
              clock += 2;
            },
            limits: {
              dispatchReconciliationTimeoutMs: 1,
              reconciliationPollIntervalMs: 1,
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "DISPATCH_AMBIGUOUS" });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("records, reconciles, cancels, and rejects a server-accepted dispatch whose response is lost", async () => {
    const workDir = tempDirectory();
    const base = createApi();
    let cancelObserved = false;
    let stateExistedAtCancel = false;
    const api = createRoutedApi(base, [
      qualificationApiRoute.dispatch(() => {
        throw new Error("response connection reset after server acceptance");
      }),
      qualificationApiRoute.workflowRuns(() => ({
        total_count: 1,
        workflow_runs: [workflowRun()],
      })),
      qualificationApiRoute.cancelRun(() => {
        stateExistedAtCancel = fs.existsSync(path.join(workDir, STATE_FILE));
        cancelObserved = true;
        return undefined;
      }),
      qualificationApiRoute.run(() =>
        cancelObserved
          ? workflowRun({ status: "completed", conclusion: "cancelled" })
          : workflowRun(),
      ),
    ]);
    try {
      await expect(
        startExactImageQualification(
          {
            request: REQUEST,
            coreToken: "core-token",
            producerToken: "producer-token",
            workDir,
          },
          dependencies(api as ReturnType<typeof createApi>),
        ),
      ).rejects.toMatchObject({ code: "DISPATCH_AMBIGUOUS" });
      expect(
        api.mock.calls.filter(([apiPath]) =>
          String(apiPath).endsWith(`/workflows/${PRODUCER_WORKFLOW_FILE}/dispatches`),
        ),
      ).toHaveLength(1);
      expect(cancelObserved).toBe(true);
      expect(stateExistedAtCancel).toBe(true);
      expect(readExactImageQualificationState(workDir).producer.runId).toBe(RUN_ID);
      expect(fs.existsSync(path.join(workDir, DISPATCH_INTENT_FILE))).toBe(true);
      expect(
        JSON.parse(fs.readFileSync(path.join(workDir, DISPATCH_RECONCILIATION_FILE), "utf8")),
      ).toMatchObject({ outcome: "recovered-one", runIds: [RUN_ID] });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("finds and cleans the exact correlation after producer drift without qualifying it", async () => {
    const workDir = tempDirectory();
    const movedSha = "c".repeat(40);
    const base = createApi();
    let cancelled = false;
    const movedRun = workflowRun({ head_sha: movedSha });
    const historicalRuns = Array.from({ length: 101 }, (_value, index) =>
      workflowRun({ created_at: new Date(BASE_TIME - (index + 2) * 10 * 60_000).toISOString() }),
    );
    let observedCreatedFilter: string | null = null;
    let observedHeadShaFilter = false;
    let observedScopedRuns: unknown[] = [];
    const api = createRoutedApi(base, [
      qualificationApiRoute.dispatch(() => {
        throw new Error("lost response after main advanced");
      }),
      qualificationApiRoute.workflowRuns((apiPath) => {
        const query = new URLSearchParams(apiPath.split("?", 2)[1]);
        observedCreatedFilter = query.get("created");
        observedHeadShaFilter = apiPath.includes("head_sha=");
        const [earliest, latest] = (query.get("created") ?? "").split("..").map(Date.parse);
        const scoped = [...historicalRuns, movedRun].filter(({ created_at }) => {
          const createdAt = Date.parse(created_at);
          return createdAt >= earliest && createdAt <= latest;
        });
        observedScopedRuns = scoped;
        return { total_count: scoped.length, workflow_runs: scoped };
      }),
      qualificationApiRoute.cancelRun(() => {
        cancelled = true;
        return undefined;
      }),
      qualificationApiRoute.run(() =>
        workflowRun({
          head_sha: movedSha,
          status: cancelled ? "completed" : "queued",
          conclusion: cancelled ? "cancelled" : null,
        }),
      ),
    ]);
    try {
      await expect(
        startExactImageQualification(
          {
            request: REQUEST,
            coreToken: "core-token",
            producerToken: "producer-token",
            workDir,
          },
          dependencies(api as ReturnType<typeof createApi>),
        ),
      ).rejects.toMatchObject({ code: "DISPATCH_AMBIGUOUS" });
      expect(cancelled).toBe(true);
      expect(observedCreatedFilter).toBe("2025-12-31T23:59:00Z..2026-01-01T00:01:30Z");
      expect(observedHeadShaFilter).toBe(false);
      expect(historicalRuns).toHaveLength(101);
      expect(observedScopedRuns).toEqual([movedRun]);
      expect(readExactImageQualificationState(workDir)).toMatchObject({
        status: "dispatched",
        producer: { runId: RUN_ID, repositorySha: movedSha },
      });
      expect(
        JSON.parse(fs.readFileSync(path.join(workDir, DISPATCH_RECONCILIATION_FILE), "utf8")),
      ).toMatchObject({
        outcome: "recovered-one",
        runIds: [RUN_ID],
        producerHeadShas: { [RUN_ID]: movedSha },
      });
      expect(fs.existsSync(path.join(workDir, EVIDENCE_FILE))).toBe(false);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("cleans the response-bound run after producer SHA provenance fails", async () => {
    const workDir = tempDirectory();
    const movedSha = "c".repeat(40);
    try {
      await expect(
        startExactImageQualification(
          {
            request: REQUEST,
            coreToken: "core-token",
            producerToken: "producer-token",
            workDir,
          },
          dependencies(createApi({ run: workflowRun({ head_sha: movedSha }) })),
        ),
      ).rejects.toMatchObject({ code: "PROVENANCE_MISMATCH" });
      expect(readExactImageQualificationState(workDir).producer.runId).toBe(RUN_ID);

      const base = createApi();
      let cancelled = false;
      const cleanupApi = createRoutedApi(base, [
        qualificationApiRoute.cancelRun(() => {
          cancelled = true;
          return undefined;
        }),
        qualificationApiRoute.run(() =>
          workflowRun({
            head_sha: movedSha,
            status: cancelled ? "completed" : "queued",
            conclusion: cancelled ? "cancelled" : null,
          }),
        ),
      ]);
      await expect(
        cancelActiveExactImageQualification(
          { workDir, producerToken: "producer-token" },
          dependencies(cleanupApi as ReturnType<typeof createApi>),
        ),
      ).resolves.toBe(true);
      expect(cancelled).toBe(true);
      expect(
        cleanupApi.mock.calls.filter(([apiPath]) => String(apiPath).endsWith("/cancel")),
      ).toHaveLength(1);
      expect(readExactImageQualificationState(workDir).status).toBe("dispatched");
      expect(fs.existsSync(path.join(workDir, EVIDENCE_FILE))).toBe(false);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("never accepts a recovered ambiguous dispatch that already completed successfully", async () => {
    const workDir = tempDirectory();
    const base = createApi();
    const completed = workflowRun({ status: "completed", conclusion: "success" });
    const api = createRoutedApi(base, [
      qualificationApiRoute.dispatch(() => {
        throw new Error("lost response");
      }),
      qualificationApiRoute.workflowRuns(() => ({
        total_count: 1,
        workflow_runs: [completed],
      })),
    ]);
    try {
      await expect(
        startExactImageQualification(
          {
            request: REQUEST,
            coreToken: "core-token",
            producerToken: "producer-token",
            workDir,
          },
          dependencies(api as ReturnType<typeof createApi>),
        ),
      ).rejects.toMatchObject({ code: "DISPATCH_AMBIGUOUS" });
      expect(
        api.mock.calls.some(([apiPath]) => String(apiPath).endsWith(`/${RUN_ID}/cancel`)),
      ).toBe(false);
      expect(readExactImageQualificationState(workDir).status).toBe("dispatched");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("retains the recovered run identity when cancellation fails", async () => {
    const workDir = tempDirectory();
    const base = createApi();
    const api = createRoutedApi(base, [
      qualificationApiRoute.dispatch(() => {
        throw new Error("lost response");
      }),
      qualificationApiRoute.workflowRuns(() => ({
        total_count: 1,
        workflow_runs: [workflowRun()],
      })),
      qualificationApiRoute.cancelRun(() => {
        throw new Error("cancel transport failed");
      }),
    ]);
    try {
      await expect(
        startExactImageQualification(
          {
            request: REQUEST,
            coreToken: "core-token",
            producerToken: "producer-token",
            workDir,
          },
          dependencies(api as ReturnType<typeof createApi>),
        ),
      ).rejects.toThrow(/cancel transport failed/u);
      expect(readExactImageQualificationState(workDir).producer.runId).toBe(RUN_ID);
      expect(
        JSON.parse(fs.readFileSync(path.join(workDir, DISPATCH_RECONCILIATION_FILE), "utf8")),
      ).toMatchObject({ outcome: "recovered-one", runIds: [RUN_ID] });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("ignores near-match runs and retains a zero-match reconciliation audit", async () => {
    const workDir = tempDirectory();
    const base = createApi();
    let clock = BASE_TIME;
    const nearMatches = [
      workflowRun({ display_title: "wrong correlation" }),
      workflowRun({ workflow_id: WORKFLOW_ID + 1 }),
      workflowRun({ run_attempt: 2 }),
      workflowRun({ event: "push" }),
      workflowRun({ head_branch: "feature" }),
      workflowRun({ path: ".github/workflows/other.yml" }),
      workflowRun({ repository: { full_name: "other/repository" } }),
      workflowRun({ head_repository: { full_name: "other/repository" } }),
      workflowRun({ created_at: new Date(BASE_TIME - 2 * 60_000).toISOString() }),
      workflowRun({ url: `${API_RUN_URL}/wrong` }),
    ];
    const api = createRoutedApi(base, [
      qualificationApiRoute.dispatch(() => {
        throw new Error("lost response");
      }),
      qualificationApiRoute.workflowRuns(() => ({
        total_count: nearMatches.length,
        workflow_runs: nearMatches,
      })),
    ]);
    try {
      await expect(
        startExactImageQualification(
          {
            request: REQUEST,
            coreToken: "core-token",
            producerToken: "producer-token",
            workDir,
          },
          dependencies(api as ReturnType<typeof createApi>, {
            now: () => clock,
            sleep: async () => {
              clock += 2;
            },
            limits: {
              dispatchReconciliationTimeoutMs: 1,
              reconciliationPollIntervalMs: 1,
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "DISPATCH_AMBIGUOUS" });
      expect(
        api.mock.calls.some(([apiPath]) => String(apiPath).endsWith(`/${RUN_ID}/cancel`)),
      ).toBe(false);
      expect(
        JSON.parse(fs.readFileSync(path.join(workDir, DISPATCH_RECONCILIATION_FILE), "utf8")),
      ).toMatchObject({ outcome: "none", runIds: [] });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("lets cleanup preserve semantically invalid state and recover only from durable intent", async () => {
    const workDir = tempDirectory();
    const untrustedRunId = "99999";
    let startClock = BASE_TIME;
    try {
      await expect(
        startExactImageQualification(
          {
            request: REQUEST,
            coreToken: "core-token",
            producerToken: "producer-token",
            workDir,
          },
          dependencies(createApi({ dispatch: null }), {
            now: () => startClock,
            sleep: async () => {
              startClock += 2;
            },
            limits: {
              dispatchReconciliationTimeoutMs: 1,
              reconciliationPollIntervalMs: 1,
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "DISPATCH_AMBIGUOUS" });
      expect(fs.existsSync(path.join(workDir, STATE_FILE))).toBe(false);
      fs.writeFileSync(
        path.join(workDir, STATE_FILE),
        JSON.stringify({
          schemaVersion: 1,
          status: "dispatched",
          producer: { runId: untrustedRunId },
        }),
        { mode: 0o600 },
      );

      const base = createApi();
      let cancelled = false;
      const cleanupApi = createRoutedApi(base, [
        qualificationApiRoute.workflowRuns(() => ({
          total_count: 1,
          workflow_runs: [workflowRun()],
        })),
        qualificationApiRoute.cancelRun(() => {
          cancelled = true;
          return undefined;
        }),
        qualificationApiRoute.run(() =>
          cancelled ? workflowRun({ status: "completed", conclusion: "cancelled" }) : workflowRun(),
        ),
      ]);
      await expect(
        cancelActiveExactImageQualification(
          { workDir, producerToken: "producer-token" },
          dependencies(cleanupApi as ReturnType<typeof createApi>, {
            now: () => BASE_TIME + 10_000,
            limits: { cleanupTimeoutMs: 10_000 },
          }),
        ),
      ).resolves.toBe(true);
      expect(cancelled).toBe(true);
      expect(
        cleanupApi.mock.calls.some(([apiPath]) => String(apiPath).includes(untrustedRunId)),
      ).toBe(false);
      expect(readExactImageQualificationState(workDir).producer.runId).toBe(RUN_ID);
      expect(
        fs.readdirSync(workDir).some((name) => name.startsWith("controller-state.corrupt-")),
      ).toBe(true);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("binds a valid state tuple to durable intent before any cancellation POST", async () => {
    const started = await startedState();
    const untrustedRunId = "99999";
    const untrustedCorrelationId = "87654321-4321-4321-8321-cba987654321";
    const state = readExactImageQualificationState(started.workDir);
    state.request.correlationId = untrustedCorrelationId;
    state.producer.runId = untrustedRunId;
    state.producer.runUrl = `https://api.github.com/repos/${PRODUCER_REPOSITORY}/actions/runs/${untrustedRunId}`;
    state.producer.htmlUrl = `https://github.com/${PRODUCER_REPOSITORY}/actions/runs/${untrustedRunId}`;
    fs.writeFileSync(path.join(started.workDir, STATE_FILE), `${JSON.stringify(state)}\n`, {
      mode: 0o600,
    });

    const base = createApi();
    let cancelled = false;
    const cleanupApi = createRoutedApi(base, [
      qualificationApiRoute.workflowRuns(() => ({
        total_count: 1,
        workflow_runs: [workflowRun()],
      })),
      qualificationApiRoute.cancelRun(() => {
        cancelled = true;
        return undefined;
      }),
      qualificationApiRoute.run(() =>
        cancelled ? workflowRun({ status: "completed", conclusion: "cancelled" }) : workflowRun(),
      ),
    ]);
    try {
      await expect(
        cancelActiveExactImageQualification(
          { workDir: started.workDir, producerToken: "producer-token" },
          dependencies(cleanupApi as ReturnType<typeof createApi>),
        ),
      ).resolves.toBe(true);
      expect(cancelled).toBe(true);
      expect(
        cleanupApi.mock.calls.some(([apiPath]) => String(apiPath).includes(untrustedRunId)),
      ).toBe(false);
      expect(readExactImageQualificationState(started.workDir).producer.runId).toBe(RUN_ID);
      expect(
        fs
          .readdirSync(started.workDir)
          .some((name) => name.startsWith("controller-state.corrupt-")),
      ).toBe(true);
    } finally {
      fs.rmSync(started.workDir, { recursive: true, force: true });
    }
  });

  it("does not let a forged terminal state suppress cleanup of the active bound run", async () => {
    const started = await startedState();
    const state = readExactImageQualificationState(started.workDir);
    state.status = "completed";
    state.producer.completedAt = new Date(BASE_TIME + 1_000).toISOString();
    fs.writeFileSync(path.join(started.workDir, STATE_FILE), `${JSON.stringify(state)}\n`, {
      mode: 0o600,
    });

    let cancelled = false;
    const cleanupApi = createRoutedApi(createApi(), [
      qualificationApiRoute.cancelRun(() => {
        cancelled = true;
        return undefined;
      }),
      qualificationApiRoute.run(() =>
        cancelled
          ? workflowRun({ status: "completed", conclusion: "cancelled" })
          : workflowRun({ status: "queued", conclusion: null }),
      ),
    ]);
    try {
      await expect(
        cancelActiveExactImageQualification(
          { workDir: started.workDir, producerToken: "producer-token" },
          dependencies(cleanupApi as ReturnType<typeof createApi>),
        ),
      ).resolves.toBe(true);
      expect(cancelled).toBe(true);
      expect(
        cleanupApi.mock.calls.filter(([apiPath]) => String(apiPath).endsWith("/cancel")),
      ).toHaveLength(1);
    } finally {
      fs.rmSync(started.workDir, { recursive: true, force: true });
    }
  });

  it("rejects run-ID-only state corruption before any cancellation POST", async () => {
    const started = await startedState();
    const untrustedRunId = "99999";
    const untrustedApiUrl = `https://api.github.com/repos/${PRODUCER_REPOSITORY}/actions/runs/${untrustedRunId}`;
    const untrustedHtmlUrl = `https://github.com/${PRODUCER_REPOSITORY}/actions/runs/${untrustedRunId}`;
    const state = readExactImageQualificationState(started.workDir);
    state.producer.runId = untrustedRunId;
    state.producer.runUrl = untrustedApiUrl;
    state.producer.htmlUrl = untrustedHtmlUrl;
    fs.writeFileSync(path.join(started.workDir, STATE_FILE), `${JSON.stringify(state)}\n`, {
      mode: 0o600,
    });

    const cancelAttempt = vi.fn();
    const cleanupApi = createRoutedApi(createApi(), [
      qualificationApiRoute.runAny(() =>
        workflowRun({
          id: Number(untrustedRunId),
          display_title: "Unrelated qualification run",
          url: untrustedApiUrl,
          html_url: untrustedHtmlUrl,
        }),
      ),
      qualificationApiRoute.cancelAnyRun(cancelAttempt),
    ]);
    try {
      await expect(
        cancelActiveExactImageQualification(
          { workDir: started.workDir, producerToken: "producer-token" },
          dependencies(cleanupApi as ReturnType<typeof createApi>),
        ),
      ).rejects.toMatchObject({ code: "PROVENANCE_MISMATCH" });
      expect(cancelAttempt).not.toHaveBeenCalled();
      expect(cleanupApi.mock.calls.map(([apiPath]) => apiPath)).toEqual([
        `repos/${PRODUCER_REPOSITORY}/actions/runs/${untrustedRunId}`,
      ]);
    } finally {
      fs.rmSync(started.workDir, { recursive: true, force: true });
    }
  });

  it("fails closed when unreadable state cannot be preserved before cleanup reconciliation", async () => {
    const workDir = tempDirectory();
    const controllerState = "not valid JSON";
    const api = createApi();
    try {
      fs.writeFileSync(
        path.join(workDir, DISPATCH_INTENT_FILE),
        `${JSON.stringify(dispatchIntent(), null, 2)}\n`,
        { mode: 0o600 },
      );
      fs.writeFileSync(path.join(workDir, STATE_FILE), controllerState, { mode: 0o600 });
      vi.spyOn(fs, "renameSync").mockImplementation(() => {
        throw new Error("preservation denied");
      });

      await expect(
        cancelActiveExactImageQualification(
          { workDir, producerToken: "producer-token" },
          dependencies(api),
        ),
      ).rejects.toMatchObject({ code: "OUTPUT_WRITE_FAILED" });
      expect(api).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(workDir, STATE_FILE), "utf8")).toBe(controllerState);
      expect(fs.existsSync(path.join(workDir, DISPATCH_RECONCILIATION_FILE))).toBe(false);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("fails closed on multiple strict reconciliation matches and records every exact ID", async () => {
    const workDir = tempDirectory();
    const secondId = "24681";
    const base = createApi();
    const second = workflowRun({
      id: Number(secondId),
      url: `https://api.github.com/repos/${PRODUCER_REPOSITORY}/actions/runs/${secondId}`,
      html_url: `https://github.com/${PRODUCER_REPOSITORY}/actions/runs/${secondId}`,
    });
    const api = createRoutedApi(base, [
      qualificationApiRoute.dispatch(() => {
        throw new Error("lost response");
      }),
      qualificationApiRoute.workflowRuns(() => ({
        total_count: 2,
        workflow_runs: [workflowRun(), second],
      })),
      qualificationApiRoute.cancelAnyRun(() => undefined),
    ]);
    try {
      await expect(
        startExactImageQualification(
          {
            request: REQUEST,
            coreToken: "core-token",
            producerToken: "producer-token",
            workDir,
          },
          dependencies(api as ReturnType<typeof createApi>),
        ),
      ).rejects.toMatchObject({ code: "DISPATCH_AMBIGUOUS" });
      const audit = JSON.parse(
        fs.readFileSync(path.join(workDir, DISPATCH_RECONCILIATION_FILE), "utf8"),
      );
      expect(audit).toMatchObject({ outcome: "multiple", runIds: [RUN_ID, secondId] });
      expect(
        api.mock.calls.filter(([apiPath]) => String(apiPath).endsWith("/cancel")),
      ).toHaveLength(2);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("aborts a GitHub REST call at the configured per-request cap", async () => {
    let observedSignal: AbortSignal | undefined;
    const api = vi.fn(
      async (_apiPath: string, _token: string, requestOptions?: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          observedSignal = requestOptions?.signal;
          requestOptions?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    await expect(
      preflightExactImageQualification(REQUEST, "core-token", {
        api: api as QualificationDependencies["api"],
        now: Date.now,
        limits: { apiRequestTimeoutMs: 5 },
      }),
    ).rejects.toMatchObject({ code: "QUALIFICATION_TIMEOUT" });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("validates the exact returned URLs", () => {
    expect(validateWorkflowDispatchDetails(dispatchDetails())).toEqual({
      workflowRunId: RUN_ID,
      runUrl: API_RUN_URL,
      htmlUrl: HTML_RUN_URL,
    });
    expect(() =>
      validateWorkflowDispatchDetails({
        ...dispatchDetails(),
        html_url: `${HTML_RUN_URL}/attempts/1`,
      }),
    ).toThrow(/html_url/u);
  });

  it("rejects producer workflow identity drift", () => {
    expect(() =>
      validateQualificationWorkflowRun(workflowRun({ head_sha: "c".repeat(40) }), {
        candidateSha: CANDIDATE_SHA,
        correlationId: CORRELATION_ID,
        producerSha: PRODUCER_SHA,
        runId: RUN_ID,
        runUrl: API_RUN_URL,
        htmlUrl: HTML_RUN_URL,
      }),
    ).toThrow(/head SHA/u);
  });
});

describe("bound producer polling", () => {
  it("accepts success only from the exact dispatched run", async () => {
    const { workDir } = await startedState();
    const api = createApi({ run: workflowRun({ status: "completed", conclusion: "success" }) });
    try {
      await expect(
        waitForExactImageQualification(
          { workDir, producerToken: "producer-token" },
          dependencies(api, { now: () => BASE_TIME + 1_000 }),
        ),
      ).resolves.toMatchObject({ id: RUN_ID, conclusion: "success" });
      expect(readExactImageQualificationState(workDir).status).toBe("completed");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("rejects repeated wait from a terminal state before polling or mutation", async () => {
    const started = await startedState();
    const state = readExactImageQualificationState(started.workDir);
    state.status = "completed";
    state.producer.completedAt = new Date(BASE_TIME + 1_000).toISOString();
    fs.writeFileSync(path.join(started.workDir, STATE_FILE), `${JSON.stringify(state)}\n`, {
      mode: 0o600,
    });
    const api = createApi();
    try {
      await expect(
        waitForExactImageQualification(
          { workDir: started.workDir, producerToken: "producer-token" },
          dependencies(api),
        ),
      ).rejects.toMatchObject({ code: "PROVENANCE_MISMATCH" });
      expect(api).not.toHaveBeenCalled();
      expect(readExactImageQualificationState(started.workDir)).toEqual(state);
    } finally {
      fs.rmSync(started.workDir, { recursive: true, force: true });
    }
  });

  it("rejects persisted completion and acceptance after the hard deadline", async () => {
    const started = await startedState();
    const state = readExactImageQualificationState(started.workDir);
    state.status = "completed";
    state.producer.completedAt = new Date(BASE_TIME + 45 * 60_000 + 1).toISOString();
    fs.writeFileSync(path.join(started.workDir, STATE_FILE), `${JSON.stringify(state)}\n`, {
      mode: 0o600,
    });
    try {
      expect(() => readExactImageQualificationState(started.workDir)).toThrow(
        /completedAt exceeds qualification deadline/u,
      );

      state.status = "validated";
      state.producer.completedAt = new Date(BASE_TIME + 1_000).toISOString();
      state.artifact = {
        id: "86420",
        name: `nemoclaw-image-handoff-v1-${RUN_ID}-1`,
        digest: `sha256:${"0".repeat(64)}`,
        sizeInBytes: 1,
        apiUrl: `https://api.github.com/repos/${PRODUCER_REPOSITORY}/actions/artifacts/86420`,
        archiveDownloadUrl: `https://api.github.com/repos/${PRODUCER_REPOSITORY}/actions/artifacts/86420/zip`,
        archiveSha256: "0".repeat(64),
        manifestSha256: "1".repeat(64),
      };
      state.validation = {
        acceptedAt: new Date(BASE_TIME + 45 * 60_000 + 1).toISOString(),
        manifestSha256: "1".repeat(64),
        normalizedManifestSha256: "2".repeat(64),
      };
      fs.writeFileSync(path.join(started.workDir, STATE_FILE), `${JSON.stringify(state)}\n`, {
        mode: 0o600,
      });
      expect(() => readExactImageQualificationState(started.workDir)).toThrow(
        /acceptedAt exceeds qualification deadline/u,
      );
    } finally {
      fs.rmSync(started.workDir, { recursive: true, force: true });
    }
  });

  it("cancels a run that remains queued beyond the queue budget", async () => {
    const { workDir } = await startedState();
    const api = createApi({ run: workflowRun({ status: "queued" }) });
    try {
      await expect(
        waitForExactImageQualification(
          { workDir, producerToken: "producer-token" },
          dependencies(api, {
            now: () => BASE_TIME + 10 * 60_000 + 1,
            limits: { queueTimeoutMs: 10 * 60_000 },
          }),
        ),
      ).rejects.toMatchObject({ code: "RUN_QUEUE_TIMEOUT" });
      expect(
        api.mock.calls.some(
          ([apiPath]) => apiPath === `repos/${PRODUCER_REPOSITORY}/actions/runs/${RUN_ID}/cancel`,
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("rejects a successful producer completion observed at the shared deadline", async () => {
    const { workDir } = await startedState();
    const api = createApi({ run: workflowRun({ status: "completed", conclusion: "success" }) });
    try {
      await expect(
        waitForExactImageQualification(
          { workDir, producerToken: "producer-token" },
          dependencies(api, { now: () => BASE_TIME + 45 * 60_000 }),
        ),
      ).rejects.toMatchObject({ code: "QUALIFICATION_TIMEOUT" });
      expect(readExactImageQualificationState(workDir).status).toBe("dispatched");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe("qualification artifact integrity", () => {
  it("requires one non-expired digest-bound artifact from the exact run and SHA", async () => {
    const archive = Buffer.from("archive");
    const { state, workDir } = await startedState();
    try {
      expect(validateQualificationArtifactList(artifactList(archive), state)).toMatchObject({
        id: "86420",
        digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
      });
      expect(() =>
        validateQualificationArtifactList(
          artifactList(archive, { workflow_run: { id: Number(RUN_ID), head_sha: "c".repeat(40) } }),
          state,
        ),
      ).toThrow(/head SHA/u);
      expect(() =>
        validateQualificationArtifactList(artifactList(archive, { digest: null }), state),
      ).toThrow(/digest/u);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("checks the archive digest before accepting the single root manifest entry", async () => {
    const archive = Buffer.from("deterministic archive bytes");
    const manifest = Buffer.from('{"schemaVersion":1}\n');
    const started = await startedState();
    const completedApi = createApi({
      run: workflowRun({ status: "completed", conclusion: "success" }),
    });
    await waitForExactImageQualification(
      { workDir: started.workDir, producerToken: "producer-token" },
      dependencies(completedApi, { now: () => BASE_TIME + 1_000 }),
    );
    const artifactApi = createApi({ artifacts: artifactList(archive) });
    const runCommand = vi.fn((command: string, args: readonly string[]) => ({
      status: 0,
      stdout:
        args[0] === "-Z1"
          ? Buffer.from(`${MANIFEST_ARTIFACT_FILE}\n`)
          : args[0] === "-Zl"
            ? Buffer.from(`-rw-r--r--  3.0 unx  20 tx 20 stor ${MANIFEST_ARTIFACT_FILE}\n`)
            : manifest,
      stderr: Buffer.alloc(0),
    }));
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(archive, { status: 200 }),
    );
    try {
      await downloadExactImageManifest(
        { workDir: started.workDir, producerToken: "producer-token" },
        dependencies(artifactApi, { fetch: fetchMock, runCommand }),
      );
      const fetchHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        `https://api.github.com/repos/${PRODUCER_REPOSITORY}/actions/artifacts/86420/zip`,
      );
      expect(fetchHeaders.get("X-GitHub-Api-Version")).toBe(GITHUB_API_VERSION);
      expect(fs.readFileSync(path.join(started.workDir, ARCHIVE_FILE))).toEqual(archive);
      expect(fs.readFileSync(path.join(started.workDir, MANIFEST_ARTIFACT_FILE))).toEqual(manifest);
      expect(readExactImageQualificationState(started.workDir)).toMatchObject({
        status: "downloaded",
        artifact: {
          archiveSha256: createHash("sha256").update(archive).digest("hex"),
          manifestSha256: createHash("sha256").update(manifest).digest("hex"),
        },
      });
    } finally {
      fs.rmSync(started.workDir, { recursive: true, force: true });
    }
  });

  it("rejects persisted artifact metadata whose GitHub digest and archive hash diverge", async () => {
    const archive = Buffer.from("deterministic archive bytes");
    const manifest = Buffer.from('{"schemaVersion":1}\n');
    const started = await startedState();
    await waitForExactImageQualification(
      { workDir: started.workDir, producerToken: "producer-token" },
      dependencies(
        createApi({ run: workflowRun({ status: "completed", conclusion: "success" }) }),
        { now: () => BASE_TIME + 1_000 },
      ),
    );
    await downloadExactImageManifest(
      { workDir: started.workDir, producerToken: "producer-token" },
      dependencies(createApi({ artifacts: artifactList(archive) }), {
        fetch: async () => new Response(archive, { status: 200 }),
        runCommand: createArchiveRunCommand(manifest),
      }),
    );
    const state = JSON.parse(
      fs.readFileSync(path.join(started.workDir, STATE_FILE), "utf8"),
    ) as Record<string, unknown> & { artifact: { archiveSha256: string } };
    state.artifact.archiveSha256 = "0".repeat(64);
    fs.writeFileSync(path.join(started.workDir, STATE_FILE), `${JSON.stringify(state)}\n`, {
      mode: 0o600,
    });
    try {
      expect(() => readExactImageQualificationState(started.workDir)).toThrow(
        /digest does not match archive hash/u,
      );
      expect(fs.existsSync(path.join(started.workDir, EVIDENCE_FILE))).toBe(false);
    } finally {
      fs.rmSync(started.workDir, { recursive: true, force: true });
    }
  });

  it("does not inspect or extract an archive whose digest mismatches GitHub metadata", async () => {
    const archive = Buffer.from("archive bytes");
    const started = await startedState();
    await waitForExactImageQualification(
      { workDir: started.workDir, producerToken: "producer-token" },
      dependencies(
        createApi({ run: workflowRun({ status: "completed", conclusion: "success" }) }),
        { now: () => BASE_TIME + 1_000 },
      ),
    );
    const runCommand = vi.fn();
    try {
      await expect(
        downloadExactImageManifest(
          { workDir: started.workDir, producerToken: "producer-token" },
          dependencies(
            createApi({ artifacts: artifactList(archive, { digest: `sha256:${"0".repeat(64)}` }) }),
            {
              fetch: async () => new Response(archive, { status: 200 }),
              runCommand,
            },
          ),
        ),
      ).rejects.toMatchObject({ code: "ARTIFACT_MISSING_OR_INVALID" });
      expect(runCommand).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(started.workDir, { recursive: true, force: true });
    }
  });

  it("caps artifact propagation at the shared qualification deadline", async () => {
    const started = await startedState();
    await waitForExactImageQualification(
      { workDir: started.workDir, producerToken: "producer-token" },
      dependencies(
        createApi({ run: workflowRun({ status: "completed", conclusion: "success" }) }),
        { now: () => BASE_TIME + 43 * 60_000 },
      ),
    );
    let clock = BASE_TIME + 44 * 60_000;
    const api = createApi({ artifacts: { total_count: 0, artifacts: [] } });
    try {
      await expect(
        downloadExactImageManifest(
          { workDir: started.workDir, producerToken: "producer-token" },
          dependencies(api, {
            now: () => clock,
            sleep: async () => {
              clock = BASE_TIME + 45 * 60_000;
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "QUALIFICATION_TIMEOUT" });
      expect(
        api.mock.calls.filter(([apiPath]) => String(apiPath).includes("/artifacts?")),
      ).toHaveLength(1);
    } finally {
      fs.rmSync(started.workDir, { recursive: true, force: true });
    }
  });

  it("does not accept an archive whose extraction crosses the shared deadline", async () => {
    const archive = Buffer.from("archive");
    const manifest = Buffer.from('{"schemaVersion":1}\n');
    const started = await startedState();
    await waitForExactImageQualification(
      { workDir: started.workDir, producerToken: "producer-token" },
      dependencies(
        createApi({ run: workflowRun({ status: "completed", conclusion: "success" }) }),
        { now: () => BASE_TIME + 43 * 60_000 },
      ),
    );
    let clock = BASE_TIME + 44 * 60_000;
    try {
      await expect(
        downloadExactImageManifest(
          { workDir: started.workDir, producerToken: "producer-token" },
          dependencies(createApi({ artifacts: artifactList(archive) }), {
            now: () => clock,
            fetch: async () => new Response(archive, { status: 200 }),
            runCommand: createArchiveRunCommand(manifest, () => {
              clock = BASE_TIME + 45 * 60_000;
            }),
          }),
        ),
      ).rejects.toMatchObject({ code: "QUALIFICATION_TIMEOUT" });
      expect(readExactImageQualificationState(started.workDir).status).toBe("completed");
    } finally {
      fs.rmSync(started.workDir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate or nested ZIP entry inventories", () => {
    const tempDir = tempDirectory();
    const archivePath = path.join(tempDir, ARCHIVE_FILE);
    fs.writeFileSync(archivePath, "not inspected by the command seam");
    try {
      expect(() =>
        extractExactManifestArchive(
          archivePath,
          path.join(tempDir, MANIFEST_ARTIFACT_FILE),
          () => ({
            status: 0,
            stdout: Buffer.from(`${MANIFEST_ARTIFACT_FILE}\n${MANIFEST_ARTIFACT_FILE}\n`),
            stderr: Buffer.alloc(0),
          }),
        ),
      ).toThrow(/exactly/u);
      expect(() =>
        extractExactManifestArchive(
          archivePath,
          path.join(tempDir, MANIFEST_ARTIFACT_FILE),
          () => ({
            status: 0,
            stdout: Buffer.from(`nested/${MANIFEST_ARTIFACT_FILE}\n`),
            stderr: Buffer.alloc(0),
          }),
        ),
      ).toThrow(/exactly/u);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects a ZIP entry marked as a symbolic link before extraction", () => {
    const tempDir = tempDirectory();
    const archivePath = path.join(tempDir, ARCHIVE_FILE);
    fs.writeFileSync(archivePath, "not inspected by the command seam");
    const runCommand = vi.fn((_command: string, args: readonly string[]) => ({
      status: 0,
      stdout:
        args[0] === "-Z1"
          ? Buffer.from(`${MANIFEST_ARTIFACT_FILE}\n`)
          : Buffer.from(`lrwxrwxrwx  3.0 unx  20 tx 20 stor ${MANIFEST_ARTIFACT_FILE}\n`),
      stderr: Buffer.alloc(0),
    }));
    try {
      expect(() =>
        extractExactManifestArchive(
          archivePath,
          path.join(tempDir, MANIFEST_ARTIFACT_FILE),
          runCommand,
        ),
      ).toThrow(/regular file/u);
      expect(runCommand).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("qualification evidence finalization", () => {
  it("records immutable producer, artifact, and accepted-manifest hashes", async () => {
    const archive = Buffer.from("archive");
    const manifest = Buffer.from('{"schemaVersion":1}\n');
    const normalized = Buffer.from('{"schemaVersion":1,"accepted":true}\n');
    const started = await startedState();
    await waitForExactImageQualification(
      { workDir: started.workDir, producerToken: "producer-token" },
      dependencies(
        createApi({ run: workflowRun({ status: "completed", conclusion: "success" }) }),
        { now: () => BASE_TIME + 1_000 },
      ),
    );
    await downloadExactImageManifest(
      { workDir: started.workDir, producerToken: "producer-token" },
      dependencies(createApi({ artifacts: artifactList(archive) }), {
        fetch: async () => new Response(archive, { status: 200 }),
        runCommand: (_command, args) => ({
          status: 0,
          stdout:
            args[0] === "-Z1"
              ? Buffer.from(`${MANIFEST_ARTIFACT_FILE}\n`)
              : args[0] === "-Zl"
                ? Buffer.from(`-rw-r--r--  3.0 unx  20 tx 20 stor ${MANIFEST_ARTIFACT_FILE}\n`)
                : manifest,
          stderr: Buffer.alloc(0),
        }),
      }),
    );
    fs.writeFileSync(path.join(started.workDir, VALIDATED_MANIFEST_FILE), normalized, {
      mode: 0o600,
    });
    try {
      const finalState = finalizeExactImageQualification(started.workDir, {
        now: () => BASE_TIME + 2_000,
      });
      expect(finalState).toMatchObject({
        status: "validated",
        validation: {
          manifestSha256: createHash("sha256").update(manifest).digest("hex"),
          normalizedManifestSha256: createHash("sha256").update(normalized).digest("hex"),
        },
      });
      const evidence = JSON.parse(
        fs.readFileSync(path.join(started.workDir, EVIDENCE_FILE), "utf8"),
      );
      expect(evidence).toMatchObject({
        qualificationStatus: "accepted",
        producer: { runId: RUN_ID, repositorySha: PRODUCER_SHA },
        artifact: { id: "86420" },
      });
    } finally {
      fs.rmSync(started.workDir, { recursive: true, force: true });
    }
  });

  it("never publishes accepted evidence when the validated state transition is rejected", async () => {
    const archive = Buffer.from("archive");
    const manifest = Buffer.from('{"schemaVersion":1}\n');
    const normalized = Buffer.from('{"schemaVersion":1,"accepted":true}\n');
    const started = await startedState();
    await waitForExactImageQualification(
      { workDir: started.workDir, producerToken: "producer-token" },
      dependencies(
        createApi({ run: workflowRun({ status: "completed", conclusion: "success" }) }),
        { now: () => BASE_TIME + 3_000 },
      ),
    );
    await downloadExactImageManifest(
      { workDir: started.workDir, producerToken: "producer-token" },
      dependencies(createApi({ artifacts: artifactList(archive) }), {
        fetch: async () => new Response(archive, { status: 200 }),
        runCommand: createArchiveRunCommand(manifest),
      }),
    );
    fs.writeFileSync(path.join(started.workDir, VALIDATED_MANIFEST_FILE), normalized, {
      mode: 0o600,
    });
    try {
      expect(() =>
        finalizeExactImageQualification(started.workDir, {
          now: () => BASE_TIME + 2_000,
        }),
      ).toThrowError(expect.objectContaining({ code: "OUTPUT_WRITE_FAILED" }));
      expect(fs.existsSync(path.join(started.workDir, EVIDENCE_FILE))).toBe(false);
      expect(readExactImageQualificationState(started.workDir).status).toBe("downloaded");
    } finally {
      fs.rmSync(started.workDir, { recursive: true, force: true });
    }
  });

  it("refuses accepted evidence at the shared deadline", () => {
    const workDir = tempDirectory();
    const manifest = Buffer.from('{"schemaVersion":1}\n');
    const normalized = Buffer.from('{"schemaVersion":1,"accepted":true}\n');
    const manifestSha256 = createHash("sha256").update(manifest).digest("hex");
    const state = {
      schemaVersion: 1,
      status: "downloaded",
      dispatchedAt: new Date(BASE_TIME).toISOString(),
      request: {
        actor: REQUEST.actor,
        candidateSha: CANDIDATE_SHA,
        correlationId: CORRELATION_ID,
        reason: REQUEST.reason,
        requesterRunAttempt: REQUEST.requesterRunAttempt,
        requesterRunId: REQUEST.requesterRunId,
        workflowSha: WORKFLOW_SHA,
      },
      producer: {
        repository: PRODUCER_REPOSITORY,
        repositorySha: PRODUCER_SHA,
        ref: "main",
        workflowPath: PRODUCER_WORKFLOW_PATH,
        runId: RUN_ID,
        runAttempt: 1,
        workflowId: String(WORKFLOW_ID),
        runUrl: API_RUN_URL,
        htmlUrl: HTML_RUN_URL,
        completedAt: new Date(BASE_TIME + 1_000).toISOString(),
      },
      artifact: {
        id: "86420",
        name: `nemoclaw-image-handoff-v1-${RUN_ID}-1`,
        digest: `sha256:${"0".repeat(64)}`,
        sizeInBytes: 7,
        apiUrl: `https://api.github.com/repos/${PRODUCER_REPOSITORY}/actions/artifacts/86420`,
        archiveDownloadUrl: `https://api.github.com/repos/${PRODUCER_REPOSITORY}/actions/artifacts/86420/zip`,
        archiveSha256: "0".repeat(64),
        manifestSha256,
      },
    };
    fs.writeFileSync(
      path.join(workDir, DISPATCH_INTENT_FILE),
      `${JSON.stringify(dispatchIntent(), null, 2)}\n`,
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(workDir, STATE_FILE), `${JSON.stringify(state)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(workDir, MANIFEST_ARTIFACT_FILE), manifest, { mode: 0o600 });
    fs.writeFileSync(path.join(workDir, VALIDATED_MANIFEST_FILE), normalized, { mode: 0o600 });
    try {
      expect(() =>
        finalizeExactImageQualification(workDir, {
          now: () => BASE_TIME + 45 * 60_000,
        }),
      ).toThrowError(expect.objectContaining({ code: "QUALIFICATION_TIMEOUT" }));
      expect(fs.existsSync(path.join(workDir, EVIDENCE_FILE))).toBe(false);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("loads under the workflow's dependency-free Node strip-types runtime", () => {
    const script = path.resolve("tools/e2e/exact-image-qualification-controller.mts");
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        script,
        "--mode",
        "cancel",
        "--work-dir",
        "/does/not/exist",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, NEMOCLAW_IMAGE_QUALIFICATION_TOKEN: "test-token" },
        timeout: 10_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("No active producer run");
  });
});
