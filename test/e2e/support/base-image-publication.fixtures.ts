// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import type {
  FirstParentHistory,
  PublicationRun,
} from "../../../tools/e2e/base-image-publication.mts";

export const EXPECTED_SHA = "a".repeat(40);
export const DESCENDANT_SHA = "b".repeat(40);
export const RELEVANT_SHA = "c".repeat(40);
export const STALE_SHA = "d".repeat(40);
export const RUN_ID = 29891942278;
export const WORKFLOW_ID = 251475843;
export const RUN_URL_ROOT = "https://github.com/NVIDIA/NemoClaw/actions/runs";
export const RUN_URL = `https://github.com/NVIDIA/NemoClaw/actions/runs/${RUN_ID}`;
export const MANAGED_IMAGE_PROMOTION_JOB =
  "Publish complete managed images / Promote complete multi-platform managed image cohort";
export const BASE_IMAGE_WORKFLOW_SOURCE = fs.readFileSync(
  path.resolve(import.meta.dirname, "../../../.github/workflows/base-image.yaml"),
  "utf8",
);
export const WORKFLOW_SOURCE = `on:
  push:
    branches: [main]
    paths:
      - ".github/workflows/base-image.yaml"
      - "Dockerfile.base"
  workflow_dispatch:
jobs: {}
`;

export function required<T>(value: T | undefined, message: string): T {
  return (
    value ??
    (() => {
      throw new Error(message);
    })()
  );
}

export function historyGitResponse(
  args: string[],
  relevantSha: string,
  firstParentShas: string,
): string {
  const responses = new Map([
    ["rev-parse:--verify", EXPECTED_SHA],
    ["rev-parse:--is-shallow-repository", "false"],
    ["log:--first-parent", relevantSha],
    ["rev-list:--first-parent", firstParentShas],
  ]);
  return required(responses.get(`${args[0]}:${args[1]}`), "unexpected git history request");
}

export function nextFetchResponse(responses: Array<Response | Error>): Promise<Response> {
  const response = required(responses.shift(), "unexpected GitHub request");
  return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
}

export function history(): FirstParentHistory {
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

export function workflowRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RUN_ID,
    run_attempt: 1,
    workflow_id: WORKFLOW_ID,
    name: "Images / Publish Base and Managed Images",
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

export function workflowMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: WORKFLOW_ID,
    name: "Images / Publish Base and Managed Images",
    path: ".github/workflows/base-image.yaml",
    state: "active",
    html_url: "https://github.com/NVIDIA/NemoClaw/blob/main/.github/workflows/base-image.yaml",
    url: `https://api.github.com/repos/NVIDIA/NemoClaw/actions/workflows/${WORKFLOW_ID}`,
    ...overrides,
  };
}

export function runsPayload(runs: unknown[]): Record<string, unknown> {
  return { total_count: runs.length, workflow_runs: runs };
}

export function historyRunPages(runs: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...history().distanceBySha.keys()].map((headSha) =>
    runsPayload(runs.filter((run) => run.head_sha === headSha)),
  );
}

export const HISTORY_RUN_REQUESTS = [...history().distanceBySha.keys()].map(
  (headSha) =>
    `/repos/NVIDIA/NemoClaw/actions/workflows/base-image.yaml/runs?branch=main&per_page=100&head_sha=${headSha}&page=1`,
);

export function selectedRun(overrides: Partial<PublicationRun> = {}): PublicationRun {
  return {
    id: RUN_ID,
    attempt: 1,
    event: "push",
    workflowId: WORKFLOW_ID,
    headSha: RELEVANT_SHA,
    status: "completed",
    conclusion: "success",
    url: RUN_URL,
    ...overrides,
  };
}

export function publisherJob(
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

export function successfulJobs(overrides: { runAttempt?: number } = {}): Record<string, unknown>[] {
  const runAttempt = overrides.runAttempt ?? 1;
  return [
    publisherJob("Build and push OpenClaw base image", {
      id: 1,
      run_attempt: runAttempt,
    }),
    publisherJob("Build and push Hermes base image", {
      id: 2,
      run_attempt: runAttempt,
    }),
    publisherJob("Build and push Deep Agents Code base image", {
      id: 3,
      run_attempt: runAttempt,
    }),
  ];
}

export function successfulManualJobs(): Record<string, unknown>[] {
  return [...successfulJobs(), publisherJob(MANAGED_IMAGE_PROMOTION_JOB, { id: 4 })];
}

export function historyLimitRequest(unrelated: Record<string, unknown>[], requests: string[]) {
  return async (requestPath: string): Promise<unknown> => {
    requests.push(requestPath);
    const url = new URL(requestPath, "https://api.github.com");
    if (url.pathname.endsWith("/base-image.yaml")) return workflowMetadata();
    if (url.pathname.endsWith("/base-image.yaml/runs")) {
      const headSha = url.searchParams.get("head_sha");
      if (headSha) return runsPayload(headSha === RELEVANT_SHA ? [workflowRun()] : []);
      const offset = (Number(url.searchParams.get("page")) - 1) * 100;
      return {
        total_count: unrelated.length,
        workflow_runs: unrelated.slice(offset, offset + 100),
      };
    }
    if (url.pathname.endsWith("/jobs")) return { total_count: 3, jobs: successfulJobs() };
    if (url.pathname === `/repos/NVIDIA/NemoClaw/actions/runs/${RUN_ID}`) return workflowRun();
    throw new Error(`unexpected request: ${requestPath}`);
  };
}
