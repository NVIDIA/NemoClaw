// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { readYaml, type WorkflowJob } from "./helpers/e2e-workflow-contract";

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...parameters: string[]
) => (...args: unknown[]) => Promise<unknown>;

type Workflow = {
  on?: Record<string, any>;
  permissions?: Record<string, string>;
  concurrency?: Record<string, any>;
  jobs: Record<string, WorkflowJob & Record<string, any>>;
};

const close = readYaml<Workflow>(".github/workflows/release-edition-close.yaml");
const cut = readYaml<Workflow>(".github/workflows/release-edition-cut.yaml");
const postMerge = readYaml<Workflow>(".github/workflows/post-merge-agent-review.yaml");
const advisor = readYaml<Workflow>(".github/workflows/pr-review-advisor.yaml");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("release edition workflows", () => {
  // source-shape-contract: security -- The plan artifact freezes a trusted candidate without tag or label write authority
  it("closes the edition after the exact Los Angeles cutoff with read-only permissions", () => {
    expect(close.on?.schedule).toEqual([{ cron: "17 16 * * *", timezone: "America/Los_Angeles" }]);
    expect(close.permissions).toEqual({ actions: "read", contents: "read" });
    expect(close.concurrency).toEqual({
      group: "release-edition-close",
      "cancel-in-progress": false,
    });
    const steps = close.jobs["freeze-candidate"].steps ?? [];
    const checkout = steps.find((step) => step.name === "Check out trusted main history");
    const freeze = steps.find((step) => step.name === "Freeze release candidate");
    const upload = steps.find((step) => step.name === "Upload immutable edition plan");

    expect(checkout?.with).toMatchObject({
      ref: "main",
      "fetch-depth": 0,
      "persist-credentials": false,
    });
    expect(freeze?.run).toContain('--scheduled-edition "$EDITION_DATE"');
    expect(freeze?.run).toContain('--candidate-sha "$CANDIDATE_SHA"');
    expect(freeze?.run).toContain('--candidate-run-id "$CANDIDATE_RUN_ID"');
    expect(freeze?.run).toContain('--candidate-recorded-at "$CANDIDATE_RECORDED_AT"');
    expect(freeze?.run).not.toMatch(/e2e/iu);
    expect(upload?.with).toMatchObject({
      name: "release-edition-plan-${{ steps.edition.outputs.date }}",
      "if-no-files-found": "error",
      "retention-days": 3,
    });
  });

  it("selects the latest GitHub-recorded main push at or before the cutoff", async () => {
    const step = close.jobs["freeze-candidate"].steps?.find(
      (candidate) => candidate.name === "Resolve latest server-recorded main push",
    );
    const script = String(step?.with?.script ?? "");
    vi.stubEnv("CUTOFF_AT", "2026-08-06T23:00:00.000Z");
    const lateSha = "c".repeat(40);
    const selectedSha = "b".repeat(40);
    const listWorkflowRuns = vi.fn().mockResolvedValue({
      data: {
        workflow_runs: [
          {
            id: 44,
            event: "push",
            head_branch: "main",
            head_sha: lateSha,
            created_at: "2026-08-06T23:00:01Z",
            html_url: "late",
          },
          {
            id: 43,
            event: "push",
            head_branch: "main",
            head_sha: selectedSha,
            created_at: "2026-08-06T22:59:59Z",
            html_url: "selected",
          },
          {
            id: 42,
            event: "push",
            head_branch: "main",
            head_sha: "a".repeat(40),
            created_at: "2026-08-06T22:00:00Z",
            html_url: "older",
          },
        ],
      },
    });
    const setOutput = vi.fn();
    const github = { rest: { actions: { listWorkflowRuns } } };
    const context = { repo: { owner: "NVIDIA", repo: "NemoClaw" } };
    const core = { info: vi.fn(), setOutput };

    await new AsyncFunction("github", "context", "core", script as string)(github, context, core);

    expect(listWorkflowRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow_id: "post-merge-agent-review.yaml",
        branch: "main",
        event: "push",
      }),
    );
    expect(setOutput).toHaveBeenCalledWith("sha", selectedSha);
    expect(setOutput).toHaveBeenCalledWith("run_id", "43");
    expect(setOutput).toHaveBeenCalledWith("recorded_at", "2026-08-06T22:59:59Z");
  });

  // source-shape-contract: security -- Only the canonical schedule may publish, while manual dispatch remains signing preflight
  it("cuts at 4 AM without E2E input and delegates exact-object promotion", () => {
    expect(cut.on?.schedule).toEqual([{ cron: "17 4 * * *", timezone: "America/Los_Angeles" }]);
    expect(cut.on?.workflow_dispatch?.inputs?.edition_date).toMatchObject({
      required: true,
      type: "string",
    });
    expect(cut.permissions).toEqual({});
    const cutJob = cut.jobs.cut;
    const steps = cutJob.steps ?? [];
    const configure = steps.find((step) => step.name === "Configure dedicated release signer");
    const execute = steps.find(
      (step) => step.name === "Cut scheduled tag or preflight manual dispatch",
    );
    const cleanup = steps.find((step) => step.name === "Remove release signer");

    expect(cutJob.environment).toBe("release-tag");
    expect(cutJob.permissions).toEqual({ actions: "read", contents: "write" });
    expect(configure?.env).toMatchObject({
      SIGNING_KEY: "${{ secrets.NEMOCLAW_RELEASE_TAG_SIGNING_KEY }}",
      SIGNER_EMAIL: "${{ vars.NEMOCLAW_RELEASE_TAG_SIGNER_EMAIL }}",
      SIGNER_NAME: "${{ vars.NEMOCLAW_RELEASE_TAG_SIGNER_NAME }}",
    });
    expect(execute?.run).toContain('scripts/release-cut-tag.sh --plan "$PLAN_PATH" --scheduled');
    expect(execute?.run).toContain(
      'scripts/release-cut-tag.sh --plan "$PLAN_PATH" --preflight-only',
    );
    expect(execute?.run).not.toMatch(/e2e/iu);
    expect(cleanup?.if).toBe("${{ always() }}");
    expect(cut.jobs.promote).toMatchObject({
      if: "${{ needs.cut.outputs.status == 'tagged' }}",
      uses: "./.github/workflows/release-latest-tag.yaml",
      permissions: {
        contents: "write",
        issues: "write",
        "pull-requests": "write",
      },
      with: { tag: "${{ needs.cut.outputs.tag }}" },
    });
    const handoff = cut.jobs["verify-and-handoff"];
    expect(handoff.if).toContain("needs.cut.outputs.status == 'no-changes'");
    const verify = handoff.steps?.find(
      (step) => step.name === "Verify latest and create handoff data",
    );
    expect(verify?.if).toBe("${{ needs.cut.outputs.status == 'tagged' }}");
    const upload = handoff.steps?.find((step) => step.name === "Upload verified handoff");
    expect(upload?.with?.name).toContain("no-changes-");
  });

  it("selects only a successful scheduled close artifact with the exact edition name", async () => {
    const step = cut.jobs.cut.steps?.find(
      (candidate) => candidate.name === "Find successful edition-close artifact",
    );
    const script = String(step?.with?.script ?? "");
    vi.stubEnv("ARTIFACT_NAME", "release-edition-plan-2026-08-05");
    const listWorkflowRuns = vi.fn().mockResolvedValue({
      data: {
        workflow_runs: [
          { id: 40, conclusion: "success", head_branch: "feature", html_url: "wrong-branch" },
          { id: 41, conclusion: "failure", head_branch: "main", html_url: "failed" },
          { id: 42, conclusion: "success", head_branch: "main", html_url: "trusted" },
        ],
      },
    });
    const listWorkflowRunArtifacts = vi.fn();
    const paginate = vi.fn(async (method: unknown, args: Record<string, unknown>) => {
      expect(method).toBe(listWorkflowRunArtifacts);
      expect(args.run_id).toBe(42);
      return [
        {
          name: "release-edition-plan-2026-08-05",
          expired: false,
        },
      ];
    });
    const setOutput = vi.fn();
    const github = {
      paginate,
      rest: { actions: { listWorkflowRuns, listWorkflowRunArtifacts } },
    };
    const context = { repo: { owner: "NVIDIA", repo: "NemoClaw" } };
    const core = { info: vi.fn(), setOutput };

    await new AsyncFunction("github", "context", "core", script as string)(github, context, core);

    expect(listWorkflowRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow_id: "release-edition-close.yaml",
        event: "schedule",
        status: "completed",
        branch: "main",
      }),
    );
    expect(setOutput).toHaveBeenCalledWith("run_id", "42");
  });

  it("rejects ambiguous scheduled close artifacts for one edition", async () => {
    const step = cut.jobs.cut.steps?.find(
      (candidate) => candidate.name === "Find successful edition-close artifact",
    );
    const script = String(step?.with?.script ?? "");
    vi.stubEnv("ARTIFACT_NAME", "release-edition-plan-2026-08-05");
    const listWorkflowRuns = vi.fn().mockResolvedValue({
      data: {
        workflow_runs: [
          { id: 42, conclusion: "success", head_branch: "main", html_url: "first" },
          { id: 43, conclusion: "success", head_branch: "main", html_url: "second" },
        ],
      },
    });
    const listWorkflowRunArtifacts = vi.fn();
    const paginate = vi
      .fn()
      .mockResolvedValue([{ name: "release-edition-plan-2026-08-05", expired: false }]);
    const github = {
      paginate,
      rest: { actions: { listWorkflowRuns, listWorkflowRunArtifacts } },
    };
    const context = { repo: { owner: "NVIDIA", repo: "NemoClaw" } };
    const core = { info: vi.fn(), setOutput: vi.fn() };

    let errorMessage = "";
    try {
      await new AsyncFunction("github", "context", "core", script)(github, context, core);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    expect(errorMessage).toContain("Expected exactly one successful scheduled source");
    expect(paginate).toHaveBeenCalledTimes(2);
  });
});

describe("post-merge agent review", () => {
  // source-shape-contract: security -- The dispatcher has no code or secret access and binds analysis to the immutable push range
  it("dispatches one asynchronous advisor run for the exact main SHA range", async () => {
    expect(postMerge.on?.push?.branches).toEqual(["main"]);
    expect(postMerge.permissions).toEqual({ actions: "write" });
    const job = postMerge.jobs["dispatch-exact-main-delta"];
    expect(job.steps).toHaveLength(1);
    const step = job.steps?.[0];
    expect(step?.uses).toBe("actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3");
    const script = String(step?.with?.script ?? "");
    const base = "a".repeat(40);
    const head = "b".repeat(40);
    vi.stubEnv("BASE_SHA", base);
    vi.stubEnv("HEAD_SHA", head);
    const createWorkflowDispatch = vi.fn().mockResolvedValue(undefined);
    const write = vi.fn().mockResolvedValue(undefined);
    const summary = {
      addHeading: vi.fn(),
      addRaw: vi.fn(),
      write,
    };
    summary.addHeading.mockReturnValue(summary);
    summary.addRaw.mockReturnValue(summary);
    const github = { rest: { actions: { createWorkflowDispatch } } };
    const context = {
      payload: { repository: { default_branch: "main" } },
      repo: { owner: "NVIDIA", repo: "NemoClaw" },
    };

    await new AsyncFunction("github", "context", "core", script)(github, context, {
      summary,
    });

    expect(createWorkflowDispatch).toHaveBeenCalledWith({
      owner: "NVIDIA",
      repo: "NemoClaw",
      workflow_id: "pr-review-advisor.yaml",
      ref: "main",
      inputs: { base_ref: base, head_ref: head, run_analysis: "true" },
    });
    expect(write).toHaveBeenCalled();
  });

  // source-shape-contract: security -- Exact immutable-head concurrency preserves every asynchronous post-merge review turn
  it("keeps independent merge reviews from cancelling each other", () => {
    expect(advisor.concurrency?.group).toContain("${{ inputs.head_ref || '' }}");
    expect(advisor.concurrency?.["cancel-in-progress"]).toBe(true);
  });
});
