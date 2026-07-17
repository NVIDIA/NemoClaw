// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { describe, expect, it, vi } from "vitest";

import { readYaml, type WorkflowJob } from "./helpers/e2e-workflow-contract";

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...parameters: string[]
) => (...args: unknown[]) => Promise<unknown>;

type AutoLabelWorkflow = {
  concurrency?: { group?: string; queue?: string };
  on?: {
    pull_request_target?: {
      branches?: string[];
      types?: string[];
    };
    schedule?: Array<{ cron: string }>;
    workflow_dispatch?: unknown;
  };
  permissions?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
};

type ReleaseLatestWorkflow = {
  concurrency?: { group?: string; queue?: string };
  permissions?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
};

type ComparisonStatus = "ahead" | "behind" | "diverged" | "identical";

type TagFixture = {
  name: string;
  refType?: "commit" | "tag";
  peeledType?: "commit" | "tag";
  status?: ComparisonStatus;
  aheadBy?: number;
  behindBy?: number;
};

const WORKFLOW_PATH = ".github/workflows/label-merged-pr-release-target.yaml";
const RELEASE_WORKFLOW_PATH = ".github/workflows/release-latest-tag.yaml";
const MERGE_SHA = "f".repeat(40);
const workflow = readYaml<AutoLabelWorkflow>(WORKFLOW_PATH);
const job = workflow.jobs["label-release-target"];
const actionStep = job.steps?.find((step) => step.name === "Apply release target to merged PRs");
const script = actionStep?.with?.script;
const releaseWorkflow = readYaml<ReleaseLatestWorkflow>(RELEASE_WORKFLOW_PATH);
const releaseJob = releaseWorkflow.jobs["update-latest"];
const retirementStep = releaseJob.steps?.find(
  (step) => step.name === "Retire the released target label",
);

function sha(index: number): string {
  return index.toString(16).padStart(40, "0");
}

function createHarness(tags: TagFixture[], pullRequestLabels: string[] = []) {
  const fixtures = tags.map((tag, index) => ({
    ...tag,
    objectSha: sha(index * 2 + 1),
    commitSha: sha(index * 2 + 2),
  }));
  const fixtureByName = new Map(fixtures.map((fixture) => [fixture.name, fixture]));
  const fixtureByObjectSha = new Map(fixtures.map((fixture) => [fixture.objectSha, fixture]));
  const fixtureByCommitSha = new Map(fixtures.map((fixture) => [fixture.commitSha, fixture]));

  const listTags = vi.fn().mockResolvedValue({
    data: fixtures.map(({ name }) => ({ name })),
  });
  const getRef = vi.fn(async ({ ref }: { ref: string }) => {
    const fixture = fixtureByName.get(ref.replace(/^tags\//u, ""));
    assert(fixture, `Unexpected tag ref: ${ref}`);
    return {
      data: {
        object: {
          sha: fixture.objectSha,
          type: fixture.refType ?? "tag",
        },
      },
    };
  });
  const getTag = vi.fn(async ({ tag_sha: tagSha }: { tag_sha: string }) => {
    const fixture = fixtureByObjectSha.get(tagSha);
    assert(fixture, `Unexpected tag object: ${tagSha}`);
    return {
      data: {
        object: {
          sha: fixture.commitSha,
          type: fixture.peeledType ?? "commit",
        },
      },
    };
  });
  const compareCommitsWithBasehead = vi.fn(async ({ basehead }: { basehead: string }) => {
    const [base, head] = basehead.split("...");
    const fixture = fixtureByCommitSha.get(base);
    assert(fixture, `Unexpected comparison base: ${base}`);
    assert.equal(head, MERGE_SHA, `Unexpected comparison head: ${head}`);
    const status = fixture.status ?? "ahead";
    return {
      data: {
        status,
        ahead_by: fixture.aheadBy ?? (status === "ahead" ? 1 : 0),
        behind_by: fixture.behindBy ?? (status === "behind" ? 1 : 0),
      },
    };
  });
  const getLabel = vi.fn().mockResolvedValue({ data: { name: "release-target" } });
  const createLabel = vi.fn().mockResolvedValue({ data: {} });
  const addLabels = vi.fn().mockResolvedValue({ data: [] });
  const getBranch = vi.fn().mockResolvedValue({ data: { commit: { sha: MERGE_SHA } } });
  const listPullRequestsAssociatedWithCommit = vi.fn().mockResolvedValue({ data: [] });
  const info = vi.fn();
  const warning = vi.fn();
  const paginate = vi.fn(async (endpoint: (args: unknown) => Promise<{ data: unknown }>, args) => {
    const response = await endpoint(args);
    return response.data;
  });

  const github = {
    paginate,
    rest: {
      git: { getRef, getTag },
      issues: { addLabels, createLabel, getLabel },
      repos: {
        compareCommitsWithBasehead,
        getBranch,
        listPullRequestsAssociatedWithCommit,
        listTags,
      },
    },
  };
  const context = {
    eventName: "pull_request_target",
    payload: {
      pull_request: {
        labels: pullRequestLabels.map((name) => ({ name })),
        merge_commit_sha: MERGE_SHA,
        merged: true,
        number: 123,
      },
      repository: { default_branch: "main" },
    },
    repo: { owner: "NVIDIA", repo: "NemoClaw" },
  };
  const core = { info, warning };

  return {
    addLabels,
    compareCommitsWithBasehead,
    context,
    core,
    createLabel,
    fixtures,
    getBranch,
    getLabel,
    getRef,
    getTag,
    github,
    info,
    listPullRequestsAssociatedWithCommit,
    listTags,
    paginate,
    warning,
  };
}

async function runScript(harness: ReturnType<typeof createHarness>): Promise<void> {
  expect(script).toEqual(expect.any(String));
  await new AsyncFunction("github", "context", "core", script as string)(
    harness.github,
    harness.context,
    harness.core,
  );
}

describe("merged PR release target workflow", () => {
  // source-shape-contract: security -- Privileged label writes must stay metadata-only and serialize retirement with assignment
  it("keeps fork-safe labeling inside the trusted metadata boundary", () => {
    const coordination = {
      group: "release-target-label-operations",
      queue: "max",
    };
    expect(workflow.on?.pull_request_target).toEqual({
      branches: ["main"],
      types: ["closed"],
    });
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.permissions).toEqual({
      contents: "read",
      issues: "write",
      "pull-requests": "write",
    });
    expect(workflow.concurrency).toEqual(coordination);
    expect(releaseWorkflow.concurrency).toEqual(coordination);
    expect(releaseWorkflow.permissions).toEqual({
      contents: "write",
      issues: "write",
      "pull-requests": "write",
    });
    expect(job.if).toBe(
      "${{ github.event_name != 'pull_request_target' || github.event.pull_request.merged == true }}",
    );
    expect(actionStep?.uses).toMatch(/^actions\/github-script@[0-9a-f]{40}$/u);
    expect(job.steps).toHaveLength(1);
    expect(job.steps?.some((step) => step.uses?.startsWith("actions/checkout@"))).toBe(false);
    expect(job.steps?.some((step) => typeof step.run === "string")).toBe(false);
    expect(script).not.toContain("containing release");
    expect(script).not.toContain("RECONCILIATION_WINDOW_MS");
    expect(retirementStep?.env).toMatchObject({
      GH_TOKEN: "${{ github.token }}",
    });
    expect(retirementStep?.run).toContain("scripts/retire-release-label.mts");
    const latestIndex = releaseJob.steps?.findIndex(
      (step) => step.name === "Move latest to the verified release tag object",
    );
    const retirementIndex = releaseJob.steps?.findIndex(
      (step) => step.name === "Retire the released target label",
    );
    expect(latestIndex).toBeGreaterThanOrEqual(0);
    expect(retirementIndex).toBeGreaterThan(latestIndex ?? -1);
  });

  it.each([
    ["pull request", undefined, "pull_request is missing"],
    [
      "PR number",
      { labels: [], merge_commit_sha: MERGE_SHA, merged: true, number: 0 },
      "Invalid merged pull request number: 0",
    ],
    [
      "labels",
      { labels: null, merge_commit_sha: MERGE_SHA, merged: true, number: 123 },
      "labels must be an array",
    ],
    [
      "merge SHA",
      { labels: [], merge_commit_sha: "not-a-sha", merged: true, number: 123 },
      "Invalid merge commit SHA for PR #123",
    ],
    [
      "merged state",
      { labels: [], merge_commit_sha: MERGE_SHA, merged: false, number: 123 },
      "merged must be true",
    ],
  ])("rejects malformed %s metadata before calling GitHub", async (_field, pullRequest, error) => {
    const harness = createHarness([{ name: "v0.0.10", status: "ahead" }]);
    Object.assign(harness.context.payload, { pull_request: pullRequest });

    await expect(runScript(harness)).rejects.toThrow(error);
    expect(harness.listTags).not.toHaveBeenCalled();
    expect(harness.addLabels).not.toHaveBeenCalled();
  });

  it("uses numeric semver order and ignores non-release tags", async () => {
    const harness = createHarness([
      { name: "v0.0.9", status: "ahead" },
      { name: "latest" },
      { name: "v0.0.10", status: "ahead" },
      { name: "v0.0.11-rc.1" },
    ]);

    await runScript(harness);

    expect(harness.paginate).toHaveBeenCalledWith(harness.listTags, {
      owner: "NVIDIA",
      repo: "NemoClaw",
      per_page: 100,
    });
    expect(harness.listTags).toHaveBeenCalledWith({
      owner: "NVIDIA",
      repo: "NemoClaw",
      per_page: 100,
    });
    expect(harness.getRef).toHaveBeenCalledTimes(1);
    expect(harness.getRef).toHaveBeenCalledWith(expect.objectContaining({ ref: "tags/v0.0.10" }));
    expect(harness.addLabels).toHaveBeenCalledWith({
      owner: "NVIDIA",
      repo: "NemoClaw",
      issue_number: 123,
      labels: ["v0.0.11"],
    });
  });

  it("does not label a PR already captured at the latest tag boundary", async () => {
    const harness = createHarness([
      { name: "v0.0.10", status: "identical" },
      { name: "v0.0.9", status: "ahead" },
    ]);

    await runScript(harness);

    expect(harness.compareCommitsWithBasehead).toHaveBeenCalledTimes(1);
    expect(harness.addLabels).not.toHaveBeenCalled();
    expect(harness.info).toHaveBeenCalledWith(
      "PR #123 is already contained in v0.0.10; no release target label added",
    );
  });

  it("does not recreate a label when the latest release contains the merge", async () => {
    const harness = createHarness([
      { name: "v0.0.11", status: "behind" },
      { name: "v0.0.10", status: "ahead" },
    ]);

    await runScript(harness);

    expect(harness.compareCommitsWithBasehead).toHaveBeenCalledTimes(1);
    expect(harness.addLabels).not.toHaveBeenCalled();
    expect(harness.info).toHaveBeenCalledWith(
      "PR #123 is already contained in v0.0.11; no release target label added",
    );
  });

  it("creates a missing release label and preserves older release labels", async () => {
    const harness = createHarness([{ name: "v1.2.3", status: "ahead" }], ["v1.2.2"]);
    harness.getLabel.mockRejectedValueOnce({ status: 404 });

    await runScript(harness);

    expect(harness.createLabel).toHaveBeenCalledWith({
      owner: "NVIDIA",
      repo: "NemoClaw",
      name: "v1.2.4",
      color: "1d76db",
      description: "Release target",
    });
    expect(harness.warning).toHaveBeenCalledWith(expect.stringContaining("preserving them"));
    expect(harness.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["v1.2.4"] }));
  });

  it("verifies a release label created by a concurrent run", async () => {
    const harness = createHarness([{ name: "v1.2.3", status: "ahead" }]);
    harness.getLabel
      .mockRejectedValueOnce({ status: 404 })
      .mockResolvedValueOnce({ data: { name: "v1.2.4" } });
    harness.createLabel.mockRejectedValueOnce({ status: 422 });

    await runScript(harness);

    expect(harness.getLabel).toHaveBeenCalledTimes(2);
    expect(harness.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["v1.2.4"] }));
  });

  it("leaves an already-correct PR unchanged", async () => {
    const harness = createHarness([{ name: "v1.2.3", status: "ahead" }], ["v1.2.4"]);

    await runScript(harness);

    expect(harness.getLabel).not.toHaveBeenCalled();
    expect(harness.createLabel).not.toHaveBeenCalled();
    expect(harness.addLabels).not.toHaveBeenCalled();
    expect(harness.info).toHaveBeenCalledWith("PR #123 already has release target v1.2.4");
  });

  it("rejects lightweight release tags", async () => {
    const harness = createHarness([{ name: "v1.2.3", refType: "commit", status: "ahead" }]);

    await expect(runScript(harness)).rejects.toThrow("Release tag v1.2.3 must be annotated");
    expect(harness.addLabels).not.toHaveBeenCalled();
  });

  it("fails rather than guessing across divergent release history", async () => {
    const harness = createHarness([
      { name: "v1.2.3", status: "diverged", aheadBy: 1, behindBy: 1 },
    ]);

    await expect(runScript(harness)).rejects.toThrow("is not linear: diverged");
    expect(harness.addLabels).not.toHaveBeenCalled();
  });

  it("fails rather than overflowing the next patch version", async () => {
    const harness = createHarness([{ name: `v1.2.${Number.MAX_SAFE_INTEGER}`, status: "ahead" }]);

    await expect(runScript(harness)).rejects.toThrow(
      `Cannot increment release tag v1.2.${Number.MAX_SAFE_INTEGER} safely`,
    );
    expect(harness.addLabels).not.toHaveBeenCalled();
  });

  it("propagates label API failures without applying a partial write", async () => {
    const harness = createHarness([{ name: "v1.2.3", status: "ahead" }]);
    harness.getLabel.mockRejectedValueOnce({ status: 403, message: "forbidden" });

    await expect(runScript(harness)).rejects.toMatchObject({ status: 403 });
    expect(harness.createLabel).not.toHaveBeenCalled();
    expect(harness.addLabels).not.toHaveBeenCalled();
  });

  it("repairs missed labels only in the current untagged interval", async () => {
    const harness = createHarness([{ name: "v0.0.10" }, { name: "v0.0.9" }]);
    const mainCommit = "e".repeat(40);
    const [latest] = harness.fixtures;
    harness.context.eventName = "schedule";
    harness.getBranch.mockResolvedValueOnce({ data: { commit: { sha: mainCommit } } });
    harness.compareCommitsWithBasehead.mockImplementation(
      async ({ basehead }: { basehead: string }) => {
        switch (basehead) {
          case `${latest.commitSha}...${mainCommit}`:
            return {
              data: {
                status: "ahead",
                ahead_by: 1,
                behind_by: 0,
                total_commits: 1,
                commits: [{ sha: MERGE_SHA }],
              },
            };
          default:
            throw new Error(`Unexpected reconciliation comparison: ${basehead}`);
        }
      },
    );
    harness.listPullRequestsAssociatedWithCommit.mockImplementation(
      async ({ commit_sha: commitSha }: { commit_sha: string }) => ({
        data:
          commitSha === MERGE_SHA
            ? [
                {
                  base: { ref: "main" },
                  labels: [],
                  merge_commit_sha: MERGE_SHA,
                  merged_at: "2026-07-04T00:00:00Z",
                  number: 123,
                },
              ]
            : [],
      }),
    );

    await runScript(harness);

    expect(harness.listPullRequestsAssociatedWithCommit).toHaveBeenCalledTimes(1);
    expect(harness.addLabels).toHaveBeenCalledTimes(1);
    expect(harness.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 123, labels: ["v0.0.11"] }),
    );
    expect(harness.info).toHaveBeenCalledWith("Reconciled 1 merged PR release target(s)");
  });

  it("never scans completed release intervals", async () => {
    const harness = createHarness([{ name: "v0.0.10" }, { name: "v0.0.9" }]);
    const mainCommit = "e".repeat(40);
    const [latest] = harness.fixtures;
    harness.context.eventName = "schedule";
    harness.getBranch.mockResolvedValueOnce({ data: { commit: { sha: mainCommit } } });
    harness.compareCommitsWithBasehead.mockImplementation(
      async ({ basehead }: { basehead: string }) => {
        assert.equal(
          basehead,
          `${latest.commitSha}...${mainCommit}`,
          `Unexpected release comparison: ${basehead}`,
        );
        return {
          data: {
            status: "identical",
            ahead_by: 0,
            behind_by: 0,
            total_commits: 0,
            commits: [],
          },
        };
      },
    );

    await runScript(harness);

    expect(harness.compareCommitsWithBasehead).toHaveBeenCalledTimes(1);
    expect(harness.getRef).toHaveBeenCalledTimes(2);
    expect(harness.listPullRequestsAssociatedWithCommit).not.toHaveBeenCalled();
    expect(harness.addLabels).not.toHaveBeenCalled();
  });

  it("restarts reconciliation when a release tag lands during the audit", async () => {
    const harness = createHarness([{ name: "v0.0.11" }, { name: "v0.0.10" }, { name: "v0.0.9" }]);
    const mainCommit = "e".repeat(40);
    const [v11, v10, v09] = harness.fixtures;
    harness.context.eventName = "schedule";
    harness.listTags
      .mockResolvedValueOnce({ data: [{ name: v10.name }, { name: v09.name }] })
      .mockResolvedValue({
        data: [{ name: v11.name }, { name: v10.name }, { name: v09.name }],
      });
    harness.getBranch.mockResolvedValue({ data: { commit: { sha: mainCommit } } });
    harness.compareCommitsWithBasehead.mockImplementation(
      async ({ basehead }: { basehead: string }) => {
        switch (basehead) {
          case `${v11.commitSha}...${mainCommit}`:
            return {
              data: {
                status: "ahead",
                ahead_by: 1,
                behind_by: 0,
                total_commits: 1,
                commits: [{ sha: MERGE_SHA }],
              },
            };
          case `${v10.commitSha}...${mainCommit}`:
            return {
              data: {
                status: "ahead",
                ahead_by: 1,
                behind_by: 0,
                total_commits: 1,
                commits: [{ sha: "c".repeat(40) }],
              },
            };
          default:
            throw new Error(`Unexpected tag-change comparison: ${basehead}`);
        }
      },
    );
    harness.listPullRequestsAssociatedWithCommit.mockImplementation(
      async ({ commit_sha: commitSha }: { commit_sha: string }) => ({
        data:
          commitSha === MERGE_SHA
            ? [
                {
                  base: { ref: "main" },
                  labels: [],
                  merge_commit_sha: MERGE_SHA,
                  merged_at: "2026-07-04T00:00:00Z",
                  number: 123,
                },
              ]
            : [],
      }),
    );

    await runScript(harness);

    expect(harness.warning).toHaveBeenCalledWith(
      "Newest release tag changed; restarting reconciliation",
    );
    expect(harness.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 123, labels: ["v0.0.12"] }),
    );
  });

  it("stops after two reconciliation restarts when release tags keep changing", async () => {
    const harness = createHarness(
      ["v0.0.13", "v0.0.12", "v0.0.11", "v0.0.10", "v0.0.9"].map((name) => ({ name })),
    );
    const [v13, v12, v11, v10, v09] = harness.fixtures;
    harness.context.eventName = "schedule";
    harness.listTags
      .mockResolvedValueOnce({ data: [v10, v09] })
      .mockResolvedValueOnce({ data: [v11, v10, v09] })
      .mockResolvedValueOnce({ data: [v11, v10, v09] })
      .mockResolvedValueOnce({ data: [v12, v11, v10, v09] })
      .mockResolvedValueOnce({ data: [v12, v11, v10, v09] })
      .mockResolvedValueOnce({ data: [v13, v12, v11, v10, v09] });

    await expect(runScript(harness)).rejects.toThrow(
      "Newest release tag kept changing during reconciliation",
    );
    expect(harness.listTags).toHaveBeenCalledTimes(6);
    expect(harness.warning).toHaveBeenCalledTimes(2);
    expect(harness.getBranch).toHaveBeenCalledTimes(3);
    expect(harness.addLabels).not.toHaveBeenCalled();
  });
});
