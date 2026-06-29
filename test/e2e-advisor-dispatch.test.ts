// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  collectRecommendedJobs,
  extractDispatchableJobs,
  planAutoDispatch,
  validateDispatchInputs,
  validateGitRef,
} from "../tools/e2e-advisor/dispatch.mts";

const NIGHTLY_E2E_WORKFLOW_FIXTURE = `
jobs:
  network-policy-e2e:
    if: github.event_name != 'workflow_dispatch' || inputs.jobs == '' || contains(format(',{0},', inputs.jobs), ',network-policy-e2e,')
    steps: []
  cloud-e2e:
    if: github.event_name != 'workflow_dispatch' || inputs.jobs == '' || contains(format(',{0},', inputs.jobs), ',cloud-e2e,')
    steps: []
  cloud-onboard-e2e:
    if: github.event_name != 'workflow_dispatch' || inputs.jobs == '' || contains(format(',{0},', inputs.jobs), ',cloud-onboard-e2e,')
    uses: ./.github/workflows/e2e-script.yaml
    with:
      ref: \${{ inputs.target_ref || github.ref }}
      nvidia_api_key: true
    secrets: *nightly-e2e-default-secrets
  launchable-smoke-e2e:
    if: github.event_name != 'workflow_dispatch' || inputs.jobs == '' || contains(format(',{0},', inputs.jobs), ',launchable-smoke-e2e,')
    runs-on: ubuntu-latest
    steps:
      - name: Run launchable install-flow smoke test
        env:
          NVIDIA_INFERENCE_API_KEY: \${{ (github.event_name != 'workflow_dispatch' || inputs.target_ref == '') && secrets.NVIDIA_INFERENCE_API_KEY || '' }}
          NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1"
          COMPATIBLE_API_KEY: \${{ (github.event_name != 'workflow_dispatch' || inputs.target_ref == '') && secrets.NVIDIA_INFERENCE_API_KEY || '' }}
        run: bash test/e2e/test-launchable-smoke.sh
  report-to-pr:
    steps: []
  notify-on-failure:
    steps: []
  scorecard:
    steps: []
`;

function pullRequest(authorAssociation = "MEMBER", overrides = {}) {
  return {
    pull_request: {
      number: 123,
      author_association: authorAssociation,
      user: { login: "ericksoa" },
      ...overrides,
      head: {
        ref: "feature/e2e-advisor",
        sha: "abc123def456",
        repo: { full_name: "NVIDIA/NemoClaw" },
      },
      base: { ref: "main" },
    },
  };
}

function nightlyWorkflowText(): string {
  return NIGHTLY_E2E_WORKFLOW_FIXTURE;
}

function advisorResult(job = "network-policy-e2e") {
  return {
    confidence: "high",
    requiredTests: [
      {
        id: job,
        job,
        workflow: "nightly-e2e.yaml",
        reason: "covers the changed network policy path",
      },
    ],
  };
}

describe("E2E advisor auto-dispatch planning", () => {
  it("derives dispatchable jobs from nightly-e2e selective-dispatch predicates", () => {
    const jobs = extractDispatchableJobs(nightlyWorkflowText());

    expect(jobs).toContain("network-policy-e2e");
    expect(jobs).toContain("cloud-e2e");
    expect(jobs).toContain("cloud-onboard-e2e");
    expect(jobs).toContain("launchable-smoke-e2e");
    expect(jobs).not.toContain("report-to-pr");
    expect(jobs).not.toContain("notify-on-failure");
    expect(jobs).not.toContain("scorecard");
  });

  it("plans a trusted main-workflow dispatch for NVIDIA org member PRs", () => {
    const workflowText = nightlyWorkflowText();
    const plan = planAutoDispatch({
      result: advisorResult(),
      workflowText,
      event: pullRequest("MEMBER"),
      env: {
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
        GITHUB_RUN_ID: "456789",
        GITHUB_RUN_ATTEMPT: "2",
      },
    });

    expect(plan.status).toBe("ready");
    expect(plan.ref).toBe("main");
    expect(plan.inputs).toMatchObject({
      jobs: "network-policy-e2e",
      target_ref: "abc123def456",
      pr_number: "123",
      advisor_dispatch_id: "advisor-123-456789-2",
    });
    expect(plan.advisorDispatchId).toBe("advisor-123-456789-2");
  });

  it("dispatches all required jobs without applying the retired max-jobs cap", () => {
    const workflowText = nightlyWorkflowText();
    const plan = planAutoDispatch({
      result: {
        confidence: "high",
        requiredTests: [
          { id: "network-policy-e2e", workflow: "nightly-e2e.yaml" },
          { id: "cloud-e2e", workflow: "nightly-e2e.yaml" },
        ],
      },
      workflowText,
      event: pullRequest("MEMBER"),
      env: {
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
        E2E_ADVISOR_AUTO_DISPATCH_MAX_JOBS: "1",
      },
    });

    expect(plan.status).toBe("ready");
    expect(plan.jobs).toEqual(["network-policy-e2e", "cloud-e2e"]);
    expect(plan.inputs?.jobs).toBe("network-policy-e2e,cloud-e2e");
  });

  it("filters hosted-inference jobs that cannot receive secrets on target-ref dispatches", () => {
    const workflowText = nightlyWorkflowText();
    const plan = planAutoDispatch({
      result: {
        confidence: "high",
        requiredTests: [
          { id: "network-policy-e2e", workflow: "nightly-e2e.yaml" },
          { id: "cloud-onboard-e2e", workflow: "nightly-e2e.yaml" },
          { id: "launchable-smoke-e2e", workflow: "nightly-e2e.yaml" },
        ],
      },
      workflowText,
      event: pullRequest("MEMBER"),
      env: {
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
      },
    });

    expect(plan.status).toBe("ready");
    expect(plan.jobs).toEqual(["network-policy-e2e"]);
    expect(plan.inputs?.jobs).toBe("network-policy-e2e");
    expect(plan.ignoredJobs).toEqual(["cloud-onboard-e2e", "launchable-smoke-e2e"]);
    expect(plan.targetRefSecretBlockedJobs).toEqual(["cloud-onboard-e2e", "launchable-smoke-e2e"]);
  });

  it("skips cleanly when every recommended target-ref job requires withheld secrets", () => {
    const workflowText = nightlyWorkflowText();
    const plan = planAutoDispatch({
      result: {
        confidence: "high",
        requiredTests: [
          { id: "cloud-onboard-e2e", workflow: "nightly-e2e.yaml" },
          { id: "launchable-smoke-e2e", workflow: "nightly-e2e.yaml" },
        ],
      },
      workflowText,
      event: pullRequest("MEMBER"),
      env: {
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
      },
    });

    expect(plan.status).toBe("skipped");
    expect(plan.reason).toMatch(/hosted inference secrets are withheld/);
    expect(plan.ignoredJobs).toEqual(["cloud-onboard-e2e", "launchable-smoke-e2e"]);
    expect(plan.targetRefSecretBlockedJobs).toEqual(["cloud-onboard-e2e", "launchable-smoke-e2e"]);
  });

  it("plans dispatch for allowlisted authors whose private org membership appears as contributor", () => {
    const workflowText = nightlyWorkflowText();
    const plan = planAutoDispatch({
      result: advisorResult(),
      workflowText,
      event: pullRequest("CONTRIBUTOR", { user: { login: "ericksoa" } }),
      env: {
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
        E2E_ADVISOR_AUTO_DISPATCH_ALLOWED_AUTHORS: "octocat,ErickSOA",
      },
    });

    expect(plan.status).toBe("ready");
    expect(plan.authorLogin).toBe("ericksoa");
    expect(plan.allowedByAuthorAllowlist).toBe(true);
  });

  it("skips PRs that are not authored by org members, owners, or allowlisted authors", () => {
    const workflowText = nightlyWorkflowText();
    const plan = planAutoDispatch({
      result: advisorResult(),
      workflowText,
      event: pullRequest("COLLABORATOR", { user: { login: "outside-contributor" } }),
      env: {
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
        E2E_ADVISOR_AUTO_DISPATCH_ALLOWED_AUTHORS: "ericksoa",
      },
    });

    expect(plan.status).toBe("skipped");
    expect(plan.reason).toMatch(/not allowed/);
    expect(plan.reason).toMatch(/not allowlisted/);
  });

  it("skips draft PRs", () => {
    const workflowText = nightlyWorkflowText();
    const plan = planAutoDispatch({
      result: advisorResult(),
      workflowText,
      event: pullRequest("MEMBER", { draft: true }),
      env: {
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
      },
    });

    expect(plan.status).toBe("skipped");
    expect(plan.reason).toBe("PR is a draft");
  });

  it("ignores recommendations that are not dispatchable in the target workflow", () => {
    const workflowText = nightlyWorkflowText();
    const plan = planAutoDispatch({
      result: advisorResult("not-a-real-e2e-job"),
      workflowText,
      event: pullRequest("OWNER"),
      env: {
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
      },
    });

    expect(plan.status).toBe("skipped");
    expect(plan.ignoredJobs).toEqual(["not-a-real-e2e-job"]);
  });

  it("collects only recommendations for the target workflow", () => {
    expect(
      collectRecommendedJobs({
        requiredTests: [
          { id: "network-policy-e2e", workflow: "nightly-e2e.yaml" },
          { id: "wsl-e2e", workflow: "wsl-e2e.yaml" },
        ],
      }),
    ).toEqual(["network-policy-e2e"]);
  });

  it("validates safe workflow refs and dispatch inputs", () => {
    expect(validateGitRef("feature/e2e-advisor_123.4")).toBe("feature/e2e-advisor_123.4");
    expect(
      validateDispatchInputs({
        jobs: "network-policy-e2e,cloud_e2e",
        target_ref: "abc123def456",
        pr_number: "123",
        advisor_dispatch_id: "advisor-123-456789",
      }),
    ).toEqual({
      jobs: "network-policy-e2e,cloud_e2e",
      target_ref: "abc123def456",
      pr_number: "123",
      advisor_dispatch_id: "advisor-123-456789",
    });
  });

  it.each([
    "feature/../main",
    "feature//main",
    "feature/branch/",
    "refs/heads/main.lock",
    "feature/branch`echo hi`",
    "feature/branch\nmain",
    "a".repeat(201),
  ])("rejects unsafe workflow ref %j", (ref) => {
    expect(() => validateGitRef(ref)).toThrow(/unsafe workflow ref/);
  });

  it.each([
    {
      jobs: "network-policy-e2e,evil job",
      target_ref: "abc123def456",
      pr_number: "123",
    },
    {
      jobs: "network-policy-e2e",
      target_ref: "feature/../main",
      pr_number: "123",
    },
    {
      jobs: "network-policy-e2e",
      target_ref: "feature/branch`echo hi`",
      pr_number: "123",
    },
    {
      jobs: "network-policy-e2e",
      target_ref: "feature/branch\nmain",
      pr_number: "123",
    },
    {
      jobs: "network-policy-e2e",
      target_ref: "a".repeat(201),
      pr_number: "123",
    },
    {
      jobs: "network-policy-e2e",
      target_ref: "abc123def456",
      pr_number: "123abc",
    },
    {
      jobs: "network-policy-e2e",
      target_ref: "abc123def456",
      pr_number: "123",
      advisor_dispatch_id: "advisor/123",
    },
  ])("rejects unsafe dispatch inputs %#", (inputs) => {
    expect(() => validateDispatchInputs(inputs)).toThrow(/Refusing to dispatch unsafe/);
  });
});
