// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));

vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));

import {
  fetchObservations,
  publishPullRequestCheck,
  recordObservation,
} from "../tools/independent-approval/github.mts";
import {
  type ContributorObservation,
  renderObservationComment,
} from "../tools/independent-approval/policy.mts";

const REPO = "NVIDIA/NemoClaw";
const PR_NUMBER = 42;
const HEAD = "4d52e7adb2b37409da02f29d046fbe546855f37b";
const PRIOR_HEAD = "f25bac9555ea598825f3df140cef93be96e0b0cb";

function contributorQuery(headSha = HEAD) {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          author: { __typename: "User", login: "laitingsheng", databaseId: 6_479_328 },
          headRefOid: headSha,
          commits: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                commit: {
                  authors: {
                    pageInfo: { hasNextPage: false },
                    nodes: [
                      {
                        user: {
                          __typename: "User",
                          login: "laitingsheng",
                          databaseId: 6_479_328,
                        },
                      },
                    ],
                  },
                  committer: {
                    user: {
                      __typename: "User",
                      login: "laitingsheng",
                      databaseId: 6_479_328,
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  });
}

function observation(): ContributorObservation {
  return {
    version: 1,
    prNumber: PR_NUMBER,
    headSha: HEAD,
    beforeSha: PRIOR_HEAD,
    eventId: "42001",
    observedAt: "2026-07-03T00:15:00Z",
    eventAction: "synchronize",
    contributors: [
      {
        id: 6_479_328,
        login: "laitingsheng",
        type: "User",
        reasons: ["commit_author", "commit_committer", "pr_opener"],
      },
    ],
  };
}

function trustedComment(body = renderObservationComment(observation())): string {
  return JSON.stringify({
    body,
    created_at: "2026-07-03T00:15:00Z",
    updated_at: "2026-07-03T00:15:00Z",
    user: { id: 41_898_282, login: "github-actions[bot]", type: "Bot" },
  });
}

describe("independent approval GitHub adapter", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  it("publishes only success or failure on the exact stable PR head (#6222)", () => {
    const payloads: Array<Record<string, unknown>> = [];
    execFileSyncMock.mockImplementation(
      (_command: string, rawArgs: string[], options: { input?: string }) => {
        const args = rawArgs.join(" ");
        if (args.includes(`repos/${REPO}/pulls/${PR_NUMBER} --jq .head.sha`)) return HEAD;
        if (rawArgs[0] === "api" && rawArgs[1] === "graphql") return contributorQuery();
        if (args.includes(`/issues/${PR_NUMBER}/comments`)) return trustedComment();
        if (args.includes(`/pulls/${PR_NUMBER}/reviews`)) {
          return JSON.stringify({
            id: 91,
            state: "APPROVED",
            commit_id: HEAD,
            submitted_at: "2026-07-03T00:20:00Z",
            user: { id: 5_445, login: "cv", type: "User" },
          });
        }
        if (args.includes(`/collaborators/cv/permission`))
          return JSON.stringify({ permission: "write" });
        if (args.includes(`/commits/${HEAD}/pulls?`)) return String(PR_NUMBER);
        if (args.includes(`/commits/${HEAD}/check-runs?`)) {
          return JSON.stringify({ check_runs: [] });
        }
        if (args.includes("--method POST") && args.includes("/check-runs")) {
          payloads.push(JSON.parse(options.input ?? "{}") as Record<string, unknown>);
          return JSON.stringify({ id: 700 });
        }
        if (args.includes("--method PATCH") && args.includes("/check-runs/700")) {
          payloads.push(JSON.parse(options.input ?? "{}") as Record<string, unknown>);
          return JSON.stringify({ id: 700 });
        }
        throw new Error(`Unexpected gh call: ${args}`);
      },
    );

    const evaluation = publishPullRequestCheck(REPO, PR_NUMBER);

    expect(evaluation.result.pass).toBe(true);
    expect(payloads[0]).toMatchObject({
      name: "independent-human-approval",
      head_sha: HEAD,
      status: "in_progress",
    });
    expect(payloads[1]).toMatchObject({ status: "completed", conclusion: "success" });
    expect(payloads.flatMap((payload) => Object.values(payload))).not.toContain("neutral");
    expect(payloads.flatMap((payload) => Object.values(payload))).not.toContain("skipped");
  });

  it("fails the published check when the head changes during evaluation (#6222)", () => {
    let headReads = 0;
    const conclusions: string[] = [];
    execFileSyncMock.mockImplementation(
      (_command: string, rawArgs: string[], options: { input?: string }) => {
        const args = rawArgs.join(" ");
        if (args.includes(`repos/${REPO}/pulls/${PR_NUMBER} --jq .head.sha`)) {
          headReads += 1;
          return headReads === 1 ? HEAD : PRIOR_HEAD;
        }
        if (rawArgs[0] === "api" && rawArgs[1] === "graphql") return contributorQuery();
        if (args.includes(`/issues/${PR_NUMBER}/comments`)) return trustedComment();
        if (args.includes(`/pulls/${PR_NUMBER}/reviews`)) return "";
        if (args.includes(`/commits/${HEAD}/pulls?`)) return String(PR_NUMBER);
        if (args.includes(`/commits/${HEAD}/check-runs?`))
          return JSON.stringify({ check_runs: [] });
        if (args.includes("--method POST") && args.includes("/check-runs")) {
          return JSON.stringify({ id: 701 });
        }
        if (args.includes("--method PATCH") && args.includes("/check-runs/701")) {
          const payload = JSON.parse(options.input ?? "{}") as { conclusion?: string };
          if (payload.conclusion) conclusions.push(payload.conclusion);
          return JSON.stringify({ id: 701 });
        }
        throw new Error(`Unexpected gh call: ${args}`);
      },
    );

    expect(() => publishPullRequestCheck(REPO, PR_NUMBER)).toThrow(/head changed/u);
    expect(conclusions).toEqual(["failure"]);
  });

  it("fails a shared-SHA check unless every associated open PR passes (#6222)", () => {
    let conclusion = "";
    const secondObservation: ContributorObservation = {
      ...observation(),
      prNumber: 43,
      eventId: "43001",
    };
    execFileSyncMock.mockImplementation(
      (_command: string, rawArgs: string[], options: { input?: string }) => {
        const args = rawArgs.join(" ");
        if (/repos\/NVIDIA\/NemoClaw\/pulls\/(42|43) --jq \.head\.sha/u.test(args)) return HEAD;
        if (rawArgs[0] === "api" && rawArgs[1] === "graphql") return contributorQuery();
        if (args.includes("/issues/42/comments")) return trustedComment();
        if (args.includes("/issues/43/comments")) {
          return trustedComment(renderObservationComment(secondObservation));
        }
        if (args.includes("/pulls/42/reviews")) {
          return JSON.stringify({
            id: 91,
            state: "APPROVED",
            commit_id: HEAD,
            submitted_at: "2026-07-03T00:20:00Z",
            user: { id: 5_445, login: "cv", type: "User" },
          });
        }
        if (args.includes("/pulls/43/reviews")) return "";
        if (args.includes("/collaborators/cv/permission")) {
          return JSON.stringify({ permission: "write" });
        }
        if (args.includes(`/commits/${HEAD}/pulls?`)) return "42\n43";
        if (args.includes(`/commits/${HEAD}/check-runs?`))
          return JSON.stringify({ check_runs: [] });
        if (args.includes("--method POST") && args.includes("/check-runs")) {
          return JSON.stringify({ id: 702 });
        }
        if (args.includes("--method PATCH") && args.includes("/check-runs/702")) {
          const payload = JSON.parse(options.input ?? "{}") as { conclusion?: string };
          conclusion = payload.conclusion ?? conclusion;
          return JSON.stringify({ id: 702 });
        }
        throw new Error(`Unexpected gh call: ${args}`);
      },
    );

    const published = publishPullRequestCheck(REPO, PR_NUMBER);

    expect(published.result.pass).toBe(true);
    expect(published.checkPass).toBe(false);
    expect(published.evaluatedPullRequests).toEqual([42, 43]);
    expect(conclusion).toBe("failure");
  });

  it("preserves a delayed synchronize actor without marking the live head observed (#6222)", () => {
    execFileSyncMock.mockImplementation((_command: string, rawArgs: string[]) => {
      if (rawArgs[0] === "api" && rawArgs[1] === "graphql") return contributorQuery(HEAD);
      const args = rawArgs.join(" ");
      if (args.includes("--method POST") && args.includes(`/issues/${PR_NUMBER}/comments`)) {
        return JSON.stringify({ id: 900 });
      }
      if (args.includes(`/issues/${PR_NUMBER}/comments`)) return "";
      throw new Error(`Unexpected gh call: ${rawArgs.join(" ")}`);
    });

    const recorded = recordObservation({
      repo: REPO,
      prNumber: PR_NUMBER,
      eventAction: "synchronize",
      eventId: "42002",
      expectedHeadSha: PRIOR_HEAD,
      beforeSha: HEAD,
      eventActor: { id: 36_614, login: "apurvvkumaria", type: "User" },
    });

    expect(recorded.headSha).toBe(PRIOR_HEAD);
    expect(recorded.contributors).toContainEqual({
      id: 36_614,
      login: "apurvvkumaria",
      type: "User",
      reasons: ["push_actor"],
    });
  });

  it("fails closed for malformed or edited trusted ledger comments (#6222)", () => {
    execFileSyncMock.mockReturnValue(
      JSON.stringify({
        body: "<!-- nemoclaw-independent-approval-ledger:v1\n{}\n-->",
        created_at: "2026-07-03T00:15:00Z",
        updated_at: "2026-07-03T00:16:00Z",
        user: { id: 41_898_282, login: "github-actions[bot]", type: "Bot" },
      }),
    );

    expect(() => fetchObservations(REPO, PR_NUMBER)).toThrow(/edited or has invalid dates/u);
  });
});
