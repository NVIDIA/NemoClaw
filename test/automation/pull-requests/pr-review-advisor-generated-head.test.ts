// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import {
  ADVISOR_REPAIR_HEAD_WORKFLOWS,
  ADVISOR_REPAIR_PREREQUISITE_WORKFLOWS,
  advisorRepairCorrelationId,
  advisorRepairE2eDispatchRequest,
  createAdvisorRepairHeadCheckpoint,
  dispatchAdvisorRepairE2e,
  e2eControllerDeadlineMinutesForSelectors,
  type GitHubRequest,
  waitForAdvisorRepairHead,
} from "../../../tools/pr-review-advisor/repair-publish.mts";
import {
  buildE2eWorkflowPlan,
  e2eEvidenceJobNames,
  e2eEvidenceJobNamesForSelectors,
} from "../../../tools/e2e/workflow-plan.mts";
import { validateE2eWorkflowBoundary } from "../../../tools/e2e/workflow-boundary.mts";

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
const validationWorkflowSha = "b".repeat(40);

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
    mainRef?: Record<string, unknown>;
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
      'else if (endpoint.includes("/git/ref/heads/main")) process.stdout.write(process.env.FAKE_MAIN_REF);',
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
      VALIDATION_WORKFLOW_SHA: validationWorkflowSha,
      SOURCE_RUN_ATTEMPT: "2",
      SOURCE_RUN_ID: "77",
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
      RUNNER_TEMP: root,
      FAKE_RUN: JSON.stringify({ ...sourceRun, ...input.run }),
      FAKE_WORKFLOW: JSON.stringify({ ...sourceWorkflow, ...input.workflow }),
      FAKE_MAIN_REF: JSON.stringify(
        input.mainRef ?? { object: { type: "commit", sha: validationWorkflowSha } },
      ),
      FAKE_ARTIFACT_PAGES: JSON.stringify([{ artifacts: input.artifacts ?? [sourceArtifact] }]),
    },
  });
  const outputs = readFileSync(output, "utf8");
  rmSync(root, { recursive: true, force: true });
  return { outputs, status: result.status };
}

function runRepairTargetValidator(
  input: { env?: Record<string, string>; pullRequest?: Record<string, unknown> } = {},
) {
  const workflow = YAML.parse(
    readFileSync(".github/workflows/validate-repair-target.yaml", "utf8"),
  ) as { jobs: { validate: { steps: LocatorStep[] } } };
  const step = workflow.jobs.validate.steps.find(
    ({ name }) => name === "Bind validation to the live generated head",
  );
  expect(step?.run).toBeTruthy();
  const root = mkdtempSync(join(tmpdir(), "nemoclaw-advisor-repair-target-"));
  const fakeBin = join(root, "bin");
  mkdirSync(fakeBin);
  writeFileSync(
    join(fakeBin, "gh"),
    ["#!/usr/bin/env node", "process.stdout.write(process.env.FAKE_PR);"].join("\n"),
    { mode: 0o755 },
  );
  const head = "1".repeat(40);
  const base = "2".repeat(40);
  const result = spawnSync("bash", ["-c", step?.run ?? ""], {
    cwd: root,
    encoding: "utf8",
    timeout: 5_000,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      GITHUB_REF: "refs/heads/main",
      GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
      GH_TOKEN: "token",
      PR_NUMBER: "11073",
      HEAD_SHA: head,
      BASE_SHA: base,
      REPAIR_ATTEMPT_KEY: `sha256:${"3".repeat(64)}`,
      FAKE_PR: JSON.stringify({
        state: "open",
        draft: false,
        head: { sha: head, repo: { full_name: "NVIDIA/NemoClaw" } },
        base: { sha: base, ref: "main", repo: { full_name: "NVIDIA/NemoClaw" } },
        ...input.pullRequest,
      }),
      ...input.env,
    },
  });
  rmSync(root, { recursive: true, force: true });
  return result.status;
}

describe("PR Review Advisor generated-head evidence", () => {
  // source-shape-contract: security -- Manual recovery must stay on trusted main and bind the exact successful canonical source run and attempt before dispatching generated-head checks.
  it("allows only trusted-main manual reconciliation of an exact source run (#10791)", () => {
    const workflow = YAML.parse(
      readFileSync(".github/workflows/pr-review-advisor-generated-head.yaml", "utf8"),
    ) as {
      on?: {
        workflow_dispatch?: { inputs?: Record<string, { required?: boolean }> };
        workflow_run?: unknown;
      };
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
    expect(workflow.on?.workflow_run).toBeUndefined();
    expect(String(workflow.concurrency?.group)).toContain("inputs.source_run_id");
    expect(String(workflow.jobs?.locate?.if)).toContain("github.ref == 'refs/heads/main'");
    expect(serialized).not.toContain("github.event.workflow_run");
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
      `validation-workflow-sha=${validationWorkflowSha}`,
    ]);
  });

  it.each([
    ["wrong workflow ID", { run: { workflow_id: 999 } }],
    ["wrong workflow path", { run: { path: ".github/workflows/pr.yaml" } }],
    ["wrong repository", { run: { repository: { full_name: "someone/fork" } } }],
    ["wrong event", { run: { event: "pull_request_target" } }],
    ["wrong attempt", { run: { run_attempt: 3 } }],
    ["invalid workflow SHA", { run: { head_sha: "not-a-sha" } }],
    ["changed trusted main", { mainRef: { object: { type: "commit", sha: "c".repeat(40) } } }],
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
    let prerequisiteStatus: "completed" | "queued" = "completed";
    let workflowHeadSha = "5".repeat(40);
    let correlationMode: "one" | "zero" | "ambiguous" = "one";
    let mismatchedReceipt = false;
    let paginateWorkflowJobs = false;
    let changedPaths: string[] = [];
    const dispatchedWorkflows = new Set<string>();
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
            const prerequisite = (
              ADVISOR_REPAIR_PREREQUISITE_WORKFLOWS as readonly string[]
            ).includes(workflowName);
            const runId = prerequisite
              ? ADVISOR_REPAIR_HEAD_WORKFLOWS.length + 1
              : ADVISOR_REPAIR_HEAD_WORKFLOWS.findIndex((item) => item.workflow === workflowName) +
                1;
            const run = (await request(
              "GET",
              `/repos/${selection.repository}/actions/runs/${runId}`,
            )) as Record<string, unknown>;
            const runs: Record<string, unknown>[] =
              dispatchedWorkflows.has(workflowName) && correlationMode !== "zero" ? [run] : [];
            return {
              workflow_runs:
                correlationMode === "ambiguous" && runs.length === 1 ? [...runs, run] : runs,
            };
          }
          case method === "POST" && workflow !== undefined: {
            const dispatch = body as {
              ref?: unknown;
              return_run_details?: unknown;
              inputs?: Record<string, unknown>;
            };
            expect(dispatch.ref).toBe("main");
            expect(dispatch.return_run_details).toBe(true);
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
            const prerequisite = ADVISOR_REPAIR_PREREQUISITE_WORKFLOWS.some(
              (candidate) => candidate === workflow,
            );
            const runId = prerequisite
              ? ADVISOR_REPAIR_HEAD_WORKFLOWS.length + 1
              : ADVISOR_REPAIR_HEAD_WORKFLOWS.findIndex((item) => item.workflow === workflow) + 1;
            return {
              workflow_run_id: runId,
              run_url: `https://api.github.com/repos/${selection.repository}/actions/runs/${runId}`,
              html_url: `https://github.com/${selection.repository}/actions/runs/${runId}`,
            };
          }
          case method === "GET" && runMatch !== null: {
            const runId = Number(runMatch[1]);
            const specification = ADVISOR_REPAIR_HEAD_WORKFLOWS[runId - 1];
            const workflowName =
              specification?.workflow ?? ADVISOR_REPAIR_PREREQUISITE_WORKFLOWS[0];
            const prerequisite = (
              ADVISOR_REPAIR_PREREQUISITE_WORKFLOWS as readonly string[]
            ).includes(workflowName);
            return {
              id: runId,
              event: "workflow_dispatch",
              path: `.github/workflows/${workflowName}`,
              status: prerequisite ? prerequisiteStatus : "completed",
              conclusion:
                prerequisite && prerequisiteStatus !== "completed"
                  ? null
                  : workflowName === failedWorkflow
                    ? "failure"
                    : "success",
              display_title: runName,
              head_branch: "main",
              head_sha: workflowHeadSha,
              html_url: `https://github.com/${selection.repository}/actions/runs/${runId}`,
              run_attempt: 1,
            };
          }
          case method === "GET" && jobsMatch !== null: {
            const runId = Number(jobsMatch[1]);
            const specification = ADVISOR_REPAIR_HEAD_WORKFLOWS[runId - 1];
            expect(specification).toBeDefined();
            expect(Number(jobsMatch[2])).toBe(1);
            const jobs = [
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
            ];
            const page = Number(
              new URL(apiPath, "https://api.github.test").searchParams.get("page"),
            );
            const filler = Array.from({ length: 100 }, (_, index) => ({
              id: runId * 10_000 + index,
              name: `unrelated-${index}`,
            }));
            return paginateWorkflowJobs
              ? { total_count: filler.length + jobs.length, jobs: page === 1 ? filler : jobs }
              : { total_count: jobs.length, jobs };
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
    const verify = (checkpoint = createAdvisorRepairHeadCheckpoint()) =>
      waitForAdvisorRepairHead({
        prNumber: selection.prNumber,
        sourceHeadSha: selection.sourceHeadSha,
        baseSha: selection.baseSha,
        generatedHeadSha,
        workflowSha: "5".repeat(40),
        changedPaths,
        attemptKey: selection.attemptKey,
        request: request as GitHubRequest,
        attempts: 1,
        checkpoint,
      });

    await expect(verify()).resolves.toMatchObject({
      version: 3,
      outcome: "success",
      workflows: { length: 6 },
      riskPlan: { requiredJobs: [] },
      e2e: null,
      checks: { length: 5 },
      checkpoint: { workflows: { length: 7 }, e2e: null },
    });
    expect(dispatchedWorkflows).toContain("openshell-sdk-package-pr.yaml");
    const workflowDispatchCalls = () =>
      request.mock.calls.filter(
        ([method, apiPath]) => method === "POST" && String(apiPath).endsWith("/dispatches"),
      ).length;
    const checkRunPublicationCalls = () =>
      request.mock.calls.filter(
        ([method, apiPath]) => method === "POST" && String(apiPath).endsWith("/check-runs"),
      ).length;
    const dispatchCount = workflowDispatchCalls();
    await expect(verify()).resolves.toMatchObject({ outcome: "success" });
    expect(workflowDispatchCalls()).toBe(dispatchCount);
    paginateWorkflowJobs = true;
    await expect(verify()).resolves.toMatchObject({ outcome: "success" });
    expect(request.mock.calls.some(([, apiPath]) => String(apiPath).includes("page=2"))).toBe(true);
    paginateWorkflowJobs = false;
    const publishedChecks = checkRunPublicationCalls();
    prerequisiteStatus = "queued";
    dispatchedWorkflows.clear();
    await expect(verify()).rejects.toThrow(
      "generated-head validation did not finish before its controller deadline",
    );
    expect(checkRunPublicationCalls()).toBe(publishedChecks);
    prerequisiteStatus = "completed";
    changedPaths = ["src/lib/credentials/example.ts"];
    dispatchedWorkflows.clear();
    await expect(verify()).rejects.toThrow(
      "generated-head repair validation requires credential-bearing E2E job cloud-inference",
    );
    expect(dispatchedWorkflows.size).toBe(0);
    changedPaths = ["src/lib/platform.ts"];
    dispatchedWorkflows.clear();
    await expect(verify()).rejects.toThrow(
      "generated-head repair validation requires credential-bearing E2E job cloud-onboard",
    );
    expect(dispatchedWorkflows.size).toBe(0);
    changedPaths = ["src/lib/onboard/sandbox-create-step.ts"];
    dispatchedWorkflows.clear();
    await expect(verify()).rejects.toThrow(
      "generated-head repair validation requires credential-bearing E2E job onboard-repair",
    );
    expect(dispatchedWorkflows.size).toBe(0);
    changedPaths = [];
    workflowHeadSha = "6".repeat(40);
    dispatchedWorkflows.clear();
    await expect(verify()).rejects.toThrow("dispatched run identity is invalid");
    workflowHeadSha = "5".repeat(40);
    failedWorkflow = "pr.yaml";
    dispatchedWorkflows.clear();
    const failureCheckpoint = createAdvisorRepairHeadCheckpoint();
    await expect(verify(failureCheckpoint)).rejects.toThrow("generated-head pr.yaml run failed");
    expect(failureCheckpoint.workflows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workflow: "pr.yaml",
          runId: 1,
          status: "completed",
          conclusion: "failure",
        }),
      ]),
    );
    failedWorkflow = undefined;
    mismatchedReceipt = true;
    dispatchedWorkflows.clear();
    await expect(verify()).rejects.toThrow("Repair receipt");
    mismatchedReceipt = false;
    correlationMode = "zero";
    dispatchedWorkflows.clear();
    await expect(verify()).resolves.toMatchObject({ outcome: "success" });
    correlationMode = "ambiguous";
    dispatchedWorkflows.clear();
    dispatchedWorkflows.add("openshell-sdk-package-pr.yaml");
    await expect(verify()).rejects.toThrow("run identity is ambiguous");
    correlationMode = "one";
    changedPaths = ["src/lib/inference/health.ts"];
    dispatchedWorkflows.clear();
    await expect(verify()).rejects.toThrow(
      "generated-head repair validation requires credential-bearing E2E job inference-routing",
    );
    expect(dispatchedWorkflows.size).toBe(0);
  });

  it("derives stable dispatch identity and a deadline beyond the selected dependency graph (#10791)", () => {
    const attemptKey = `sha256:${"a".repeat(64)}`;
    const head = "b".repeat(40);
    expect(advisorRepairCorrelationId(attemptKey, head)).toBe(
      advisorRepairCorrelationId(attemptKey, head),
    );
    expect(advisorRepairCorrelationId(attemptKey, "c".repeat(40))).not.toBe(
      advisorRepairCorrelationId(attemptKey, head),
    );
    expect(e2eControllerDeadlineMinutesForSelectors(["cloud-onboard"])).toBe(150);
    expect(e2eControllerDeadlineMinutesForSelectors(["managed-image-protected-runtime"])).toBe(365);
  });

  it("routes every repair workflow through one executable trusted target gate (#10791)", () => {
    const workflowPaths = [
      "code-scanning.yaml",
      "commit-lint.yaml",
      "dco-check.yaml",
      "installer-hash-check.yaml",
      "pr.yaml",
      "pr-review-advisor.yaml",
    ];
    const workflows = workflowPaths.map((name) =>
      YAML.parse(readFileSync(`.github/workflows/${name}`, "utf8")),
    ) as Array<{
      jobs: Record<string, { if?: string; uses?: string; "timeout-minutes"?: number }>;
    }>;
    expect(workflows.map(({ jobs }) => jobs["validate-repair-target"]?.uses)).toEqual(
      Array.from({ length: 6 }, () => "./.github/workflows/validate-repair-target.yaml"),
    );
    expect(workflows.map(({ jobs }) => jobs["validate-repair-target"]?.if)).toEqual(
      Array.from({ length: 6 }, () => undefined),
    );
    expect(runRepairTargetValidator()).toBe(0);
    expect(runRepairTargetValidator({ env: { GITHUB_REF: "refs/heads/topic" } })).not.toBe(0);
    expect(runRepairTargetValidator({ env: { REPAIR_ATTEMPT_KEY: "invalid" } })).not.toBe(0);
    expect(runRepairTargetValidator({ pullRequest: { draft: true } })).not.toBe(0);
    expect(runRepairTargetValidator({ pullRequest: { head: { sha: "4".repeat(40) } } })).not.toBe(
      0,
    );
  });

  it("derives E2E evidence names from the trusted plan rather than a repair map (#10791)", () => {
    const plan = buildE2eWorkflowPlan({ jobs: "onboard-repair" }, { gatewayRuntimes: ["docker"] });
    const changed = structuredClone(plan);
    changed.catalogueMatrices.standard[0]!.display_name = "Renamed onboarding repair evidence";
    expect(e2eEvidenceJobNames(changed)).toContain("Renamed onboarding repair evidence (docker)");
  });

  it("dispatches only the trusted exact generated-head E2E selection (#10791)", () => {
    expect(
      advisorRepairE2eDispatchRequest({
        prNumber: 10791,
        generatedHeadSha: "1".repeat(40),
        baseSha: "2".repeat(40),
        workflowSha: "3".repeat(40),
        correlationId: "01234567-89ab-4cde-8fab-0123456789ab",
        attemptKey: `sha256:${"4".repeat(64)}`,
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
        repair_validation: true,
        repair_attempt_key: `sha256:${"4".repeat(64)}`,
      },
    });
  });

  it("adopts the existing deterministic E2E run instead of dispatching it again (#10791)", async () => {
    const prNumber = 10791;
    const generatedHeadSha = "1".repeat(40);
    const workflowSha = "3".repeat(40);
    const attemptKey = `sha256:${"4".repeat(64)}`;
    const correlationId = advisorRepairCorrelationId(attemptKey, generatedHeadSha);
    const runId = 991;
    const request = vi.fn(async () => ({
      workflow_runs: [
        {
          id: runId,
          event: "workflow_dispatch",
          path: ".github/workflows/e2e.yaml",
          status: "in_progress",
          conclusion: null,
          display_title: `E2E PR #${prNumber} (${correlationId})`,
          head_branch: "main",
          head_sha: workflowSha,
          html_url: `https://github.com/NVIDIA/NemoClaw/actions/runs/${runId}`,
          run_attempt: 1,
        },
      ],
    }));
    await expect(
      dispatchAdvisorRepairE2e({
        prNumber,
        generatedHeadSha,
        baseSha: "2".repeat(40),
        workflowSha,
        requiredJobs: ["onboard-repair"],
        attemptKey,
        token: "token",
        request: request as GitHubRequest,
      }),
    ).resolves.toEqual({ correlationId, runId, source: "workflow-run-inventory" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("binds representative E2E selectors to fixed workflow evidence names (#10791)", () => {
    expect(e2eEvidenceJobNamesForSelectors(["onboard-repair", "onboard-resume"])).toEqual([
      "Onboarding: Hermes resumes its sandbox and forwards (docker)",
      "Onboarding: repairs a missing sandbox and rejects conflicting resume input (docker)",
      "Onboarding: resumes interrupted setup from recorded progress (docker)",
    ]);
  });

  it("keeps repair-generated E2E non-cancelable and credential-free (#10791)", () => {
    expect(validateE2eWorkflowBoundary()).toEqual([]);
  });
});
