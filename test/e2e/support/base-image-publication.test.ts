// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectPaginated,
  type FirstParentHistory,
  githubRequest,
  type PublicationRun,
  parseBaseImagePushPaths,
  resolveFirstParentHistory,
  selectPublicationRun,
  validateBoundRun,
  validatePublisherJobs,
  validateWorkflow,
  waitForBaseImagePublication,
} from "../../../tools/e2e/base-image-publication.mts";

const EXPECTED_SHA = "a".repeat(40);
const DESCENDANT_SHA = "b".repeat(40);
const RELEVANT_SHA = "c".repeat(40);
const STALE_SHA = "d".repeat(40);
const RUN_ID = 29891942278;
const WORKFLOW_ID = 251475843;
const RUN_URL_ROOT = "https://github.com/NVIDIA/NemoClaw/actions/runs";
const RUN_URL = `https://github.com/NVIDIA/NemoClaw/actions/runs/${RUN_ID}`;
const WORKFLOW_SOURCE = `on:
  push:
    branches: [main]
    paths:
      - ".github/workflows/base-image.yaml"
      - "Dockerfile.base"
  workflow_dispatch:
jobs: {}
`;

function required<T>(value: T | undefined, message: string): T {
  return (
    value ??
    (() => {
      throw new Error(message);
    })()
  );
}

function historyGitResponse(args: string[], relevantSha: string, firstParentShas: string): string {
  const responses = new Map([
    ["rev-parse:--verify", EXPECTED_SHA],
    ["rev-parse:--is-shallow-repository", "false"],
    ["log:--first-parent", relevantSha],
    ["rev-list:--first-parent", firstParentShas],
  ]);
  return required(responses.get(`${args[0]}:${args[1]}`), "unexpected git history request");
}

function nextFetchResponse(responses: Array<Response | Error>): Promise<Response> {
  const response = required(responses.shift(), "unexpected GitHub request");
  return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
}

function history(): FirstParentHistory {
  return {
    expectedSha: EXPECTED_SHA,
    relevantSha: RELEVANT_SHA,
    relevantDistance: 2,
    distanceBySha: new Map([
      [EXPECTED_SHA, 0],
      [DESCENDANT_SHA, 1],
      [RELEVANT_SHA, 2],
    ]),
  };
}

function workflowRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RUN_ID,
    run_attempt: 1,
    workflow_id: WORKFLOW_ID,
    name: "Images / Base Images",
    event: "push",
    status: "completed",
    conclusion: "success",
    head_sha: RELEVANT_SHA,
    head_branch: "main",
    path: ".github/workflows/base-image.yaml",
    repository: { full_name: "NVIDIA/NemoClaw" },
    head_repository: { full_name: "NVIDIA/NemoClaw" },
    html_url: RUN_URL,
    ...overrides,
  };
}

function workflowMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: WORKFLOW_ID,
    name: "Images / Base Images",
    path: ".github/workflows/base-image.yaml",
    state: "active",
    html_url: "https://github.com/NVIDIA/NemoClaw/blob/main/.github/workflows/base-image.yaml",
    url: `https://api.github.com/repos/NVIDIA/NemoClaw/actions/workflows/${WORKFLOW_ID}`,
    ...overrides,
  };
}

function runsPayload(runs: unknown[]): Record<string, unknown> {
  return { total_count: runs.length, workflow_runs: runs };
}

function selectedRun(overrides: Partial<PublicationRun> = {}): PublicationRun {
  return {
    id: RUN_ID,
    attempt: 1,
    workflowId: WORKFLOW_ID,
    headSha: RELEVANT_SHA,
    status: "completed",
    conclusion: "success",
    url: RUN_URL,
    ...overrides,
  };
}

function publisherJob(
  name: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 1000,
    run_id: RUN_ID,
    run_attempt: 1,
    head_sha: RELEVANT_SHA,
    name,
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}

function successfulJobs(overrides: { runAttempt?: number } = {}): Record<string, unknown>[] {
  const runAttempt = overrides.runAttempt ?? 1;
  return [
    publisherJob("Build and push OpenClaw base image", { id: 1, run_attempt: runAttempt }),
    publisherJob("Build and push Hermes base image", { id: 2, run_attempt: runAttempt }),
    publisherJob("Build and push Deep Agents Code base image", {
      id: 3,
      run_attempt: runAttempt,
    }),
  ];
}

describe("base-image publication evidence", () => {
  it("extracts the checked-in literal publisher paths without runtime dependencies (#7372)", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../../.github/workflows/base-image.yaml"),
      "utf8",
    );

    expect(parseBaseImagePushPaths(source)).toEqual(
      expect.arrayContaining([
        ".github/workflows/base-image.yaml",
        "Dockerfile.base",
        "agents/hermes/Dockerfile.base",
        "agents/langchain-deepagents-code/Dockerfile.base",
      ]),
    );
  });

  it.each([
    [
      "a duplicate",
      WORKFLOW_SOURCE.replace(
        '      - "Dockerfile.base"',
        '      - "Dockerfile.base"\n      - "Dockerfile.base"',
      ),
      /must be unique/u,
    ],
    [
      "a glob",
      WORKFLOW_SOURCE.replace("Dockerfile.base", "Dockerfile.*"),
      /not a safe literal path/u,
    ],
    [
      "a parent traversal",
      WORKFLOW_SOURCE.replace("Dockerfile.base", "../Dockerfile.base"),
      /not a safe literal path/u,
    ],
    [
      "an unquoted scalar",
      WORKFLOW_SOURCE.replace('"Dockerfile.base"', "Dockerfile.base"),
      /must be one quoted scalar/u,
    ],
    [
      "a missing workflow path",
      WORKFLOW_SOURCE.replace('      - ".github/workflows/base-image.yaml"\n', ""),
      /must include/u,
    ],
    [
      "a flow list",
      WORKFLOW_SOURCE.replace(
        'paths:\n      - ".github/workflows/base-image.yaml"\n      - "Dockerfile.base"',
        'paths: [".github/workflows/base-image.yaml", "Dockerfile.base"]',
      ),
      /non-empty on\.push\.paths/u,
    ],
    [
      "a non-main branch",
      WORKFLOW_SOURCE.replace("branches: [main]", "branches: [release]"),
      /non-empty on\.push\.paths/u,
    ],
  ])("rejects %s in publisher trigger paths (#7372)", (_case, source, expected) => {
    expect(() => parseBaseImagePushPaths(source)).toThrow(expected);
  });

  it("binds the applicable commit to the checked-out first-parent chain (#7372)", () => {
    const calls: string[][] = [];
    const resolved = resolveFirstParentHistory(EXPECTED_SHA, ["Dockerfile.base"], (args) => {
      calls.push(args);
      return historyGitResponse(
        args,
        RELEVANT_SHA,
        `${EXPECTED_SHA}\n${DESCENDANT_SHA}\n${RELEVANT_SHA}\n${STALE_SHA}`,
      );
    });

    expect(resolved.relevantSha).toBe(RELEVANT_SHA);
    expect([...resolved.distanceBySha]).toEqual([
      [EXPECTED_SHA, 0],
      [DESCENDANT_SHA, 1],
      [RELEVANT_SHA, 2],
    ]);
    expect(calls[2]).toEqual([
      "log",
      "--first-parent",
      "-n",
      "1",
      "--format=%H",
      EXPECTED_SHA,
      "--",
      "Dockerfile.base",
    ]);
  });

  it("selects the merge commit instead of its side-branch source commit (#7372)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-publication-history-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
    const write = (file: string, contents: string) =>
      fs.writeFileSync(path.join(directory, file), contents);
    const commit = (message: string) => {
      git("add", ".");
      git("commit", "-m", message);
      return git("rev-parse", "HEAD");
    };

    try {
      git("init", "-b", "main");
      git("config", "user.name", "NemoClaw Test");
      git("config", "user.email", "test@example.com");
      write("Dockerfile.base", "base\n");
      commit("base");
      write("unrelated.txt", "main\n");
      const branchPoint = commit("main change");
      git("switch", "-c", "feature");
      write("Dockerfile.base", "feature\n");
      const sideBranchSha = commit("side change");
      git("switch", "main");
      write("main-only.txt", "main\n");
      commit("later main change");
      git("merge", "--no-ff", "feature", "-m", "merge feature");
      const mergeSha = git("rev-parse", "HEAD");

      const resolved = resolveFirstParentHistory(mergeSha, ["Dockerfile.base"], (args) =>
        git(...args),
      );

      expect(branchPoint).not.toBe(sideBranchSha);
      expect(resolved.relevantSha).toBe(mergeSha);
      expect(resolved.distanceBySha.has(sideBranchSha)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects checkout and history identity drift (#7372)", () => {
    expect(() =>
      resolveFirstParentHistory(EXPECTED_SHA, ["Dockerfile.base"], () => DESCENDANT_SHA),
    ).toThrow(/checked-out commit/u);
    expect(() =>
      resolveFirstParentHistory(EXPECTED_SHA, ["Dockerfile.base"], (args) =>
        historyGitResponse(args, STALE_SHA, `${EXPECTED_SHA}\n${RELEVANT_SHA}`),
      ),
    ).toThrow(/not on the first-parent history/u);
  });

  it("binds API evidence to the active checked-in workflow identity (#7372)", () => {
    expect(validateWorkflow(workflowMetadata())).toBe(WORKFLOW_ID);
    expect(() => validateWorkflow(workflowMetadata({ state: "disabled_manually" }))).toThrow(
      /state must be active/u,
    );
    expect(() =>
      selectPublicationRun(
        runsPayload([workflowRun({ workflow_id: WORKFLOW_ID + 1 })]),
        history(),
        WORKFLOW_ID,
      ),
    ).toThrow(/workflow id does not match/u);
  });

  it("collects page-two evidence and rejects duplicate or truncated pagination (#7372)", async () => {
    const entries = Array.from({ length: 101 }, (_, index) => ({ id: index + 1 }));
    const pages = [
      { total_count: entries.length, workflow_runs: entries.slice(0, 100) },
      { total_count: entries.length, workflow_runs: entries.slice(100) },
    ];
    const requests: string[] = [];

    await expect(
      collectPaginated(
        async (requestPath) => {
          requests.push(requestPath);
          return pages.shift();
        },
        "/runs?per_page=100",
        "workflow_runs",
      ),
    ).resolves.toMatchObject({ total_count: 101, workflow_runs: entries });
    expect(requests).toEqual(["/runs?per_page=100&page=1", "/runs?per_page=100&page=2"]);

    await expect(
      collectPaginated(
        async () => ({ total_count: 101, jobs: entries.slice(0, 100) }),
        "/jobs?per_page=100",
        "jobs",
        1,
      ),
    ).rejects.toThrow(/exceeded the 1-page safety cap/u);
    await expect(
      collectPaginated(
        async () => ({ total_count: 2, jobs: [{ id: 1 }, { id: 1 }] }),
        "/jobs?per_page=100",
        "jobs",
      ),
    ).rejects.toThrow(/duplicate id/u);
  });

  it("accepts a batch-push tip that descends from the newest changed input (#7372)", () => {
    const selection = selectPublicationRun(
      runsPayload([workflowRun({ head_sha: EXPECTED_SHA })]),
      history(),
      WORKFLOW_ID,
    );

    expect(selection).toMatchObject({ state: "ready", run: { headSha: EXPECTED_SHA } });
  });

  it("prefers the graph-newest trusted run without relying on API order (#7372)", () => {
    const selection = selectPublicationRun(
      runsPayload([
        workflowRun({
          id: 10,
          head_sha: RELEVANT_SHA,
          html_url: `${RUN_URL.replace(String(RUN_ID), "10")}`,
        }),
        workflowRun({
          id: 11,
          head_sha: DESCENDANT_SHA,
          html_url: `${RUN_URL.replace(String(RUN_ID), "11")}`,
        }),
      ]),
      history(),
      WORKFLOW_ID,
    );

    expect(selection).toMatchObject({ state: "ready", run: { id: 11, headSha: DESCENDANT_SHA } });
  });

  it("waits for missing and in-progress publication evidence (#7372)", () => {
    expect(selectPublicationRun(runsPayload([]), history(), WORKFLOW_ID)).toEqual({
      state: "missing",
    });
    expect(
      selectPublicationRun(
        runsPayload([workflowRun({ status: "in_progress", conclusion: null })]),
        history(),
        WORKFLOW_ID,
      ),
    ).toMatchObject({ state: "pending", run: { status: "in_progress" } });
  });

  it.each([
    "failure",
    "cancelled",
  ] as const)("fails closed when publication concludes %s (#7372)", (conclusion) => {
    expect(() =>
      selectPublicationRun(runsPayload([workflowRun({ conclusion })]), history(), WORKFLOW_ID),
    ).toThrow(`base-image workflow for ${RELEVANT_SHA} concluded ${conclusion}; ${RUN_URL}`);
  });

  it("fails closed on ambiguous or malformed runs (#7372)", () => {
    expect(() =>
      selectPublicationRun(
        runsPayload([
          workflowRun(),
          workflowRun({ id: RUN_ID + 1, html_url: `${RUN_URL_ROOT}/${RUN_ID + 1}` }),
        ]),
        history(),
        WORKFLOW_ID,
      ),
    ).toThrow(/multiple trusted/u);
    expect(() =>
      selectPublicationRun(
        runsPayload([workflowRun({ repository: { full_name: "attacker/fork" } })]),
        history(),
        WORKFLOW_ID,
      ),
    ).toThrow(/repository must be NVIDIA\/NemoClaw/u);
    expect(() =>
      selectPublicationRun(
        { total_count: 2, workflow_runs: [workflowRun()] },
        history(),
        WORKFLOW_ID,
      ),
    ).toThrow(/incomplete/u);
  });

  it("requires every publisher latest attempt to complete successfully (#7372)", () => {
    const run = selectedRun({ attempt: 2 });
    const jobs = [
      ...successfulJobs(),
      publisherJob("Build and push Hermes base image", {
        id: 4,
        run_attempt: 1,
        conclusion: "failure",
      }),
      publisherJob("Build and push Hermes base image", { id: 5, run_attempt: 2 }),
    ].filter((job, index) => index !== 1);

    expect(() => validatePublisherJobs({ total_count: jobs.length, jobs }, run)).not.toThrow();
  });

  it("reconfirms the selected successful run after reading job history (#7372)", () => {
    expect(() => validateBoundRun(workflowRun(), selectedRun())).not.toThrow();
    expect(() =>
      validateBoundRun(workflowRun({ status: "in_progress", conclusion: null }), selectedRun()),
    ).toThrow(/changed while evidence was verified/u);
  });

  it.each([
    ["missing", successfulJobs().slice(0, 2), /missing required/u],
    [
      "duplicated",
      [...successfulJobs(), publisherJob("Build and push Hermes base image", { id: 9 })],
      /duplicated in attempt/u,
    ],
    [
      "failed latest attempt",
      successfulJobs().map((job) =>
        job.name === "Build and push Hermes base image" ? { ...job, conclusion: "failure" } : job,
      ),
      /did not complete successfully/u,
    ],
    [
      "wrong run",
      successfulJobs().map((job, index) => (index === 0 ? { ...job, run_id: 7 } : job)),
      /provenance does not match/u,
    ],
  ])("rejects %s publisher evidence (#7372)", (_case, jobs, expected) => {
    expect(() => validatePublisherJobs({ total_count: jobs.length, jobs }, selectedRun())).toThrow(
      expected,
    );
  });

  it("polls from missing through completion and verifies jobs (#7372)", async () => {
    const responses = [
      workflowMetadata(),
      runsPayload([]),
      runsPayload([workflowRun({ status: "queued", conclusion: null })]),
      runsPayload([workflowRun()]),
      { total_count: 3, jobs: successfulJobs() },
      workflowRun(),
    ];
    const requests: string[] = [];
    const notices: string[] = [];
    let currentTime = 0;

    const run = await waitForBaseImagePublication({
      history: history(),
      request: async (requestPath) => {
        requests.push(requestPath);
        return responses.shift();
      },
      waitMs: 100,
      pollMs: 10,
      now: () => currentTime,
      sleep: async (milliseconds) => {
        currentTime += milliseconds;
      },
      notice: (message) => notices.push(message),
    });

    expect(run.id).toBe(RUN_ID);
    expect(requests).toEqual([
      "/repos/NVIDIA/NemoClaw/actions/workflows/base-image.yaml",
      "/repos/NVIDIA/NemoClaw/actions/workflows/base-image.yaml/runs?branch=main&event=push&per_page=100&page=1",
      "/repos/NVIDIA/NemoClaw/actions/workflows/base-image.yaml/runs?branch=main&event=push&per_page=100&page=1",
      "/repos/NVIDIA/NemoClaw/actions/workflows/base-image.yaml/runs?branch=main&event=push&per_page=100&page=1",
      `/repos/NVIDIA/NemoClaw/actions/runs/${RUN_ID}/jobs?filter=all&per_page=100&page=1`,
      `/repos/NVIDIA/NemoClaw/actions/runs/${RUN_ID}`,
    ]);
    expect(notices).toHaveLength(2);
  });

  it("reports the selected publisher SHA and run URL for invalid job evidence (#7372)", async () => {
    const jobs = successfulJobs().map((job, index) =>
      index === 0 ? { ...job, run_id: RUN_ID + 1 } : job,
    );
    const responses = [
      workflowMetadata(),
      runsPayload([workflowRun()]),
      { total_count: jobs.length, jobs },
    ];

    await expect(
      waitForBaseImagePublication({
        history: history(),
        request: async () => responses.shift(),
        waitMs: 100,
        pollMs: 10,
      }),
    ).rejects.toThrow(new RegExp(`provenance does not match.*${RELEVANT_SHA}.*${RUN_URL}`, "u"));
  });

  it("times out deterministically without sleeping past its budget (#7372)", async () => {
    const responses = [workflowMetadata(), runsPayload([])];
    await expect(
      waitForBaseImagePublication({
        history: history(),
        request: async () => responses.shift(),
        waitMs: 0,
        pollMs: 10,
        now: () => 10,
        sleep: async () => {
          throw new Error("must not sleep");
        },
      }),
    ).rejects.toThrow(new RegExp(`timed out.*${RELEVANT_SHA}`, "u"));
  });

  it("retries bounded transient and rate-limited GitHub responses (#7372)", async () => {
    const transientResponses: Array<Response | Error> = [
      new Error("network unavailable"),
      new Response("unavailable", { status: 503, headers: { "retry-after": "2" } }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ];
    const transientSleeps: number[] = [];

    await expect(
      githubRequest("/repos/NVIDIA/NemoClaw/actions/workflows/base-image.yaml", "token", {
        fetchImpl: () => nextFetchResponse(transientResponses),
        sleep: async (milliseconds) => {
          transientSleeps.push(milliseconds);
        },
      }),
    ).resolves.toEqual({ ok: true });
    expect(transientSleeps).toEqual([1000, 2000]);

    const rateLimitResponses: Array<Response | Error> = [
      new Response("limited", {
        status: 403,
        headers: { "retry-after": "7", "x-ratelimit-remaining": "0" },
      }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ];
    const rateLimitSleeps: number[] = [];
    await expect(
      githubRequest("/repos/NVIDIA/NemoClaw/actions/workflows/base-image.yaml", "token", {
        attempts: 2,
        fetchImpl: () => nextFetchResponse(rateLimitResponses),
        sleep: async (milliseconds) => {
          rateLimitSleeps.push(milliseconds);
        },
      }),
    ).resolves.toEqual({ ok: true });
    expect(rateLimitSleeps).toEqual([7000]);
  });

  it("fails permanent and malformed GitHub responses without retrying (#7372)", async () => {
    let requests = 0;
    await expect(
      githubRequest("/repos/NVIDIA/NemoClaw/actions/workflows/base-image.yaml", "token", {
        fetchImpl: async () => {
          requests += 1;
          return new Response("not found", { status: 404 });
        },
        sleep: async () => {
          throw new Error("must not retry");
        },
      }),
    ).rejects.toThrow(/HTTP 404/u);
    expect(requests).toBe(1);

    await expect(
      githubRequest("/repos/NVIDIA/NemoClaw/actions/workflows/base-image.yaml", "token", {
        fetchImpl: async () => new Response("{", { status: 200 }),
      }),
    ).rejects.toThrow(/not valid JSON/u);
  });

  it("loads directly with the Node strip-types runtime used by Actions (#7372)", () => {
    const modulePath = path.resolve(
      import.meta.dirname,
      "../../../tools/e2e/base-image-publication.mts",
    );
    expect(() =>
      execFileSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--no-warnings",
          "--eval",
          `import(${JSON.stringify(modulePath)})`,
        ],
        { encoding: "utf8" },
      ),
    ).not.toThrow();
  });
});
