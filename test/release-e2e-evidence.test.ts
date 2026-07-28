// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildReleaseE2eLedger,
  buildReleaseE2ePreflight,
  type ReleaseE2eExecution,
  type ReleaseE2ePreflight,
  type ReleaseE2eRunEvidence,
} from "../.agents/skills/nemoclaw-maintainer-cut-release-tag/scripts/release-e2e-evidence.mts";

const candidateSha = "a".repeat(40);

function preflight(input: { jetsonRunnerOnline?: "true" | "unknown" } = {}) {
  return buildReleaseE2ePreflight({
    candidateSha,
    jetsonRunnerOnline: input.jetsonRunnerOnline ?? "true",
  });
}

function selectedJobs(plan: ReleaseE2ePreflight, group: ReleaseE2eExecution["group"]): string[] {
  return [
    ...new Set(
      plan.executions
        .filter((execution) => execution.group === group)
        .map((execution) => execution.jobId),
    ),
  ];
}

function runEvidence(
  plan: ReleaseE2ePreflight,
  group: ReleaseE2eExecution["group"],
  options: {
    attempt?: number;
    conclusion?: (execution: ReleaseE2eExecution) => string;
    only?: (execution: ReleaseE2eExecution) => boolean;
    sha?: string;
    status?: (execution: ReleaseE2eExecution) => string;
  } = {},
): ReleaseE2eRunEvidence {
  const attempt = options.attempt ?? 1;
  const runId = 1000 + attempt;
  const executions = plan.executions.filter(
    (execution) => execution.group === group && (options.only?.(execution) ?? true),
  );
  const selectors = group === "default" ? [] : selectedJobs(plan, group);
  return {
    dispatch: {
      allowJetsonRunnerQueue: group === "conditional",
      candidateSha,
      defaultSuiteSelected: group === "default",
      eventName: "workflow_dispatch",
      includeStagingBrevLaunchable:
        group === "default" && plan.dispatches.defaultSuite.includeStagingBrevLaunchable,
      jobs: selectors.join(","),
      kind: "nemoclaw-e2e-dispatch-v1",
      targets: "",
      workflowRunAttempt: attempt,
      workflowRunId: String(runId),
    },
    jobs: {
      jobs: executions.map((execution, index) => ({
        conclusion: options.conclusion?.(execution) ?? "success",
        html_url: `https://github.com/NVIDIA/NemoClaw/actions/runs/${runId}/job/${index + 1}`,
        name: execution.expectedName,
        run_attempt: attempt,
        run_id: runId,
        status: options.status?.(execution) ?? "completed",
      })),
    },
    run: {
      event: "workflow_dispatch",
      head_branch: "main",
      id: runId,
      path: ".github/workflows/e2e.yaml",
      run_attempt: attempt,
      head_sha: options.sha ?? candidateSha,
      html_url: `https://github.com/NVIDIA/NemoClaw/actions/runs/${runId}`,
    },
  };
}

describe("release E2E evidence", () => {
  it("derives full, concurrent, conditional, and Launchable E2E work from the workflow", () => {
    const plan = preflight({ jetsonRunnerOnline: "unknown" });

    expect(plan.dispatches.defaultSuite).toEqual({
      includeStagingBrevLaunchable: true,
      jobs: "",
      mode: "full",
      targets: "",
    });
    const parallelExplicitJobs = plan.dispatches.parallelExplicit.jobs.split(",");
    expect(parallelExplicitJobs).toHaveLength(4);
    expect(new Set(parallelExplicitJobs)).toEqual(
      new Set([
        "openshell-gateway-auth-contract",
        "mcp-bridge-dev",
        "hermes-gpu-startup",
        "sandbox-rlimits-connect",
      ]),
    );
    expect(plan.dispatches.conditional).toEqual([
      expect.objectContaining({ allowJetsonRunnerQueue: false, jobs: "jetson-nvmap-gpu" }),
    ]);
    expect(plan.launchableE2eJobId).toBe("staging-brev-launchable");
    expect(plan.exceptionsRequired).toEqual(["jetson-nvmap-gpu"]);
  });

  it("keeps every static and dynamic matrix row as a distinct execution", () => {
    const plan = preflight();
    const ids = plan.executions.map((execution) => execution.id);

    expect(ids.filter((id) => id.startsWith("mcp-bridge-dev["))).toHaveLength(3);
    expect(ids.filter((id) => id.startsWith("hermes-gpu-startup["))).toHaveLength(3);
    expect(ids.filter((id) => id.startsWith("openshell-gateway-upgrade["))).toHaveLength(5);
    expect(ids).toContain("live[id=ubuntu-repo-cloud-openclaw]");
    expect(ids).toContain("shared-e2e[id=vllm-docker-storage]");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("accumulates successful evidence across parallel runs and attempts", () => {
    const plan = preflight();
    const firstDefaultRun = runEvidence(plan, "default");
    const laterFailure = runEvidence(plan, "default", {
      attempt: 2,
      conclusion: () => "failure",
      only: (execution) => execution.id === "snapshot-commands",
    });
    const ledger = buildReleaseE2eLedger(plan, [
      firstDefaultRun,
      runEvidence(plan, "parallel-explicit"),
      runEvidence(plan, "conditional"),
      laterFailure,
    ]);

    expect(ledger.greenCount).toBe(ledger.requiredCount);
    expect(ledger.missingCount).toBe(0);
    expect(ledger.entries.find((entry) => entry.id === "snapshot-commands")).toMatchObject({
      attempts: [
        { attempt: 2, conclusion: "failure" },
        { attempt: 1, conclusion: "success" },
      ],
      greenEvidence: { attempt: 1 },
      status: "green",
    });
  });

  it("reports a failed matrix row without collapsing its successful siblings", () => {
    const plan = preflight();
    const failedId = 'hermes-gpu-startup[scenario="fallback"]';
    const ledger = buildReleaseE2eLedger(plan, [
      runEvidence(plan, "default"),
      runEvidence(plan, "parallel-explicit", {
        conclusion: (execution) => (execution.id === failedId ? "failure" : "success"),
      }),
      runEvidence(plan, "conditional"),
    ]);

    expect(ledger.missingCount).toBe(1);
    expect(ledger.entries.find((entry) => entry.id === failedId)).toMatchObject({
      status: "missing",
      attempts: [{ conclusion: "failure" }],
    });
    expect(
      ledger.entries.find(
        (entry) => entry.id === 'hermes-gpu-startup[scenario="compatibility-only"]',
      ),
    ).toMatchObject({ status: "green" });
  });

  it("does not count an in-progress execution as green", () => {
    const plan = preflight();
    const pendingId = "snapshot-commands";
    const ledger = buildReleaseE2eLedger(plan, [
      runEvidence(plan, "default", {
        status: (execution) => (execution.id === pendingId ? "in_progress" : "completed"),
      }),
      runEvidence(plan, "parallel-explicit"),
      runEvidence(plan, "conditional"),
    ]);

    expect(ledger.missingCount).toBe(1);
    expect(ledger.entries.find((entry) => entry.id === pendingId)).toMatchObject({
      attempts: [{ conclusion: "success", status: "in_progress" }],
      status: "missing",
    });
  });

  it("does not treat a skipped execution as successful evidence", () => {
    const plan = preflight();
    const skippedId = "snapshot-commands";
    const ledger = buildReleaseE2eLedger(plan, [
      runEvidence(plan, "default", {
        conclusion: (execution) => (execution.id === skippedId ? "skipped" : "success"),
      }),
      runEvidence(plan, "parallel-explicit"),
      runEvidence(plan, "conditional"),
    ]);

    expect(ledger.entries.find((entry) => entry.id === skippedId)).toMatchObject({
      attempts: [{ conclusion: "skipped", status: "completed" }],
      status: "missing",
    });
  });

  it("ignores job evidence from another workflow run", () => {
    const plan = preflight();
    const evidence = runEvidence(plan, "default");
    const ignoredId = plan.executions.find((execution) => execution.group === "default")!.id;
    const jobs = evidence.jobs as { jobs: Array<Record<string, unknown>> };
    jobs.jobs[0]!.run_id = 999;

    const ledger = buildReleaseE2eLedger(plan, [evidence]);

    expect(ledger.entries.find((entry) => entry.id === ignoredId)).toMatchObject({
      attempts: [],
      status: "missing",
    });
  });

  it("ignores job evidence newer than the enclosing workflow run attempt", () => {
    const plan = preflight();
    const evidence = runEvidence(plan, "default");
    const ignoredId = plan.executions.find((execution) => execution.group === "default")!.id;
    const jobs = evidence.jobs as { jobs: Array<Record<string, unknown>> };
    jobs.jobs[0]!.run_attempt = 2;

    const ledger = buildReleaseE2eLedger(plan, [evidence]);

    expect(ledger.entries.find((entry) => entry.id === ignoredId)).toMatchObject({
      attempts: [],
      status: "missing",
    });
  });

  it("rejects malformed job evidence", () => {
    const plan = preflight();
    const malformed = runEvidence(plan, "default");
    const jobs = malformed.jobs as { jobs: Array<Record<string, unknown>> };
    delete jobs.jobs[0]!.name;

    expect(() => buildReleaseE2eLedger(plan, [malformed])).toThrow(
      "runs[0].job.name must be a non-empty string",
    );
  });

  it("rejects a selective dispatch receipt that claims default-suite coverage", () => {
    const plan = preflight();
    const selective = runEvidence(plan, "default");
    const dispatch = selective.dispatch as Record<string, unknown>;
    dispatch.jobs = "snapshot-commands";
    dispatch.defaultSuiteSelected = true;

    expect(() => buildReleaseE2eLedger(plan, [selective])).toThrow(
      "runs[0].dispatch.defaultSuiteSelected must equal false",
    );
  });

  it("rejects evidence from another candidate SHA", () => {
    const plan = preflight();

    expect(() =>
      buildReleaseE2eLedger(plan, [runEvidence(plan, "default", { sha: "b".repeat(40) })]),
    ).toThrow("runs[0].run.head_sha must equal");
  });
});
