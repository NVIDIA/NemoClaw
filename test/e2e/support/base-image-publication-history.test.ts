// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  resolveFirstParentHistory,
  selectPublicationRun,
} from "../../../tools/e2e/base-image-publication.mts";

const EXPECTED_SHA = "a".repeat(40);
const DESCENDANT_SHA = "b".repeat(40);
const RELEVANT_SHA = "c".repeat(40);
const STALE_SHA = "d".repeat(40);
const WORKFLOW_ID = 251475843;
const RUN_URL_ROOT = "https://github.com/NVIDIA/NemoClaw/actions/runs";

function required<T>(value: T | undefined): T {
  return (
    value ??
    (() => {
      throw new Error("unexpected Git history request");
    })()
  );
}

function historyResponse(args: string[], checkedOutSha: string, firstParentShas: string): string {
  const responses = new Map([
    ["rev-parse:--verify", checkedOutSha],
    ["rev-parse:--is-shallow-repository", "false"],
    ["log:--first-parent", RELEVANT_SHA],
    ["rev-list:--first-parent", firstParentShas],
  ]);
  return required(responses.get(`${args[0]}:${args[1]}`));
}

function publicationRun(id: number, headSha: string): Record<string, unknown> {
  return {
    id,
    run_attempt: 1,
    workflow_id: WORKFLOW_ID,
    name: "Images / Publish Base and Managed Images",
    event: "push",
    status: "completed",
    conclusion: "success",
    head_sha: headSha,
    head_branch: "main",
    path: ".github/workflows/base-image.yaml",
    repository: { full_name: "NVIDIA/NemoClaw" },
    head_repository: { full_name: "NVIDIA/NemoClaw" },
    html_url: `${RUN_URL_ROOT}/${id}`,
  };
}

function runsPayload(runs: unknown[]): Record<string, unknown> {
  return { total_count: runs.length, workflow_runs: runs };
}

describe("base-image publication first-parent history", () => {
  it("binds the applicable commit to the checked-out first-parent chain (#7372)", () => {
    const calls: string[][] = [];
    const resolved = resolveFirstParentHistory(EXPECTED_SHA, ["Dockerfile.base"], (args) => {
      calls.push(args);
      return historyResponse(
        args,
        EXPECTED_SHA,
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

  it("accepts a later trusted publication for an older PR base", () => {
    const calls: string[][] = [];
    const resolved = resolveFirstParentHistory(
      EXPECTED_SHA,
      ["Dockerfile.base"],
      (args) => {
        calls.push(args);
        return historyResponse(
          args,
          DESCENDANT_SHA,
          `${DESCENDANT_SHA}\n${EXPECTED_SHA}\n${RELEVANT_SHA}\n${STALE_SHA}`,
        );
      },
      { allowCheckedOutDescendant: true },
    );

    expect([...resolved.distanceBySha]).toEqual([
      [DESCENDANT_SHA, 0],
      [EXPECTED_SHA, 1],
      [RELEVANT_SHA, 2],
    ]);
    expect(calls[3]).toEqual(["rev-list", "--first-parent", DESCENDANT_SHA]);
  });

  it("passes later trusted history directly into publication selection", () => {
    const resolved = resolveFirstParentHistory(
      EXPECTED_SHA,
      ["Dockerfile.base"],
      (args) =>
        historyResponse(
          args,
          DESCENDANT_SHA,
          `${DESCENDANT_SHA}\n${EXPECTED_SHA}\n${RELEVANT_SHA}\n${STALE_SHA}`,
        ),
      { allowCheckedOutDescendant: true },
    );
    const descendantRun = publicationRun(101, DESCENDANT_SHA);
    const staleRun = publicationRun(100, STALE_SHA);

    expect(
      selectPublicationRun(runsPayload([staleRun, descendantRun]), resolved, WORKFLOW_ID, {
        completedSuccessOnly: true,
      }),
    ).toMatchObject({ state: "selected", run: { id: 101, headSha: DESCENDANT_SHA } });
    expect(
      selectPublicationRun(runsPayload([staleRun]), resolved, WORKFLOW_ID, {
        completedSuccessOnly: true,
      }),
    ).toEqual({ state: "missing" });
  });

  it("rejects an older PR base outside the checked-out first-parent history", () => {
    expect(() =>
      resolveFirstParentHistory(
        EXPECTED_SHA,
        ["Dockerfile.base"],
        (args) => historyResponse(args, DESCENDANT_SHA, `${DESCENDANT_SHA}\n${RELEVANT_SHA}`),
        { allowCheckedOutDescendant: true },
      ),
    ).toThrow(/expected SHA is not on the checked-out first-parent history/u);
  });
});
