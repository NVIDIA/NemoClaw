// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { readYaml, type Workflow } from "../../helpers/e2e-workflow-contract";

const workflow = readYaml<Workflow>(".github/workflows/label-v1-prs.yaml");
const script = workflow.jobs["label-v1-prs"]?.steps?.[0]?.with?.script;
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...parameters: string[]
) => (...args: unknown[]) => Promise<unknown>;

const OWNER = "NVIDIA";
const REPO = "NemoClaw";

type PullFixture = {
  number: number;
  base: string;
  head: string;
  headRepo?: string | null;
  state?: "open" | "closed";
  merged?: boolean;
  labels?: string[];
};

function toApiPull(fixture: PullFixture) {
  const headRepo = fixture.headRepo === undefined ? `${OWNER}/${REPO}` : fixture.headRepo;
  return {
    number: fixture.number,
    state: fixture.state ?? "open",
    merged_at: fixture.merged ? "2026-11-19T00:00:00Z" : null,
    base: { ref: fixture.base },
    head: { ref: fixture.head, repo: headRepo === null ? null : { full_name: headRepo } },
    labels: (fixture.labels ?? []).map((name) => ({ name })),
  };
}

// A fake GitHub that answers the pulls list filters the way the REST API does:
// `head` is "owner:branch" and matches only heads in that owner's repository.
function createHarness(current: PullFixture, others: PullFixture[] = []) {
  const pulls = [current, ...others].map(toApiPull);
  const matchesHead = (pull: (typeof pulls)[number], head: string) => {
    const [owner, branch] = head.split(":");
    return pull.head.ref === branch && pull.head.repo?.full_name === `${owner}/${REPO}`;
  };
  const list = vi.fn(
    async (query: {
      base?: string;
      head?: string;
      owner: string;
      repo: string;
      state: string;
    }) => ({
      data: pulls.filter(
        (pull) =>
          (query.state === "all" || pull.state === query.state) &&
          (query.base === undefined || pull.base.ref === query.base) &&
          (query.head === undefined || matchesHead(pull, query.head)),
      ),
    }),
  );
  const addLabels = vi.fn(async ({ issue_number: issueNumber, labels }) => {
    const pull = pulls.find((candidate) => candidate.number === issueNumber);
    pull?.labels.push(...labels.map((name: string) => ({ name })));
    return { data: [] };
  });
  const paginate = vi.fn(
    async (endpoint: (args: unknown) => Promise<{ data: unknown[] }>, args: unknown) =>
      (await endpoint(args)).data,
  );
  const github = { paginate, rest: { issues: { addLabels }, pulls: { list } } };
  const context = {
    repo: { owner: OWNER, repo: REPO },
    payload: { pull_request: pulls[0], repository: { default_branch: "main" } },
  };
  const core = { info: vi.fn(), warning: vi.fn() };
  const labelled = () =>
    addLabels.mock.calls.map(([call]) => {
      expect(call).toMatchObject({ owner: OWNER, repo: REPO, labels: ["v1"] });
      return call.issue_number;
    });
  return { addLabels, context, core, github, labelled, list };
}

async function runScript(harness: ReturnType<typeof createHarness>): Promise<void> {
  expect(script).toEqual(expect.any(String));
  await new AsyncFunction("github", "context", "core", script as string)(
    harness.github,
    harness.context,
    harness.core,
  );
}

describe("v1 pull request label workflow", () => {
  it("labels a PR whose base is v1", async () => {
    const harness = createHarness({ number: 10, base: "v1", head: "feature" });

    await runScript(harness);

    expect(harness.labelled()).toEqual([10]);
  });

  it("labels a PR stacked on open and merged PRs whose chain reaches v1", async () => {
    const harness = createHarness({ number: 30, base: "branch-b", head: "branch-c" }, [
      { number: 20, base: "branch-a", head: "branch-b" },
      { number: 10, base: "v1", head: "branch-a", state: "closed", merged: true },
    ]);

    await runScript(harness);

    expect(harness.labelled()).toEqual([30]);
  });

  it.each([
    ["the chain reaches the default branch", [{ number: 10, base: "main", head: "branch-a" }]],
    ["the base is not the head of a PR", []],
    [
      "the parent PR was closed without merging",
      [{ number: 10, base: "v1", head: "branch-a", state: "closed" as const }],
    ],
    [
      "only a fork PR has the base branch name as its head",
      [{ number: 10, base: "v1", head: "branch-a", headRepo: "someone/NemoClaw" }],
    ],
    [
      "the chain loops",
      [
        { number: 10, base: "branch-b", head: "branch-a" },
        { number: 11, base: "branch-a", head: "branch-b" },
      ],
    ],
  ])("leaves a stacked PR unlabelled when %s", async (_case, parents: PullFixture[]) => {
    const harness = createHarness({ number: 30, base: "branch-a", head: "feature" }, parents);

    await runScript(harness);

    expect(harness.addLabels).not.toHaveBeenCalled();
  });

  it("stops after ten ancestor PRs", async () => {
    const chain = (length: number) =>
      Array.from({ length }, (_, index) => ({
        number: index + 1,
        base: index === 0 ? "v1" : `branch-${index - 1}`,
        head: `branch-${index}`,
      }));

    const withinLimit = createHarness(
      { number: 100, base: "branch-9", head: "feature" },
      chain(10),
    );
    await runScript(withinLimit);
    expect(withinLimit.labelled()).toEqual([100]);

    const beyondLimit = createHarness(
      { number: 100, base: "branch-10", head: "feature" },
      chain(11),
    );
    await runScript(beyondLimit);
    expect(beyondLimit.addLabels).not.toHaveBeenCalled();
    expect(beyondLimit.core.warning).toHaveBeenCalledTimes(1);
  });

  it("labels open PRs stacked on a PR retargeted onto v1, and keeps existing labels", async () => {
    const harness = createHarness({ number: 10, base: "v1", head: "branch-a" }, [
      { number: 20, base: "branch-a", head: "branch-b" },
      { number: 21, base: "branch-a", head: "branch-x", labels: ["v1"] },
      { number: 22, base: "branch-a", head: "branch-y", state: "closed" },
      { number: 30, base: "branch-b", head: "branch-c" },
      { number: 40, base: "main", head: "unrelated" },
    ]);

    await runScript(harness);

    expect(harness.labelled()).toEqual([10, 20, 30]);
  });

  it("does not add a label the PR already has", async () => {
    const harness = createHarness({ number: 10, base: "v1", head: "feature", labels: ["v1"] });

    await runScript(harness);

    expect(harness.addLabels).not.toHaveBeenCalled();
  });

  it("does not treat PRs based on a same-named branch as stacked on a fork PR", async () => {
    const harness = createHarness(
      { number: 10, base: "v1", head: "branch-a", headRepo: "someone/NemoClaw" },
      [{ number: 20, base: "branch-a", head: "branch-b" }],
    );

    await runScript(harness);

    expect(harness.labelled()).toEqual([10]);
  });

  it("does not label PRs based on the default branch when a PR merges it into v1", async () => {
    const harness = createHarness({ number: 10, base: "v1", head: "main" }, [
      { number: 20, base: "main", head: "feature" },
    ]);

    await runScript(harness);

    expect(harness.labelled()).toEqual([10]);
  });
});
