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

function preflight(
  input: { candidatePathExists?: (candidateSha: string, candidatePath: string) => boolean } = {},
) {
  return buildReleaseE2ePreflight({
    candidateSha,
    candidatePathExists: input.candidatePathExists ?? (() => true),
  });
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
  const runId = 1001;
  const executions = plan.executions.filter(
    (execution) => execution.group === group && (options.only?.(execution) ?? true),
  );
  const selectors: string[] = [];
  return {
    dispatch: {
      allowJetsonRunnerQueue: false,
      candidateSha,
      emptySelectors: true,
      eventName: "workflow_dispatch",
      includeStagingBrevLaunchable: plan.dispatches.completeRun.includeStagingBrevLaunchable,
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
      status: "completed",
      conclusion: "success",
      run_attempt: attempt,
      head_sha: options.sha ?? candidateSha,
      html_url: `https://github.com/NVIDIA/NemoClaw/actions/runs/${runId}`,
    },
  };
}

describe("release E2E evidence", () => {
  it("derives one complete release E2E run from the workflow", () => {
    const plan = preflight();

    expect(plan.dispatches.completeRun).toEqual({
      includeStagingBrevLaunchable: true,
      jobs: "",
      mode: "full",
      targets: "",
    });
    expect(plan.launchableE2eJobId).toBe("staging-brev-launchable");
    expect(plan.exceptionsRequired).toEqual([]);
  });

  it("rejects a missing activation path for a default E2E", () => {
    expect(() =>
      preflight({
        candidatePathExists: (_sha, candidatePath) =>
          candidatePath !== "ci/protected-managed-image-multiarch-activation-v1.json",
      }),
    ).toThrow(
      "candidate commit is missing required E2E activation path ci/protected-managed-image-multiarch-activation-v1.json for managed-image-multiarch-startup",
    );
  });

  it("rejects an in-progress workflow with successful execution jobs", () => {
    const plan = preflight();
    const evidence = runEvidence(plan, "default");
    (evidence.run as Record<string, unknown>).status = "in_progress";

    expect(() => buildReleaseE2eLedger(plan, [evidence])).toThrow(
      'runs[0].run.status must equal "completed"',
    );
  });

  it("rejects a failed workflow with successful execution jobs", () => {
    const plan = preflight();
    const evidence = runEvidence(plan, "default");
    (evidence.run as Record<string, unknown>).conclusion = "failure";

    expect(() => buildReleaseE2eLedger(plan, [evidence])).toThrow(
      'runs[0].run.conclusion must equal "success"',
    );
  });

  it("fails when the candidate commit cannot be inspected for activation paths", () => {
    expect(() =>
      buildReleaseE2ePreflight({
        candidateSha: "0".repeat(40),
      }),
    ).toThrow("could not inspect release E2E activation path");
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

  it("accumulates successful evidence across rerun attempts", () => {
    const plan = preflight();
    const firstDefaultRun = runEvidence(plan, "default");
    const laterFailure = runEvidence(plan, "default", {
      attempt: 2,
      conclusion: () => "failure",
      only: (execution) => execution.id === "snapshot-commands",
    });
    (firstDefaultRun.run as Record<string, unknown>).run_attempt = 2;
    (firstDefaultRun.jobs as { jobs: unknown[] }).jobs.push(
      ...(laterFailure.jobs as { jobs: unknown[] }).jobs,
    );
    const ledger = buildReleaseE2eLedger(plan, [firstDefaultRun]);

    expect(ledger.successfulCount).toBe(ledger.requiredCount);
    expect(ledger.missingCount).toBe(0);
    expect(ledger.entries.find((entry) => entry.id === "snapshot-commands")).toMatchObject({
      attempts: [
        { attempt: 2, conclusion: "failure" },
        { attempt: 1, conclusion: "success" },
      ],
      successfulEvidence: { attempt: 1 },
      status: "successful",
    });
  });

  it("rejects evidence assembled from multiple workflow runs", () => {
    const plan = preflight();
    expect(() =>
      buildReleaseE2eLedger(plan, [runEvidence(plan, "default"), runEvidence(plan, "default")]),
    ).toThrow("release E2E evidence requires exactly one workflow run, received 2");
  });

  it("requires the full run to include staging Brev Launchable", () => {
    const plan = preflight();
    const evidence = runEvidence(plan, "default");
    (evidence.dispatch as Record<string, unknown>).includeStagingBrevLaunchable = false;
    expect(() => buildReleaseE2eLedger(plan, [evidence])).toThrow(
      "runs[0].dispatch.includeStagingBrevLaunchable must equal true",
    );
  });

  it("reports a failed matrix row without collapsing its successful siblings", () => {
    const plan = preflight();
    const failedId = 'hermes-gpu-startup[scenario="fallback"]';
    const ledger = buildReleaseE2eLedger(plan, [
      runEvidence(plan, "default", {
        conclusion: (execution) => (execution.id === failedId ? "failure" : "success"),
      }),
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
    ).toMatchObject({ status: "successful" });
  });

  it("does not count an in-progress execution as successful", () => {
    const plan = preflight();
    const pendingId = "snapshot-commands";
    const ledger = buildReleaseE2eLedger(plan, [
      runEvidence(plan, "default", {
        status: (execution) => (execution.id === pendingId ? "in_progress" : "completed"),
      }),
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

  it("rejects a selective dispatch receipt that claims empty selectors", () => {
    const plan = preflight();
    const selective = runEvidence(plan, "default");
    const dispatch = selective.dispatch as Record<string, unknown>;
    dispatch.jobs = "snapshot-commands";
    dispatch.emptySelectors = true;

    expect(() => buildReleaseE2eLedger(plan, [selective])).toThrow(
      'runs[0].dispatch.jobs must equal ""',
    );
  });

  it("rejects evidence from another candidate SHA", () => {
    const plan = preflight();

    expect(() =>
      buildReleaseE2eLedger(plan, [runEvidence(plan, "default", { sha: "b".repeat(40) })]),
    ).toThrow("runs[0].run.head_sha must equal");
  });
});
