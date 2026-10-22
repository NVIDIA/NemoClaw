// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  collectPublicationRuns,
  type FirstParentHistory,
  selectPublicationRun,
} from "../../../tools/e2e/base-image-publication.mts";

const SHAS = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
const BASE_PATH = "/runs?branch=main&per_page=100";
const WORKFLOW_ID = 251475843;
const RUN = {
  id: 29891942278,
  run_attempt: 1,
  workflow_id: WORKFLOW_ID,
  name: "Images / Publish Base and Managed Images",
  event: "push",
  status: "completed",
  conclusion: "success",
  head_sha: SHAS[2],
  head_branch: "main",
  path: ".github/workflows/base-image.yaml",
  repository: { full_name: "NVIDIA/NemoClaw" },
  head_repository: { full_name: "NVIDIA/NemoClaw" },
  html_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/29891942278",
};

function history(): FirstParentHistory {
  return {
    expectedSha: SHAS[0]!,
    relevantSha: SHAS[2]!,
    relevantDistance: 2,
    distanceBySha: new Map(SHAS.map((sha, distance) => [sha, distance])),
  };
}

function unstableGlobalPage(requestPath: string): Record<string, unknown> {
  return requestPath.endsWith("page=1")
    ? {
        total_count: 101,
        workflow_runs: Array.from({ length: 100 }, (_, id) => ({ id: id + 1 })),
      }
    : { total_count: 102, workflow_runs: [] };
}

describe("unstable publication-run pagination", () => {
  it("uses exact first-parent SHA queries when the global run count keeps changing", async () => {
    const requests: string[] = [];
    const result = await collectPublicationRuns(
      async (requestPath) => {
        requests.push(requestPath);
        return requestPath.includes("head_sha=")
          ? {
              total_count: Number(requestPath.includes(`head_sha=${SHAS[2]}`)),
              workflow_runs: requestPath.includes(`head_sha=${SHAS[2]}`) ? [RUN] : [],
            }
          : unstableGlobalPage(requestPath);
      },
      BASE_PATH,
      history(),
    );

    expect(requests.filter((requestPath) => !requestPath.includes("head_sha="))).toHaveLength(6);
    expect(requests.filter((requestPath) => requestPath.includes("head_sha="))).toEqual(
      SHAS.map((sha) => `${BASE_PATH}&head_sha=${sha}&page=1`),
    );
    expect(selectPublicationRun(result, history(), WORKFLOW_ID)).toMatchObject({
      state: "selected",
      run: { id: RUN.id, headSha: SHAS[2] },
    });
  });

  it("rejects a run returned for a different SHA after the unstable-count fallback", async () => {
    await expect(
      collectPublicationRuns(
        async (requestPath) =>
          requestPath.includes("head_sha=")
            ? { total_count: 1, workflow_runs: [RUN] }
            : unstableGlobalPage(requestPath),
        BASE_PATH,
        history(),
      ),
    ).rejects.toThrow(/queried head SHA/u);
  });
});
