// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  collectPublicationRuns,
  type FirstParentHistory,
} from "../../../tools/e2e/base-image-publication.mts";

const EXPECTED_SHA = "a".repeat(40);
const DESCENDANT_SHA = "b".repeat(40);
const RELEVANT_SHA = "c".repeat(40);
const BASE_PATH =
  "/repos/NVIDIA/NemoClaw/actions/workflows/base-image.yaml/runs?branch=main&per_page=100";

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

function cappedHistoryResponses(): Map<string, unknown> {
  const entries = Array.from({ length: 1_001 }, (_, index) => ({ id: index + 1 }));
  return new Map(
    Array.from({ length: 10 }, (_, index) => [
      `${BASE_PATH}&page=${index + 1}`,
      {
        total_count: entries.length,
        workflow_runs: entries.slice(index * 100, (index + 1) * 100),
      },
    ]),
  );
}

function unstableGlobalPage(path: string): Record<string, unknown> {
  return path.endsWith("page=1")
    ? {
        total_count: 101,
        workflow_runs: Array.from({ length: 100 }, (_, id) => ({ id: id + 1 })),
      }
    : { total_count: 102, workflow_runs: [] };
}

function exactHeadPath(headSha: string): string {
  return `${BASE_PATH}&head_sha=${headSha}&page=1`;
}

function requiredResponse(responses: ReadonlyMap<string, unknown>, path: string): unknown {
  return (
    responses.get(path) ??
    (() => {
      throw new Error(`unexpected GitHub request: ${path}`);
    })()
  );
}

describe("base-image publication pagination", () => {
  it("queries eligible commits directly when workflow history exceeds 1,000 runs", async () => {
    const selectedRun = { id: 2_001, head_sha: RELEVANT_SHA };
    const responses = cappedHistoryResponses();
    responses.set(exactHeadPath(EXPECTED_SHA), { total_count: 0, workflow_runs: [] });
    responses.set(exactHeadPath(DESCENDANT_SHA), { total_count: 0, workflow_runs: [] });
    responses.set(exactHeadPath(RELEVANT_SHA), {
      total_count: 1,
      workflow_runs: [selectedRun],
    });
    const requests: string[] = [];

    await expect(
      collectPublicationRuns(
        async (path) => {
          requests.push(path);
          return requiredResponse(responses, path);
        },
        BASE_PATH,
        history(),
      ),
    ).resolves.toEqual({ total_count: 1, workflow_runs: [selectedRun] });
    expect(requests).toEqual([
      ...Array.from({ length: 10 }, (_, index) => `${BASE_PATH}&page=${index + 1}`),
      exactHeadPath(EXPECTED_SHA),
      exactHeadPath(DESCENDANT_SHA),
      exactHeadPath(RELEVANT_SHA),
    ]);
  });

  it("rejects a workflow run that does not match the queried commit", async () => {
    const responses = cappedHistoryResponses();
    responses.set(exactHeadPath(EXPECTED_SHA), {
      total_count: 1,
      workflow_runs: [{ id: 2_001, head_sha: DESCENDANT_SHA }],
    });

    await expect(
      collectPublicationRuns(
        async (path) => requiredResponse(responses, path),
        BASE_PATH,
        history(),
      ),
    ).rejects.toThrow(/queried head SHA must be a{40}/u);
  });

  it("queries eligible commits when the global run count keeps changing", async () => {
    const selectedRun = { id: 2_001, head_sha: RELEVANT_SHA };
    const requests: string[] = [];
    const responses = new Map<string, unknown>([
      [exactHeadPath(EXPECTED_SHA), { total_count: 0, workflow_runs: [] }],
      [exactHeadPath(DESCENDANT_SHA), { total_count: 0, workflow_runs: [] }],
      [exactHeadPath(RELEVANT_SHA), { total_count: 1, workflow_runs: [selectedRun] }],
    ]);

    await expect(
      collectPublicationRuns(
        async (path) => {
          requests.push(path);
          return path.includes("&head_sha=")
            ? requiredResponse(responses, path)
            : unstableGlobalPage(path);
        },
        BASE_PATH,
        history(),
      ),
    ).resolves.toEqual({ total_count: 1, workflow_runs: [selectedRun] });
    expect(requests).toEqual([
      ...Array.from({ length: 3 }, () => [`${BASE_PATH}&page=1`, `${BASE_PATH}&page=2`]).flat(),
      exactHeadPath(EXPECTED_SHA),
      exactHeadPath(DESCENDANT_SHA),
      exactHeadPath(RELEVANT_SHA),
    ]);
  });

  it("rejects a mismatched SHA after unstable global pagination", async () => {
    await expect(
      collectPublicationRuns(
        async (path) =>
          path.includes("&head_sha=")
            ? { total_count: 1, workflow_runs: [{ id: 2_001, head_sha: RELEVANT_SHA }] }
            : unstableGlobalPage(path),
        BASE_PATH,
        history(),
      ),
    ).rejects.toThrow(/queried head SHA must be a{40}/u);
  });
});
