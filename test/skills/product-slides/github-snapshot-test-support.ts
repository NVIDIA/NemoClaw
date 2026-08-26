// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const DEFAULT_BRANCH_COMMIT = "a".repeat(40);
const RELEASE_COMMIT = "b".repeat(40);
const PAGE_INFO = { hasNextPage: false, endCursor: null };

export const UNMILESTONED_EPIC_NUMBER = 9816;
export const UNMILESTONED_EPIC_BODY = [
  "## Outcome",
  "",
  "Qualify one external gateway workflow.",
  "",
  "## Work Tracking",
  "",
  "- #9817",
].join("\n");

export type FakeGitHubCall =
  | {
      kind: "graphql";
      operation: string;
      query: string;
      variables: Record<string, unknown>;
    }
  | { kind: "rest"; path: string };

type ExecOptions = { input?: unknown };

type ReadOnlyGitHubFixtureOptions = {
  milestoneIssues?: Array<Record<string, unknown>>;
};

function graphqlOperation(query: string): string {
  const match = /\bquery\s+([A-Za-z][A-Za-z0-9]*)/u.exec(query);
  if (!match) throw new Error("Fixture received a GraphQL document without a named query");
  return match[1];
}

function repositoryConnection(nodes: unknown[]): Record<string, unknown> {
  return { nodes, pageInfo: PAGE_INFO, totalCount: nodes.length };
}

function graphqlData(
  operation: string,
  variables: Record<string, unknown>,
  options: ReadOnlyGitHubFixtureOptions,
): unknown {
  if (variables.cursor !== null && variables.cursor !== undefined) {
    throw new Error(`${operation} requested an unexpected additional fixture page`);
  }
  if (operation === "RepositoryAndMilestones") {
    return {
      repository: {
        id: "REPOSITORY_NEMOCLAW",
        nameWithOwner: "NVIDIA/NemoClaw",
        url: "https://github.com/NVIDIA/NemoClaw",
        stargazerCount: 1,
        forkCount: 1,
        defaultBranchRef: {
          name: "main",
          target: {
            oid: DEFAULT_BRANCH_COMMIT,
            committedDate: "2026-08-24T10:00:00.000Z",
          },
        },
        pullRequests: { totalCount: 0 },
        milestones: repositoryConnection([
          {
            id: "MILESTONE_Q3",
            number: 3,
            title: "Roadmap: Q3",
            description: null,
            dueOn: "2026-09-30T00:00:00.000Z",
            state: "OPEN",
            closedAt: null,
            url: "https://github.com/NVIDIA/NemoClaw/milestone/3",
          },
        ]),
      },
    };
  }
  if (operation === "RepositoryOpenIssues") {
    return {
      repository: {
        issues: repositoryConnection([
          {
            id: "EPIC_9816",
            number: UNMILESTONED_EPIC_NUMBER,
            title: "Kubernetes in-cluster delivery",
            body: UNMILESTONED_EPIC_BODY,
            state: "OPEN",
            url: "https://github.com/NVIDIA/NemoClaw/issues/9816",
            createdAt: "2026-08-01T00:00:00.000Z",
            closedAt: null,
            issueType: { id: "ISSUE_TYPE_EPIC", name: "Epic" },
            milestone: null,
          },
        ]),
      },
    };
  }
  if (operation === "MilestoneIssues") {
    if (variables.number !== 3) throw new Error("Fixture received an unknown milestone number");
    return {
      repository: {
        milestone: { issues: repositoryConnection(options.milestoneIssues ?? []) },
      },
    };
  }
  if (operation === "IssueSubIssues") {
    const issueNumber = Number(variables.number);
    const isConfiguredMilestoneIssue = (options.milestoneIssues ?? []).some(
      (issue) => issue.number === issueNumber,
    );
    if (issueNumber !== UNMILESTONED_EPIC_NUMBER && !isConfiguredMilestoneIssue) {
      throw new Error("Fixture received an unknown Epic subissue request");
    }
    return {
      repository: {
        issue: {
          subIssues: repositoryConnection(
            issueNumber === UNMILESTONED_EPIC_NUMBER
              ? [
                  {
                    id: "ISSUE_9818",
                    number: 9818,
                    state: "CLOSED",
                    url: "https://github.com/NVIDIA/NemoClaw/issues/9818",
                  },
                ]
              : [],
          ),
        },
      },
    };
  }
  if (operation === "TrackedIssue") {
    if (variables.number !== 9817) throw new Error("Fixture received an unknown tracked issue");
    return {
      repository: {
        issueOrPullRequest: {
          __typename: "Issue",
          id: "ISSUE_9817",
          number: 9817,
          state: "OPEN",
          url: "https://github.com/NVIDIA/NemoClaw/issues/9817",
        },
      },
    };
  }
  if (operation === "TagRefs") {
    return {
      repository: {
        refs: repositoryConnection([
          {
            id: "TAG_V1_0_0",
            name: "v1.0.0",
            target: {
              __typename: "Commit",
              oid: RELEASE_COMMIT,
              committedDate: "2026-08-24T09:00:00.000Z",
              url: "https://github.com/NVIDIA/NemoClaw/commit/release",
            },
          },
        ]),
      },
    };
  }
  if (operation === "DiscussionCategories") {
    return {
      repository: {
        discussionCategories: repositoryConnection([
          { id: "CATEGORY_ANNOUNCEMENTS", name: "Announcements", slug: "announcements" },
        ]),
      },
    };
  }
  if (operation === "Announcements") {
    if (variables.categoryId !== "CATEGORY_ANNOUNCEMENTS") {
      throw new Error("Fixture received an unknown discussion category");
    }
    return {
      repository: {
        discussions: repositoryConnection([
          {
            id: "DISCUSSION_RELEASE",
            number: 100,
            title: "NemoClaw v1.0.0 is out",
            body: "v1.0.0 delivers the fixture release.",
            url: "https://github.com/NVIDIA/NemoClaw/discussions/100",
            createdAt: "2026-08-24T09:30:00.000Z",
            updatedAt: "2026-08-24T09:30:00.000Z",
          },
        ]),
      },
    };
  }
  if (operation === "Stargazers") {
    return {
      repository: {
        stargazers: {
          edges: [{ starredAt: "2026-08-24T08:00:00.000Z", node: { id: "USER_1" } }],
          pageInfo: PAGE_INFO,
          totalCount: 1,
        },
      },
    };
  }
  if (operation === "Forks") {
    return {
      repository: {
        forks: repositoryConnection([{ id: "FORK_1", createdAt: "2026-08-24T08:30:00.000Z" }]),
      },
    };
  }
  if (operation === "SearchWindow") {
    return { search: { issueCount: 0, nodes: [], pageInfo: PAGE_INFO } };
  }
  throw new Error(`Fixture received unknown GraphQL operation ${operation}`);
}

export function createReadOnlyGitHubExecutor(fixture: ReadOnlyGitHubFixtureOptions = {}): {
  calls: FakeGitHubCall[];
  execFileSync: (command: string, args?: readonly string[], options?: ExecOptions) => string;
} {
  const calls: FakeGitHubCall[] = [];
  return {
    calls,
    execFileSync: (command, args = [], execOptions = {}) => {
      if (command !== "gh" || args[0] !== "api") {
        throw new Error(
          `Fixture permits only read-only gh api calls, received ${command} ${args.join(" ")}`,
        );
      }
      if (args[1] !== "graphql") {
        const apiPath = args[1];
        if (!apiPath) throw new Error("Fixture received a REST request without a path");
        calls.push({ kind: "rest", path: apiPath });
        if (apiPath === "user") return JSON.stringify({ login: "fixture-viewer" });
        if (
          apiPath === `repos/NVIDIA/NemoClaw/compare/${RELEASE_COMMIT}...${DEFAULT_BRANCH_COMMIT}`
        ) {
          return JSON.stringify({ status: "ahead" });
        }
        throw new Error(`Fixture received unknown REST path ${apiPath}`);
      }
      if (args.join(" ") !== "api graphql --input -") {
        throw new Error(`Fixture received unsupported gh api arguments: ${args.join(" ")}`);
      }
      const payload = JSON.parse(String(execOptions.input ?? "")) as {
        query: string;
        variables: Record<string, unknown>;
      };
      const operation = graphqlOperation(payload.query);
      calls.push({
        kind: "graphql",
        operation,
        query: payload.query,
        variables: payload.variables,
      });
      return JSON.stringify({ data: graphqlData(operation, payload.variables, fixture) });
    },
  };
}
