// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  formatReliabilityReport,
  githubArchive,
  githubJson,
  MAX_RUN_REFERENCES_PER_OUTCOME,
  normalizeMatchingReliabilityRun,
  normalizeReliabilityRun,
  type ReliabilitySample,
  summarizeReliability,
} from "../../../tools/e2e/same-commit-reliability.mts";
import { readValidatedArtifactZipEntries } from "../../../scripts/lib/read-artifact-zip.mts";
import {
  RETRY_FAILURE_CLASSES,
  type RetryFailureClass,
} from "../../../tools/e2e/retry-evidence.mts";
import { artifactZip } from "../../helpers/artifact-zip";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const REPOSITORY = "NVIDIA/NemoClaw";
const RETRY_WORKFLOW_PATH = ".github/workflows/e2e-main-retry.yaml";

function sample(
  runId: number,
  candidateSha: string,
  source: ReliabilitySample["source"],
  outcome: ReliabilitySample["outcome"],
  failureClasses: ReliabilitySample["failureClasses"] = [],
): ReliabilitySample {
  return {
    runId,
    runAttempt: outcome === "passed-after-retry" || outcome === "exhausted" ? 2 : 1,
    candidateSha,
    source,
    outcome,
    failureClasses,
    evidence: "complete",
    failureClassEvidence: failureClasses.length > 0 ? "complete" : "missing",
    url: `https://github.com/${REPOSITORY}/actions/runs/${runId}`,
  };
}

function workflowRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    run_attempt: 1,
    status: "completed",
    conclusion: "failure",
    event: "workflow_dispatch",
    path: ".github/workflows/e2e.yaml",
    display_title: "E2E PR #7 (qualification)",
    head_branch: "main",
    head_sha: SHA_B,
    html_url: `https://github.com/${REPOSITORY}/actions/runs/101`,
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    ...overrides,
  };
}

function controllerRun(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    status: "in_progress",
    event: "workflow_run",
    path: RETRY_WORKFLOW_PATH,
    head_branch: "main",
    head_sha: SHA_A,
    html_url: `https://github.com/${REPOSITORY}/actions/runs/${id}`,
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    ...overrides,
  };
}

function retryEvidence(runId: number, sourceSha: string): Buffer {
  return artifactZip([
    {
      name: "e2e-main-retry-evidence.json",
      contents: JSON.stringify({
        schemaVersion: 1,
        sourceRunId: runId,
        sourceSha,
        sourceAttempt: 1,
        action: "passed-first-attempt",
        reason: "source run passed",
      }),
    },
  ]);
}

function terminalEvidence(
  candidateSha: string,
  jobStatus: "failure" | "success",
): { name: string; contents: string } {
  return {
    name: "e2e-artifacts/live/example/evidence-manifest.json",
    contents: JSON.stringify({
      kind: "nemoclaw-e2e-evidence-v1",
      targetId: "example",
      candidate: { repository: REPOSITORY, sha: candidateSha },
      workflow: {
        repository: REPOSITORY,
        sha: SHA_B,
        runId: "101",
        runAttempt: "1",
        jobStatus,
      },
      artifactDirectory: "e2e-artifacts/live/example",
      productEvidenceFileCount: 1,
    }),
  };
}

function mappedRequest(entries: ReadonlyArray<readonly [string, unknown]>) {
  const responses = new Map(entries);
  return async (path: string): Promise<unknown> => {
    expect(responses.has(path), `unexpected path ${path}`).toBe(true);
    return responses.get(path);
  };
}

describe("bounded GitHub reads", () => {
  it("bounds a never-resolving GET and redacts its token from diagnostics", async () => {
    const path = "repos/NVIDIA/NemoClaw/actions/runs/999";
    const token = "secret-token-value";
    const request = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    });

    const failure = githubJson(path, token, {
      fetch: request as typeof fetch,
      maxAttempts: 2,
      attemptTimeoutMs: 5,
      delayMs: 0,
    });
    await expect(failure).rejects.toThrow(
      `GitHub GET ${path} failed (timeout); attempts [1:timeout, 2:timeout]`,
    );
    await expect(failure).rejects.not.toThrow(token);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });

  it("accepts a JSON body exactly at its explicit byte boundary", async () => {
    const body = '{"value":"ok"}';
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));

    await expect(
      githubJson("repos/NVIDIA/NemoClaw/actions/runs/1000", "token", {
        fetch: request,
        maxJsonBytes: Buffer.byteLength(body),
      }),
    ).resolves.toEqual({ value: "ok" });
  });

  it("cancels a JSON stream when it crosses its explicit byte boundary", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":"too large"}'));
      },
      cancel,
    });
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));

    await expect(
      githubJson("repos/NVIDIA/NemoClaw/actions/runs/1001", "token", {
        fetch: request,
        maxAttempts: 1,
        maxJsonBytes: 8,
      }),
    ).rejects.toThrow("failed (too-large); attempts [1:too-large]");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("redacts a malformed JSON response from terminal and attempt evidence", async () => {
    const secret = "unique-malformed-json-secret-7e1305";
    const path = "repos/NVIDIA/NemoClaw/actions/runs/1001-json";
    const attemptEvidence: { path: string; attempt: number; outcome: string }[] = [];
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(`{"value":"${secret}"`));

    const failure = githubJson(path, "token", {
      fetch: request,
      maxAttempts: 1,
      attemptEvidence,
    });
    await expect(failure).rejects.toThrow(
      `GitHub GET ${path} failed (invalid-json); attempts [1:invalid-json]`,
    );
    await expect(failure).rejects.not.toThrow(secret);
    expect(JSON.stringify(attemptEvidence)).not.toContain(secret);
    expect(attemptEvidence).toEqual([{ path, attempt: 1, outcome: "invalid-json" }]);
  });

  it("reports a transient status and successful retry as bounded structured evidence", async () => {
    const cancel = vi.fn();
    const unavailable = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("unavailable"));
        },
        cancel,
      }),
      { status: 503 },
    );
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce(Response.json({ value: "ok" }));
    const attemptEvidence: { path: string; attempt: number; outcome: string }[] = [];
    const path = "repos/NVIDIA/NemoClaw/actions/runs/1002";

    await expect(
      githubJson(path, "token", { fetch: request, delayMs: 0, attemptEvidence }),
    ).resolves.toEqual({ value: "ok" });
    expect(attemptEvidence).toEqual([
      { path, attempt: 1, outcome: "status:503" },
      { path, attempt: 2, outcome: "success" },
    ]);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("normalizes an arbitrary transport error without retaining its message", async () => {
    const secret = "unique-transport-error-secret-264b91";
    const path = "repos/NVIDIA/NemoClaw/actions/runs/1002-transport";
    const attemptEvidence: { path: string; attempt: number; outcome: string }[] = [];
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error(`socket failed: ${secret}`));

    const failure = githubJson(path, "token", {
      fetch: request,
      maxAttempts: 1,
      attemptEvidence,
    });
    await expect(failure).rejects.toThrow(
      `GitHub GET ${path} failed (transport); attempts [1:transport]`,
    );
    await expect(failure).rejects.not.toThrow(secret);
    expect(JSON.stringify(attemptEvidence)).not.toContain(secret);
    expect(attemptEvidence).toEqual([{ path, attempt: 1, outcome: "transport" }]);
  });

  it("recovers when the response transport fails while reading its body", async () => {
    const pull = vi
      .fn<(controller: ReadableStreamDefaultController<Uint8Array>) => void>()
      .mockImplementationOnce((controller) =>
        controller.enqueue(new TextEncoder().encode('{"value":')),
      )
      .mockImplementationOnce((controller) => controller.error(new TypeError("terminated")));
    const interrupted = new Response(new ReadableStream<Uint8Array>({ pull }));
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(interrupted)
      .mockResolvedValueOnce(Response.json({ value: "recovered" }));
    const attemptEvidence: { path: string; attempt: number; outcome: string }[] = [];

    await expect(
      githubJson("repos/NVIDIA/NemoClaw/actions/runs/1003", "token", {
        fetch: request,
        delayMs: 0,
        attemptEvidence,
      }),
    ).resolves.toEqual({ value: "recovered" });
    expect(attemptEvidence.map(({ outcome }) => outcome)).toEqual(["transport", "success"]);
  });

  it("cancels a terminal 401 body before throwing without retry", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 401 });
    const request = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(
      githubJson("repos/NVIDIA/NemoClaw/actions/runs/1004", "token", { fetch: request }),
    ).rejects.toThrow("failed (status:401); attempts [1:status:401]");
    expect(cancel).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
  });

  it("cancels a terminal 403 body before throwing without retry", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 403 });
    const request = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(
      githubJson("repos/NVIDIA/NemoClaw/actions/runs/1005", "token", { fetch: request }),
    ).rejects.toThrow("failed (status:403); attempts [1:status:403]");
    expect(cancel).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
  });

  it("cancels an oversized artifact stream before retaining the full response", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
      },
      cancel,
    });
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));

    await expect(githubArchive(7, 10, "token", { fetch: request, maxAttempts: 1 })).rejects.toThrow(
      "GitHub GET repos/NVIDIA/NemoClaw/actions/artifacts/7/zip failed (too-large); attempts [1:too-large]",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("same-commit E2E reliability", () => {
  it("keeps commits and run sources separate while reporting recovery and flips", () => {
    const groups = summarizeReliability([
      sample(1, SHA_A, "trusted-main", "failed-first-attempt", ["assertion"]),
      sample(2, SHA_A, "trusted-main", "passed-after-retry", ["transient-external"]),
      sample(3, SHA_A, "trusted-main", "exhausted", ["timeout"]),
      sample(4, SHA_A, "trusted-main", "passed-first-attempt"),
      sample(5, SHA_A, "manual-qualification", "passed-first-attempt"),
      sample(6, SHA_B, "trusted-main", "passed-first-attempt"),
      sample(7, SHA_A, "trusted-main", "superseded"),
    ]);

    expect(groups).toHaveLength(3);
    expect(
      groups.find((group) => group.source === "trusted-main" && group.candidateSha === SHA_A),
    ).toMatchObject({
      runs: 5,
      passedFirstAttempt: 1,
      passedAfterRetry: 1,
      failedFirstAttempt: 1,
      exhausted: 1,
      superseded: 1,
      passFailFlips: 3,
      firstPassRate: 0.25,
      recoveryRate: 0.5,
      failureClasses: { assertion: 1, "transient-external": 1, timeout: 1 },
    });
  });

  it("retains bounded failed, exhausted, malformed, and unclassified run identities", () => {
    const failed = Array.from({ length: MAX_RUN_REFERENCES_PER_OUTCOME + 2 }, (_, index) =>
      sample(100 + index, SHA_A, "trusted-main", "failed-first-attempt", ["assertion"]),
    );
    const exhausted = sample(200, SHA_A, "trusted-main", "exhausted", ["timeout"]);
    const malformed = {
      ...sample(201, SHA_A, "trusted-main", "unclassified", ["unclassified"]),
      evidence: "malformed" as const,
      failureClassEvidence: "malformed" as const,
    };
    const unclassified = sample(202, SHA_A, "trusted-main", "unclassified", ["unclassified"]);

    const group = summarizeReliability([...failed, exhausted, malformed, unclassified])[0]!;
    expect(group.runReferences["failed-first-attempt"]).toMatchObject({
      total: MAX_RUN_REFERENCES_PER_OUTCOME + 2,
      retained: MAX_RUN_REFERENCES_PER_OUTCOME,
      truncated: true,
    });
    expect(group.runReferences["failed-first-attempt"].references[0]).toEqual({
      runId: 100,
      attempt: 1,
      outcome: "failed-first-attempt",
      evidence: "complete",
      failureClassEvidence: "complete",
      url: `https://github.com/${REPOSITORY}/actions/runs/100`,
    });
    expect(group.runReferences.exhausted.references).toEqual([
      expect.objectContaining({ runId: 200, attempt: 2, outcome: "exhausted" }),
    ]);
    expect(group.runReferences.unclassified.references).toEqual([
      expect.objectContaining({ runId: 201, outcome: "unclassified", evidence: "malformed" }),
      expect.objectContaining({ runId: 202, outcome: "unclassified", evidence: "complete" }),
    ]);

    const json = JSON.stringify(group);
    const markdown = formatReliabilityReport([group]);
    expect(json).toContain("actions/runs/100");
    expect(json).toContain("actions/runs/200");
    expect(json).toContain("actions/runs/201");
    expect(json).toContain("actions/runs/202");
    expect(markdown).toContain("[Run 100 attempt ");
    expect(markdown).toContain("[Run 200 attempt ");
    expect(markdown).toContain("[Run 201 attempt ");
    expect(markdown).toContain("[Run 202 attempt ");
    expect(markdown).toContain("failed-first-attempt: 2 additional run reference(s) truncated");
    expect(markdown).toContain("outcome evidence: malformed");
  });

  it("renders only normalized identities and fixed classes, never input credentials", () => {
    const secret = "ghp_should-never-appear";
    const report = formatReliabilityReport([
      ...summarizeReliability([
        sample(1, SHA_A, "trusted-main", "failed-first-attempt", [
          "authentication",
          secret as ReliabilitySample["failureClasses"][number],
        ]),
      ]),
    ]);

    expect(report).toContain("authentication: 1");
    expect(report).toContain(SHA_A.slice(0, 12));
    expect(report).not.toContain(secret);
  });

  it("consumes dispatch, retry, and runner classifications without retaining payload text", async () => {
    const secret = "sk-live-secret-output";
    const dispatch = artifactZip([
      {
        name: "dispatch.json",
        contents: JSON.stringify({
          kind: "nemoclaw-e2e-dispatch-v2",
          repository: REPOSITORY,
          eventName: "workflow_dispatch",
          workflowRunId: "101",
          workflowRunAttempt: 1,
          candidateSha: SHA_A,
          ignoredCredential: secret,
        }),
      },
    ]);
    const evidence = artifactZip([
      terminalEvidence(SHA_A, "failure"),
      {
        name: "e2e-artifacts/live/example/runner-pressure-classification.jsonl",
        contents:
          'E2E_TERMINAL_CLASSIFICATION {"v":1,"classification":"timeout","reason":"phase timed out"}\n',
      },
      {
        name: "e2e-artifacts/live/example/retry/provider.json",
        contents: JSON.stringify({
          schemaVersion: 1,
          operation: "provider.readiness",
          owner: "provider",
          idempotence: "read-only",
          maxAttempts: 2,
          outcome: "exhausted",
          attempts: [
            {
              attempt: 1,
              outcome: "failed",
              failureClass: "transient-external",
              retryScheduled: true,
            },
            {
              attempt: 2,
              outcome: "failed",
              failureClass: "transient-external",
              retryScheduled: false,
            },
          ],
          ignoredCredential: secret,
        }),
      },
    ]);
    const archives = new Map([
      [1, dispatch],
      [2, evidence],
    ]);
    const requestArchive = async (artifactId: number) => archives.get(artifactId)!;
    const readArtifactEntries = readValidatedArtifactZipEntries;
    const result = await normalizeReliabilityRun(workflowRun(), {
      requestJson: async () => ({
        total_count: 2,
        artifacts: [
          {
            id: 1,
            name: "e2e-dispatch-101-1",
            size_in_bytes: dispatch.length,
            expired: false,
          },
          {
            id: 2,
            name: "e2e-example",
            size_in_bytes: evidence.length,
            expired: false,
          },
        ],
      }),
      requestArchive,
      readArtifactEntries,
    });

    expect(result).toMatchObject({
      candidateSha: SHA_A,
      source: "manual-qualification",
      outcome: "failed-first-attempt",
      failureClasses: ["timeout", "transient-external"],
      evidence: "complete",
      failureClassEvidence: "complete",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("normalizes a matching workflow dispatch run to the same reliability sample", async () => {
    const dispatch = artifactZip([
      {
        name: "dispatch.json",
        contents: JSON.stringify({
          kind: "nemoclaw-e2e-dispatch-v2",
          repository: REPOSITORY,
          eventName: "workflow_dispatch",
          workflowRunId: "101",
          workflowRunAttempt: 1,
          candidateSha: SHA_A,
        }),
      },
    ]);
    const evidence = artifactZip([
      terminalEvidence(SHA_A, "failure"),
      {
        name: "e2e-artifacts/live/example/runner-pressure-classification.jsonl",
        contents:
          'E2E_TERMINAL_CLASSIFICATION {"v":1,"classification":"timeout","reason":"phase timed out"}\n',
      },
    ]);
    const artifacts = {
      total_count: 2,
      artifacts: [
        {
          id: 1,
          name: "e2e-dispatch-101-1",
          size_in_bytes: dispatch.length,
          expired: false,
        },
        { id: 2, name: "e2e-example", size_in_bytes: evidence.length, expired: false },
      ],
    };
    const archives = new Map([
      [1, dispatch],
      [2, evidence],
    ]);
    const requestArchive = async (artifactId: number) => archives.get(artifactId)!;
    const baseline = await normalizeReliabilityRun(workflowRun(), {
      requestJson: async () => artifacts,
      requestArchive,
    });
    const requestJson = async () => artifacts;

    const result = await normalizeMatchingReliabilityRun(workflowRun(), SHA_A, {
      requestJson,
      requestArchive,
    });

    expect(result).toEqual(baseline);
    expect(formatReliabilityReport(summarizeReliability([result!]))).toBe(
      formatReliabilityReport(summarizeReliability([baseline!])),
    );
  });

  it.each(RETRY_FAILURE_CLASSES)(
    "processes canonical retry failure class %s as complete evidence",
    async (failureClass: RetryFailureClass) => {
      const dispatch = artifactZip([
        {
          name: "dispatch.json",
          contents: JSON.stringify({
            kind: "nemoclaw-e2e-dispatch-v2",
            repository: REPOSITORY,
            eventName: "workflow_dispatch",
            workflowRunId: "101",
            workflowRunAttempt: 1,
            candidateSha: SHA_A,
          }),
        },
      ]);
      const evidence = artifactZip([
        terminalEvidence(SHA_A, "failure"),
        {
          name: "e2e-artifacts/live/example/retry/provider.json",
          contents: JSON.stringify({
            schemaVersion: 1,
            operation: "provider.readiness",
            owner: "provider",
            idempotence: "read-only",
            maxAttempts: 1,
            outcome: failureClass === "transient-external" ? "exhausted" : "failed-no-retry",
            attempts: [
              {
                attempt: 1,
                outcome: "failed",
                failureClass,
                retryScheduled: false,
              },
            ],
          }),
        },
      ]);
      const archives = new Map([
        [1, dispatch],
        [2, evidence],
      ]);

      const result = await normalizeReliabilityRun(workflowRun(), {
        requestJson: async () => ({
          total_count: 2,
          artifacts: [
            {
              id: 1,
              name: "e2e-dispatch-101-1",
              size_in_bytes: dispatch.length,
              expired: false,
            },
            { id: 2, name: "e2e-example", size_in_bytes: evidence.length, expired: false },
          ],
        }),
        requestArchive: async (artifactId) => archives.get(artifactId)!,
      });

      expect(result).toMatchObject({
        failureClasses: [failureClass],
        failureClassEvidence: "complete",
      });
    },
  );

  it("keeps missing or malformed manual identity evidence unclassified", async () => {
    const missing = await normalizeReliabilityRun(workflowRun({ conclusion: "success" }), {
      requestJson: async () => ({ total_count: 0, artifacts: [] }),
      requestArchive: async () => Buffer.alloc(0),
    });
    expect(missing).toMatchObject({
      candidateSha: null,
      outcome: "unclassified",
      evidence: "missing",
    });
    expect(summarizeReliability([missing!])).toEqual([
      expect.objectContaining({ candidateSha: null, runs: 1, unclassified: 1 }),
    ]);

    const malformedZip = artifactZip([{ name: "dispatch.json", contents: "{}" }]);
    const malformed = await normalizeReliabilityRun(workflowRun({ conclusion: "success" }), {
      requestJson: async () => ({
        total_count: 1,
        artifacts: [
          {
            id: 9,
            name: "e2e-dispatch-101-1",
            size_in_bytes: malformedZip.length,
            expired: false,
          },
        ],
      }),
      requestArchive: async () => malformedZip,
    });
    expect(malformed).toMatchObject({
      candidateSha: null,
      outcome: "unclassified",
      evidence: "malformed",
    });
  });

  it("requires terminal evidence after authenticating a manual dispatch", async () => {
    const dispatch = artifactZip([
      {
        name: "dispatch.json",
        contents: JSON.stringify({
          kind: "nemoclaw-e2e-dispatch-v2",
          repository: REPOSITORY,
          eventName: "workflow_dispatch",
          workflowRunId: "101",
          workflowRunAttempt: 1,
          candidateSha: SHA_A,
        }),
      },
    ]);
    const result = await normalizeReliabilityRun(workflowRun({ conclusion: "success" }), {
      requestJson: async () => ({
        total_count: 1,
        artifacts: [
          {
            id: 1,
            name: "e2e-dispatch-101-1",
            size_in_bytes: dispatch.length,
            expired: false,
          },
        ],
      }),
      requestArchive: async () => dispatch,
    });

    expect(result).toMatchObject({
      candidateSha: SHA_A,
      source: "manual-qualification",
      outcome: "unclassified",
      evidence: "missing",
    });
    expect(summarizeReliability([result!])[0]).toMatchObject({
      passedFirstAttempt: 0,
      unclassified: 1,
    });
  });

  it("accepts authenticated terminal evidence for a passing manual run", async () => {
    const dispatch = artifactZip([
      {
        name: "dispatch.json",
        contents: JSON.stringify({
          kind: "nemoclaw-e2e-dispatch-v2",
          repository: REPOSITORY,
          eventName: "workflow_dispatch",
          workflowRunId: "101",
          workflowRunAttempt: 1,
          candidateSha: SHA_A,
        }),
      },
    ]);
    const terminal = artifactZip([terminalEvidence(SHA_A, "success")]);
    const archives = new Map([
      [1, dispatch],
      [2, terminal],
    ]);
    const result = await normalizeReliabilityRun(workflowRun({ conclusion: "success" }), {
      requestJson: async () => ({
        total_count: 2,
        artifacts: [
          {
            id: 1,
            name: "e2e-dispatch-101-1",
            size_in_bytes: dispatch.length,
            expired: false,
          },
          {
            id: 2,
            name: "e2e-example",
            size_in_bytes: terminal.length,
            expired: false,
          },
        ],
      }),
      requestArchive: async (artifactId) => archives.get(artifactId)!,
    });

    expect(result).toMatchObject({
      candidateSha: SHA_A,
      source: "manual-qualification",
      outcome: "passed-first-attempt",
      evidence: "complete",
      failureClassEvidence: "missing",
    });
  });

  it("reports an invalid retry invariant as malformed without discarding a terminal outcome", async () => {
    const dispatch = artifactZip([
      {
        name: "dispatch.json",
        contents: JSON.stringify({
          kind: "nemoclaw-e2e-dispatch-v2",
          repository: REPOSITORY,
          eventName: "workflow_dispatch",
          workflowRunId: "101",
          workflowRunAttempt: 1,
          candidateSha: SHA_A,
        }),
      },
    ]);
    const terminal = artifactZip([
      terminalEvidence(SHA_A, "success"),
      {
        name: "e2e-artifacts/live/example/retry/provider.json",
        contents: JSON.stringify({
          schemaVersion: 1,
          operation: "provider.readiness",
          owner: "provider",
          idempotence: "read-only",
          maxAttempts: 1,
          outcome: "passed-first-attempt",
          attempts: [
            {
              attempt: 1,
              outcome: "failed",
              failureClass: "deterministic",
              retryScheduled: false,
            },
          ],
        }),
      },
    ]);
    const archives = new Map([
      [1, dispatch],
      [2, terminal],
    ]);
    const result = await normalizeReliabilityRun(workflowRun({ conclusion: "success" }), {
      requestJson: async () => ({
        total_count: 2,
        artifacts: [
          {
            id: 1,
            name: "e2e-dispatch-101-1",
            size_in_bytes: dispatch.length,
            expired: false,
          },
          {
            id: 2,
            name: "e2e-example",
            size_in_bytes: terminal.length,
            expired: false,
          },
        ],
      }),
      requestArchive: async (artifactId) => archives.get(artifactId)!,
    });

    expect(result).toMatchObject({
      outcome: "passed-first-attempt",
      evidence: "complete",
      failureClassEvidence: "malformed",
    });
    const groups = summarizeReliability([result!]);
    expect(groups[0]).toMatchObject({
      evidence: { complete: 1, malformed: 0, missing: 0 },
      failureClassEvidence: { complete: 0, malformed: 1, missing: 0 },
    });
    expect(formatReliabilityReport(groups)).toContain("complete: 0, malformed: 1, missing: 0");
  });

  it("marks selected entries malformed when they exceed their decoding limits", async () => {
    const dispatch = artifactZip([
      {
        name: "dispatch.json",
        contents: JSON.stringify({
          kind: "nemoclaw-e2e-dispatch-v2",
          repository: REPOSITORY,
          eventName: "workflow_dispatch",
          workflowRunId: "101",
          workflowRunAttempt: 1,
          candidateSha: SHA_A,
        }),
      },
    ]);
    const manifest = terminalEvidence(SHA_A, "failure");
    const retry = JSON.stringify({
      schemaVersion: 1,
      operation: "provider.readiness",
      owner: "provider",
      idempotence: "read-only",
      maxAttempts: 1,
      outcome: "failed-no-retry",
      attempts: [
        {
          attempt: 1,
          outcome: "failed",
          failureClass: "transient-external",
          retryScheduled: false,
        },
      ],
    });
    const evidence = artifactZip([
      { ...manifest, contents: manifest.contents.padEnd(16_385) },
      {
        name: "e2e-artifacts/live/example/runner-pressure-classification.jsonl",
        contents:
          'E2E_TERMINAL_CLASSIFICATION {"v":1,"classification":"timeout","reason":"phase timed out"}\n',
      },
      {
        name: "e2e-artifacts/live/example/retry/provider.json",
        contents: retry.padEnd(64 * 1024 + 1),
      },
    ]);
    const archives = new Map([
      [1, dispatch],
      [2, evidence],
    ]);

    const result = await normalizeReliabilityRun(workflowRun(), {
      requestJson: async () => ({
        total_count: 2,
        artifacts: [
          {
            id: 1,
            name: "e2e-dispatch-101-1",
            size_in_bytes: dispatch.length,
            expired: false,
          },
          {
            id: 2,
            name: "e2e-example",
            size_in_bytes: evidence.length,
            expired: false,
          },
        ],
      }),
      requestArchive: async (artifactId) => archives.get(artifactId)!,
    });

    expect(result).toMatchObject({
      candidateSha: SHA_A,
      outcome: "unclassified",
      failureClasses: ["timeout"],
      evidence: "malformed",
      failureClassEvidence: "malformed",
    });
  });

  it("accepts trusted-main evidence only from the canonical retry controller", async () => {
    const archive = retryEvidence(101, SHA_B);
    const name = "e2e-main-retry-101-1";
    const result = await normalizeReliabilityRun(
      workflowRun({
        event: "push",
        conclusion: "success",
        display_title: "E2E main",
      }),
      {
        requestJson: mappedRequest([
          [
            `repos/${REPOSITORY}/actions/runs/101/artifacts?per_page=100`,
            { total_count: 0, artifacts: [] },
          ],
          [
            `repos/${REPOSITORY}/actions/artifacts?name=${name}&per_page=100`,
            {
              total_count: 1,
              artifacts: [
                {
                  id: 7,
                  name,
                  size_in_bytes: archive.length,
                  expired: false,
                  workflow_run: { id: 202 },
                },
              ],
            },
          ],
          [`repos/${REPOSITORY}/actions/runs/202`, controllerRun(202)],
        ]),
        requestArchive: async () => archive,
      },
    );

    expect(result).toMatchObject({
      candidateSha: SHA_B,
      source: "trusted-main",
      outcome: "passed-first-attempt",
      evidence: "complete",
    });
  });

  it("rejects trusted-main evidence from an untrusted workflow", async () => {
    const archive = retryEvidence(101, SHA_B);
    const name = "e2e-main-retry-101-1";
    const result = await normalizeReliabilityRun(
      workflowRun({
        event: "push",
        conclusion: "success",
        display_title: "E2E main",
      }),
      {
        requestJson: mappedRequest([
          [
            `repos/${REPOSITORY}/actions/runs/101/artifacts?per_page=100`,
            { total_count: 0, artifacts: [] },
          ],
          [
            `repos/${REPOSITORY}/actions/artifacts?name=${name}&per_page=100`,
            {
              total_count: 1,
              artifacts: [
                {
                  id: 8,
                  name,
                  size_in_bytes: archive.length,
                  expired: false,
                  workflow_run: { id: 203 },
                },
              ],
            },
          ],
          [
            `repos/${REPOSITORY}/actions/runs/203`,
            controllerRun(203, { path: ".github/workflows/other.yaml" }),
          ],
        ]),
        requestArchive: async () => archive,
      },
    );

    expect(result).toMatchObject({
      candidateSha: SHA_B,
      source: "trusted-main",
      outcome: "unclassified",
      evidence: "malformed",
    });
  });

  it("fails closed when trusted-main artifact names collide", async () => {
    const archive = retryEvidence(101, SHA_B);
    const name = "e2e-main-retry-101-1";
    const result = await normalizeReliabilityRun(
      workflowRun({
        event: "push",
        conclusion: "success",
        display_title: "E2E main",
      }),
      {
        requestJson: mappedRequest([
          [
            `repos/${REPOSITORY}/actions/runs/101/artifacts?per_page=100`,
            { total_count: 0, artifacts: [] },
          ],
          [
            `repos/${REPOSITORY}/actions/artifacts?name=${name}&per_page=100`,
            {
              total_count: 2,
              artifacts: [202, 203].map((controllerId) => ({
                id: controllerId,
                name,
                size_in_bytes: archive.length,
                expired: false,
                workflow_run: { id: controllerId },
              })),
            },
          ],
        ]),
        requestArchive: async () => archive,
      },
    );

    expect(result).toMatchObject({
      candidateSha: SHA_B,
      source: "trusted-main",
      outcome: "unclassified",
      evidence: "malformed",
    });
  });
});
