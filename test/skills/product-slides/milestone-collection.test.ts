// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createReadOnlyGitHubExecutor } from "./github-snapshot-test-support";

const CLOSED_EPIC_NUMBER = 9800;
const CLOSED_AT = "2026-08-20T18:30:00.000Z";

describe("milestone Epic collection", () => {
  it("requests open and closed issues and retains exact closed-Epic lifecycle evidence", async () => {
    const github = createReadOnlyGitHubExecutor({
      milestoneIssues: [
        {
          id: "EPIC_9800",
          number: CLOSED_EPIC_NUMBER,
          title: "Completed onboarding flow",
          body: "## Outcome\n\nShip the completed onboarding flow.",
          state: "CLOSED",
          url: `https://github.com/NVIDIA/NemoClaw/issues/${String(CLOSED_EPIC_NUMBER)}`,
          createdAt: "2026-08-01T00:00:00.000Z",
          closedAt: CLOSED_AT,
          issueType: { id: "ISSUE_TYPE_EPIC", name: "Epic" },
          subIssues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
            totalCount: 0,
          },
        },
      ],
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T12:00:00.000Z"));
    vi.resetModules();
    vi.doMock("node:child_process", async () => {
      const actual =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, execFileSync: github.execFileSync };
    });

    try {
      const { collectGitHubSnapshot } =
        await import("../../../.agents/skills/nemoclaw-maintainer-product-slides/scripts/collect-github-snapshot.mts");
      const snapshot = collectGitHubSnapshot({
        repo: "NVIDIA/NemoClaw",
        milestones: ["Roadmap: Q3"],
        releaseCount: 1,
        metricMode: "retained_additions",
      });
      const milestoneRequest = github.calls.find(
        (call) => call.kind === "graphql" && call.operation === "MilestoneIssues",
      );
      const closedEpic = (snapshot.epics as Array<Record<string, unknown>>).find(
        (epic) => epic.issueNumber === CLOSED_EPIC_NUMBER,
      );

      expect(milestoneRequest).toMatchObject({
        kind: "graphql",
        operation: "MilestoneIssues",
        variables: { number: 3 },
      });
      expect(milestoneRequest?.kind === "graphql" ? milestoneRequest.query : "").toMatch(
        /issues\([^)]*states:\s*\[OPEN,\s*CLOSED\][^)]*\)/u,
      );
      expect(closedEpic).toMatchObject({
        nodeId: "EPIC_9800",
        issueNumber: CLOSED_EPIC_NUMBER,
        milestoneNodeId: "MILESTONE_Q3",
        state: "CLOSED",
        closedAt: CLOSED_AT,
      });
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
      vi.useRealTimers();
    }
  });
});
