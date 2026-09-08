// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import {
  ADVISOR_REPAIR_E2E_JOB_NAMES,
  ADVISOR_REPAIR_HEAD_WORKFLOWS,
  ADVISOR_REPAIR_PREREQUISITE_WORKFLOWS,
  advisorRepairE2eDispatchRequest,
  type GitHubRequest,
  waitForAdvisorRepairHead,
} from "../../../tools/pr-review-advisor/repair-publish.mts";

type LocatorStep = {
  env?: Record<string, string>;
  name?: string;
  run?: string;
};

const sourceRun = {
  id: 77,
  run_attempt: 2,
  repository: { full_name: "NVIDIA/NemoClaw" },
  workflow_id: 123,
  name: "Automation / PR Review Advisor",
  path: ".github/workflows/pr-review-advisor.yaml",
  event: "workflow_dispatch",
  status: "completed",
  conclusion: "success",
  head_branch: "main",
  head_sha: "a".repeat(40),
};
const sourceWorkflow = { id: 123 };
const sourceArtifact = {
  id: 456,
  name: "advisor-repair-generated-head-request-77-2",
  expired: false,
  workflow_run: { id: 77 },
};

function locatorStep(): LocatorStep {
  const workflow = YAML.parse(
    readFileSync(".github/workflows/pr-review-advisor-generated-head.yaml", "utf8"),
  ) as { jobs: { locate: { steps: LocatorStep[] } } };
  const selected = workflow.jobs.locate.steps.find(
    ({ name }) => name === "Validate the source run and locate its exact request artifact",
  );
  expect(selected?.run).toBeTruthy();
  return selected as LocatorStep;
}

function runLocator(
  input: {
    artifacts?: unknown[];
    run?: Record<string, unknown>;
    workflow?: Record<string, unknown>;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "nemoclaw-advisor-source-run-"));
  const fakeBin = join(root, "bin");
  const output = join(root, "output");
  mkdirSync(fakeBin);
  writeFileSync(output, "");
  writeFileSync(
    join(fakeBin, "gh"),
    [
      "#!/usr/bin/env node",
      'const endpoint = process.argv.find((value) => value.startsWith("repos/")) ?? "";',
      'if (endpoint.includes("/artifacts?")) process.stdout.write(process.env.FAKE_ARTIFACT_PAGES);',
      'else if (endpoint.includes("/actions/runs/")) process.stdout.write(process.env.FAKE_RUN);',
      'else if (endpoint.includes("/actions/workflows/")) process.stdout.write(process.env.FAKE_WORKFLOW);',
      "else process.exit(64);",
    ].join("\n"),
    { mode: 0o755 },
  );
  const result = spawnSync("bash", ["-c", locatorStep().run ?? ""], {
    cwd: root,
    encoding: "utf8",
    timeout: 5_000,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      EVENT_SOURCE_RUN_ATTEMPT: "",
      EVENT_SOURCE_RUN_ID: "",
      EVENT_SOURCE_WORKFLOW_SHA: "",
      INPUT_SOURCE_RUN_ATTEMPT: "2",
      INPUT_SOURCE_RUN_ID: "77",
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
      RUNNER_TEMP: root,
      FAKE_RUN: JSON.stringify({ ...sourceRun, ...input.run }),
      FAKE_WORKFLOW: JSON.stringify({ ...sourceWorkflow, ...input.workflow }),
      FAKE_ARTIFACT_PAGES: JSON.stringify([{ artifacts: input.artifacts ?? [sourceArtifact] }]),
    },
  });
  const outputs = readFileSync(output, "utf8");
  rmSync(root, { recursive: true, force: true });
  return { outputs, status: result.status };
}

describe("PR Review Advisor generated-head evidence", () => {
  // source-shape-contract: security -- Manual recovery must stay on trusted main and bind the exact successful canonical source run and attempt before dispatching generated-head checks.
  it("allows only trusted-main manual reconciliation of an exact source run (#10791)", () => {
    const workflow = YAML.parse(
      readFileSync(".github/workflows/pr-review-advisor-generated-head.yaml", "utf8"),
    ) as {
      on?: { workflow_dispatch?: { inputs?: Record<string, { required?: boolean }> } };
      concurrency?: { group?: string };
      jobs?: Record<string, { if?: string }>;
    };
    const serialized = JSON.stringify(workflow);

    expect(workflow.on?.workflow_dispatch?.inputs).toEqual(
      expect.objectContaining({
        source_run_attempt: expect.objectContaining({ required: true }),
        source_run_id: expect.objectContaining({ required: true }),
      }),
    );
    expect(String(workflow.concurrency?.group)).toContain("inputs.source_run_id");
    expect(String(workflow.jobs?.locate?.if)).toContain("github.ref == 'refs/heads/main'");
    expect(serialized).toContain("EVENT_SOURCE_WORKFLOW_SHA");
    expect(serialized).toContain("needs.locate.outputs.source-workflow-sha");
    expect(serialized).toContain("needs.locate.outputs.source-run-id");
    expect(serialized).toContain("source-artifact-pages.json");
  });

  it("emits the exact trusted source run and artifact identity (#10791)", () => {
    const result = runLocator();
    expect(result.status).toBe(0);
    expect(result.outputs.trim().split("\n")).toEqual([
      "artifact-id=456",
      "source-run-attempt=2",
      "source-run-id=77",
      `source-workflow-sha=${"a".repeat(40)}`,
    ]);
  });

  it.each([
    ["wrong workflow ID", { run: { workflow_id: 999 } }],
    ["wrong workflow path", { run: { path: ".github/workflows/pr.yaml" } }],
    ["wrong repository", { run: { repository: { full_name: "someone/fork" } } }],
    ["wrong event", { run: { event: "pull_request_target" } }],
    ["wrong attempt", { run: { run_attempt: 3 } }],
    ["invalid workflow SHA", { run: { head_sha: "not-a-sha" } }],
    ["expired artifact", { artifacts: [{ ...sourceArtifact, expired: true }] }],
    ["artifact from another run", { artifacts: [{ ...sourceArtifact, workflow_run: { id: 78 } }] }],
    ["missing artifact", { artifacts: [] }],
    ["ambiguous artifacts", { artifacts: [sourceArtifact, { ...sourceArtifact, id: 457 }] }],
  ])("rejects a %s without emitting locator outputs (#10791)", (_name, input) => {
    const result = runLocator(input);
    expect(result.status).not.toBe(0);
    expect(result.outputs).toBe("");
  });

  it("accepts only successful same-attempt workflows with exact repair receipts (#10791)", async () => {
    const selection = {
      prNumber: 10791,
      repository: "NVIDIA/NemoClaw",
      headRef: "repair-head",
      sourceHeadSha: "1".repeat(40),
      baseSha: "2".repeat(40),
      attemptKey: `sha256:${"3".repeat(64)}`,
    };
    const generatedHeadSha = "4".repeat(40);
    const pull = {
      number: selection.prNumber,
      state: "open",
      draft: false,
      head: {
        ref: selection.headRef,
        sha: generatedHeadSha,
        repo: { full_name: selection.repository },
      },
      base: {
        ref: "main",
        sha: selection.baseSha,
        repo: { full_name: selection.repository },
      },
    };
    const runName = `Repair validation ${selection.attemptKey} head ${generatedHeadSha}`;
    const receiptName = `Repair receipt ${selection.attemptKey} PR ${selection.prNumber} head ${generatedHeadSha} base ${selection.baseSha}`;
    let failedWorkflow: string | undefined;
    let correlationMode: "one" | "zero" | "ambiguous" = "one";
    let mismatchedReceipt = false;
    let changedPaths: string[] = [];
    let e2eConclusion = "success";
    let e2eMatrixConclusion = "success";
    let e2eJobMode: "duplicate" | "failure" | "missing" | "skipped" | "success" = "success";
    const e2eRunId = 99;
    const e2eCorrelationId = "01234567-89ab-4cde-8fab-0123456789ab";
    const e2eUrl = `https://github.com/${selection.repository}/actions/runs/${e2eRunId}`;
    const dispatchedWorkflows = new Set<string>();
    const dispatchE2e = vi.fn(async () => ({
      runId: e2eRunId,
      source: "dispatch-response" as const,
    }));
    const request = vi.fn(
      async (method: string, apiPath: string, body?: unknown): Promise<unknown> => {
        const workflow = [
          ...ADVISOR_REPAIR_HEAD_WORKFLOWS.map(({ workflow }) => workflow),
          ...ADVISOR_REPAIR_PREREQUISITE_WORKFLOWS,
        ].find((candidate) => apiPath.includes(`/workflows/${candidate}/dispatches`));
        const workflowRunsMatch = apiPath.match(/\/actions\/workflows\/([^/]+)\/runs[?]/u);
        const runMatch = apiPath.match(/\/actions\/runs\/(\d+)$/u);
        const jobsMatch = apiPath.match(/\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs/u);
        switch (true) {
          case apiPath.endsWith(`/pulls/${selection.prNumber}`):
            return pull;
          case method === "GET" && workflowRunsMatch !== null: {
            const workflowName = workflowRunsMatch[1] as string;
            const prerequisite = ADVISOR_REPAIR_PREREQUISITE_WORKFLOWS.some(
              (candidate) => candidate === workflowName,
            );
            const runId = prerequisite
              ? 0
              : ADVISOR_REPAIR_HEAD_WORKFLOWS.findIndex((item) => item.workflow === workflowName) +
                1;
            const run: Record<string, unknown> = prerequisite
              ? {}
              : ((await request(
                  "GET",
                  `/repos/${selection.repository}/actions/runs/${runId}`,
                )) as Record<string, unknown>);
            const runs: Record<string, unknown>[] =
              !prerequisite && dispatchedWorkflows.has(workflowName) && correlationMode !== "zero"
                ? [run]
                : [];
            return {
              workflow_runs:
                correlationMode === "ambiguous" && runs.length === 1 ? [...runs, run] : runs,
            };
          }
          case method === "POST" && workflow !== undefined: {
            const dispatch = body as { ref?: unknown; inputs?: Record<string, unknown> };
            expect(dispatch.ref).toBe("main");
            expect(dispatch.inputs).toMatchObject({
              repair_head_sha: generatedHeadSha,
              repair_base_sha: selection.baseSha,
              repair_attempt_key: selection.attemptKey,
            });
            expect(
              ["pr.yaml", "openshell-sdk-package-pr.yaml"].includes(workflow)
                ? dispatch.inputs?.repair_source_head_sha
                : selection.sourceHeadSha,
            ).toBe(selection.sourceHeadSha);
            dispatchedWorkflows.add(workflow);
            return {};
          }
          case method === "GET" && apiPath.endsWith(`/actions/runs/${e2eRunId}`):
            return {
              id: e2eRunId,
              event: "workflow_dispatch",
              path: ".github/workflows/e2e.yaml",
              status: "completed",
              conclusion: e2eConclusion,
              display_title: `E2E PR #${selection.prNumber} (${e2eCorrelationId})`,
              head_branch: "main",
              head_sha: "5".repeat(40),
              html_url: e2eUrl,
              run_attempt: 1,
            };
          case method === "GET" && apiPath.includes(`/actions/runs/${e2eRunId}/attempts/1/jobs`): {
            const successfulRequiredE2eJobs = [
              ...ADVISOR_REPAIR_E2E_JOB_NAMES["onboard-repair"],
              ...ADVISOR_REPAIR_E2E_JOB_NAMES["onboard-resume"],
            ].map((name, index) => ({
              id: 992 + index,
              name,
              status: "completed",
              conclusion: "success",
              html_url: `${e2eUrl}/job/${992 + index}`,
              run_attempt: 1,
            }));
            const firstRequiredE2eJob = successfulRequiredE2eJobs[0]!;
            const requiredE2eJobs = {
              duplicate: [...successfulRequiredE2eJobs, { ...firstRequiredE2eJob }],
              failure: [
                { ...firstRequiredE2eJob, conclusion: "failure" },
                ...successfulRequiredE2eJobs.slice(1),
              ],
              missing: successfulRequiredE2eJobs.slice(1),
              skipped: [
                { ...firstRequiredE2eJob, conclusion: "skipped" },
                ...successfulRequiredE2eJobs.slice(1),
              ],
              success: successfulRequiredE2eJobs,
            }[e2eJobMode];
            return {
              total_count: 1 + requiredE2eJobs.length,
              jobs: [
                {
                  id: 991,
                  name: "generate-matrix",
                  status: "completed",
                  conclusion: e2eMatrixConclusion,
                  html_url: `${e2eUrl}/job/991`,
                  run_attempt: 1,
                },
                ...requiredE2eJobs,
              ],
            };
          }
          case method === "GET" && runMatch !== null: {
            const runId = Number(runMatch[1]);
            const specification = ADVISOR_REPAIR_HEAD_WORKFLOWS[runId - 1];
            expect(specification).toBeDefined();
            return {
              id: runId,
              event: "workflow_dispatch",
              path: `.github/workflows/${specification?.workflow}`,
              status: "completed",
              conclusion: specification?.workflow === failedWorkflow ? "failure" : "success",
              display_title: runName,
              head_branch: "main",
              head_sha: "5".repeat(40),
              html_url: `https://github.com/${selection.repository}/actions/runs/${runId}`,
              run_attempt: 1,
            };
          }
          case method === "GET" && jobsMatch !== null: {
            const runId = Number(jobsMatch[1]);
            const specification = ADVISOR_REPAIR_HEAD_WORKFLOWS[runId - 1];
            expect(specification).toBeDefined();
            expect(Number(jobsMatch[2])).toBe(1);
            return {
              jobs: [
                {
                  id: runId * 10,
                  name: mismatchedReceipt ? `${receiptName}-mismatch` : receiptName,
                  status: "completed",
                  conclusion: "success",
                  html_url: `https://github.com/${selection.repository}/actions/runs/${runId}/job/${runId * 10}`,
                  run_attempt: 1,
                },
                ...(specification?.checks ?? []).map((name, index) => ({
                  id: runId * 10 + index + 1,
                  name,
                  status: "completed",
                  conclusion: "success",
                  html_url: `https://github.com/${selection.repository}/actions/runs/${runId}/job/${runId * 10 + index + 1}`,
                  run_attempt: 1,
                })),
              ],
            };
          }
          case method === "GET" && apiPath.includes("/check-runs?"):
            return { check_runs: [] };
          case method === "POST" && apiPath.endsWith("/check-runs"): {
            const check = body as { name: string; details_url: string; external_id: string };
            return {
              id: 100 + request.mock.calls.filter(([called]) => called === "POST").length,
              name: check.name,
              external_id: check.external_id,
              conclusion: "success",
              details_url: check.details_url,
              html_url: `https://github.com/${selection.repository}/runs/check/${check.name}`,
            };
          }
          default:
            throw new Error(`unexpected request: ${method} ${apiPath}`);
        }
      },
    );
    const verify = () =>
      waitForAdvisorRepairHead({
        prNumber: selection.prNumber,
        sourceHeadSha: selection.sourceHeadSha,
        baseSha: selection.baseSha,
        generatedHeadSha,
        workflowSha: "5".repeat(40),
        changedPaths,
        attemptKey: selection.attemptKey,
        request: request as GitHubRequest,
        token: "token",
        dispatchE2e,
        correlationId: () => e2eCorrelationId,
        attempts: 1,
      });

    await expect(verify()).resolves.toMatchObject({
      version: 2,
      outcome: "success",
      workflows: { length: 6 },
      riskPlan: { requiredJobs: [] },
      e2e: null,
      checks: { length: 5 },
    });
    expect(dispatchE2e).not.toHaveBeenCalled();
    expect(dispatchedWorkflows).toContain("openshell-sdk-package-pr.yaml");
    failedWorkflow = "pr.yaml";
    dispatchedWorkflows.clear();
    await expect(verify()).rejects.toThrow("generated-head pr.yaml run failed");
    failedWorkflow = undefined;
    mismatchedReceipt = true;
    dispatchedWorkflows.clear();
    await expect(verify()).rejects.toThrow("Repair receipt");
    mismatchedReceipt = false;
    correlationMode = "zero";
    dispatchedWorkflows.clear();
    await expect(verify()).rejects.toThrow("did not finish");
    correlationMode = "ambiguous";
    dispatchedWorkflows.clear();
    await expect(verify()).rejects.toThrow("run identity is ambiguous");
    correlationMode = "one";
    changedPaths = ["src/lib/onboard/sandbox-create-step.ts"];
    dispatchedWorkflows.clear();
    await expect(verify()).resolves.toMatchObject({
      version: 2,
      outcome: "success",
      riskPlan: { requiredJobs: ["onboard-repair", "onboard-resume"] },
      e2e: {
        correlationId: e2eCorrelationId,
        runId: e2eRunId,
        receipt: { name: `e2e-dispatch-${e2eRunId}-1` },
        requiredJobs: ["onboard-repair", "onboard-resume"],
        jobs: [
          { name: ADVISOR_REPAIR_E2E_JOB_NAMES["onboard-repair"][0] },
          { name: ADVISOR_REPAIR_E2E_JOB_NAMES["onboard-resume"][0] },
        ],
      },
      checks: { length: 6 },
    });
    expect(dispatchE2e).toHaveBeenLastCalledWith(
      expect.objectContaining({
        generatedHeadSha,
        requiredJobs: ["onboard-repair", "onboard-resume"],
        correlationId: e2eCorrelationId,
      }),
    );
    e2eConclusion = "failure";
    dispatchedWorkflows.clear();
    await expect(verify()).rejects.toThrow("generated-head E2E run failed");
    e2eConclusion = "success";
    e2eMatrixConclusion = "failure";
    dispatchedWorkflows.clear();
    await expect(verify()).rejects.toThrow(
      "generated-head E2E generate-matrix job did not succeed",
    );
    e2eMatrixConclusion = "success";
    e2eJobMode = "missing";
    dispatchedWorkflows.clear();
    await expect(verify()).rejects.toThrow("generated-head E2E job");
    e2eJobMode = "skipped";
    dispatchedWorkflows.clear();
    await expect(verify()).rejects.toThrow("generated-head E2E job");
    e2eJobMode = "failure";
    dispatchedWorkflows.clear();
    await expect(verify()).rejects.toThrow("generated-head E2E job");
    e2eJobMode = "duplicate";
    dispatchedWorkflows.clear();
    await expect(verify()).rejects.toThrow("generated-head E2E job");
  });

  it("dispatches only the trusted exact generated-head E2E selection (#10791)", () => {
    expect(
      advisorRepairE2eDispatchRequest({
        prNumber: 10791,
        generatedHeadSha: "1".repeat(40),
        baseSha: "2".repeat(40),
        workflowSha: "3".repeat(40),
        correlationId: "01234567-89ab-4cde-8fab-0123456789ab",
        requiredJobs: ["onboard-repair", "onboard-resume"],
      }),
    ).toEqual({
      ref: "main",
      inputs: {
        targets: "",
        jobs: "onboard-repair,onboard-resume",
        include_staging_brev_launchable: false,
        inference_mode: "mock",
        gateway_runtime: "docker",
        gateway_runtimes: "",
        allow_jetson_dispatch: false,
        allow_dgx_spark_runner_queue: false,
        pr_number: "10791",
        post_to_slack: false,
        checkout_sha: "1".repeat(40),
        checkout_repository: "NVIDIA/NemoClaw",
        base_sha: "2".repeat(40),
        workflow_sha: "3".repeat(40),
        managed_image_revision: "",
        correlation_id: "01234567-89ab-4cde-8fab-0123456789ab",
      },
    });
  });
});
