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

interface ExecOptions {
  input?: string;
}

type Scenario = (_command: string, rawArgs: string[], options?: ExecOptions) => string;
type RouteMatcher = (args: string, rawArgs: string[]) => boolean;

interface Route {
  matches: RouteMatcher;
  respond: (options: ExecOptions) => string;
}

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

function approvalReview(): string {
  return JSON.stringify({
    id: 91,
    state: "APPROVED",
    commit_id: HEAD,
    submitted_at: "2026-07-03T00:20:00Z",
    user: { id: 5_445, login: "cv", type: "User" },
  });
}

function includes(fragment: string): RouteMatcher {
  return (args) => args.includes(fragment);
}

function matches(pattern: RegExp): RouteMatcher {
  return (args) => pattern.test(args);
}

function graphql(_args: string, rawArgs: string[]): boolean {
  return rawArgs[0] === "api" && rawArgs[1] === "graphql";
}

function route(matchesRoute: RouteMatcher, respond: Route["respond"]): Route {
  return { matches: matchesRoute, respond };
}

function unexpectedGh(args: string): never {
  throw new Error(`Unexpected gh call: ${args}`);
}

function runRoutes(routes: Route[]): Scenario {
  return (_command, rawArgs, options = {}) => {
    const args = rawArgs.join(" ");
    return (
      routes.find((candidate) => candidate.matches(args, rawArgs))?.respond(options) ??
      unexpectedGh(args)
    );
  };
}

function parseInput<T>(options: ExecOptions): T {
  return JSON.parse(options.input ?? "{}") as T;
}

function stableHeadScenario(payloads: Array<Record<string, unknown>>): Scenario {
  return runRoutes([
    route(includes(`repos/${REPO}/pulls/${PR_NUMBER} --jq .head.sha`), () => HEAD),
    route(graphql, () => contributorQuery()),
    route(includes(`/issues/${PR_NUMBER}/comments`), () => trustedComment()),
    route(includes(`/pulls/${PR_NUMBER}/reviews`), () => approvalReview()),
    route(includes(`/collaborators/cv/permission`), () => JSON.stringify({ permission: "write" })),
    route(includes(`/commits/${HEAD}/pulls?`), () => String(PR_NUMBER)),
    route(includes(`/commits/${HEAD}/check-runs?`), () => JSON.stringify({ check_runs: [] })),
    route(matches(/--method POST .*\/check-runs/u), (options) => {
      payloads.push(parseInput(options));
      return JSON.stringify({ id: 700 });
    }),
    route(includes("--method PATCH repos/NVIDIA/NemoClaw/check-runs/700"), (options) => {
      payloads.push(parseInput(options));
      return JSON.stringify({ id: 700 });
    }),
  ]);
}

function changingHeadScenario(conclusions: string[]): Scenario {
  const headShas = [HEAD, PRIOR_HEAD];
  return runRoutes([
    route(
      includes(`repos/${REPO}/pulls/${PR_NUMBER} --jq .head.sha`),
      () => headShas.shift() ?? "",
    ),
    route(graphql, () => contributorQuery()),
    route(includes(`/issues/${PR_NUMBER}/comments`), () => trustedComment()),
    route(includes(`/pulls/${PR_NUMBER}/reviews`), () => ""),
    route(includes(`/commits/${HEAD}/pulls?`), () => String(PR_NUMBER)),
    route(includes(`/commits/${HEAD}/check-runs?`), () => JSON.stringify({ check_runs: [] })),
    route(matches(/--method POST .*\/check-runs/u), () => JSON.stringify({ id: 701 })),
    route(includes("--method PATCH repos/NVIDIA/NemoClaw/check-runs/701"), (options) => {
      conclusions.push(parseInput<{ conclusion: string }>(options).conclusion);
      return JSON.stringify({ id: 701 });
    }),
  ]);
}

function sharedHeadScenario(conclusion: { value: string }): Scenario {
  const secondObservation: ContributorObservation = {
    ...observation(),
    prNumber: 43,
    eventId: "43001",
  };
  return runRoutes([
    route(matches(/repos\/NVIDIA\/NemoClaw\/pulls\/(42|43) --jq \.head\.sha/u), () => HEAD),
    route(graphql, () => contributorQuery()),
    route(includes("/issues/42/comments"), () => trustedComment()),
    route(includes("/issues/43/comments"), () =>
      trustedComment(renderObservationComment(secondObservation)),
    ),
    route(includes("/pulls/42/reviews"), () => approvalReview()),
    route(includes("/pulls/43/reviews"), () => ""),
    route(includes("/collaborators/cv/permission"), () => JSON.stringify({ permission: "write" })),
    route(includes(`/commits/${HEAD}/pulls?`), () => "42\n43"),
    route(includes(`/commits/${HEAD}/check-runs?`), () => JSON.stringify({ check_runs: [] })),
    route(matches(/--method POST .*\/check-runs/u), () => JSON.stringify({ id: 702 })),
    route(includes("--method PATCH repos/NVIDIA/NemoClaw/check-runs/702"), (options) => {
      conclusion.value = parseInput<{ conclusion: string }>(options).conclusion;
      return JSON.stringify({ id: 702 });
    }),
  ]);
}

function delayedSynchronizeScenario(): Scenario {
  return runRoutes([
    route(graphql, () => contributorQuery(HEAD)),
    route(includes(`--method POST repos/${REPO}/issues/${PR_NUMBER}/comments`), () =>
      JSON.stringify({ id: 900 }),
    ),
    route(includes(`/issues/${PR_NUMBER}/comments`), () => ""),
  ]);
}

function editedLedgerScenario(): Scenario {
  return () =>
    JSON.stringify({
      body: "<!-- nemoclaw-independent-approval-ledger:v1\n{}\n-->",
      created_at: "2026-07-03T00:15:00Z",
      updated_at: "2026-07-03T00:16:00Z",
      user: { id: 41_898_282, login: "github-actions[bot]", type: "Bot" },
    });
}

describe("independent approval GitHub adapter", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  it("publishes only success or failure on the exact stable PR head (#6222)", () => {
    const payloads: Array<Record<string, unknown>> = [];
    execFileSyncMock.mockImplementation(stableHeadScenario(payloads));

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
    expect(execFileSyncMock).toHaveBeenCalledTimes(10);
  });

  it("fails the published check when the head changes during evaluation (#6222)", () => {
    const conclusions: string[] = [];
    execFileSyncMock.mockImplementation(changingHeadScenario(conclusions));

    expect(() => publishPullRequestCheck(REPO, PR_NUMBER)).toThrow(/head changed/u);
    expect(conclusions).toEqual(["failure"]);
    expect(execFileSyncMock).toHaveBeenCalledTimes(9);
  });

  it("fails a shared-SHA check unless every associated open PR passes (#6222)", () => {
    const conclusion = { value: "" };
    execFileSyncMock.mockImplementation(sharedHeadScenario(conclusion));

    const published = publishPullRequestCheck(REPO, PR_NUMBER);

    expect(published.result.pass).toBe(true);
    expect(published.checkPass).toBe(false);
    expect(published.evaluatedPullRequests).toEqual([42, 43]);
    expect(conclusion.value).toBe("failure");
    expect(execFileSyncMock).toHaveBeenCalledTimes(14);
  });

  it("preserves a delayed synchronize actor without marking the live head observed (#6222)", () => {
    execFileSyncMock.mockImplementation(delayedSynchronizeScenario());

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
    expect(execFileSyncMock).toHaveBeenCalledTimes(3);
  });

  it("fails closed for malformed or edited trusted ledger comments (#6222)", () => {
    execFileSyncMock.mockImplementation(editedLedgerScenario());

    expect(() => fetchObservations(REPO, PR_NUMBER)).toThrow(/edited or has invalid dates/u);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });
});
