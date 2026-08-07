// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { readYaml, type WorkflowJob, type WorkflowStep } from "../../helpers/e2e-workflow-contract";

type SparkEvidenceWorkflow = {
  name: string;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency: Record<string, unknown>;
  jobs: {
    record: WorkflowJob;
    render: WorkflowJob;
  };
};

function workflow(): SparkEvidenceWorkflow {
  return readYaml<SparkEvidenceWorkflow>(".github/workflows/spark-express-video-evidence.yaml");
}

function step(job: WorkflowJob, name: string): WorkflowStep {
  return job.steps?.find((candidate) => candidate.name === name) as WorkflowStep;
}

describe("Spark Express video evidence workflow", () => {
  it("is manual-only, explicitly authorized, serialized, and least-privileged", () => {
    const value = workflow();

    expect(value.name).toBe("CI / Spark Express Video Evidence");
    expect(value.on).toEqual({
      workflow_dispatch: {
        inputs: {
          maintainer_branch_override: {
            description: "Allow an authorized maintainer to qualify the selected non-main revision",
            required: true,
            type: "boolean",
            default: false,
          },
        },
      },
    });
    expect(value.permissions).toEqual({ contents: "read" });
    expect(value.concurrency).toEqual({
      group: "spark-express-video-evidence",
      "cancel-in-progress": false,
    });
    expect(value.jobs.record).toMatchObject({
      if: "${{ github.repository == 'NVIDIA/NemoClaw' && github.event_name == 'workflow_dispatch' && (github.ref == 'refs/heads/main' || (inputs.maintainer_branch_override && github.actor == 'ericksoa' && github.triggering_actor == 'ericksoa')) }}",
      "runs-on": "linux-arm64-gpu-dgx-spark-gb10-protected-1",
      environment: { name: "approve-dgx-spark-image-qualification" },
      "timeout-minutes": 90,
      permissions: { contents: "read" },
    });
    const guard = step(value.jobs.record, "Validate protected Spark dispatch");
    expect(guard.env).toMatchObject({
      ACTOR: "${{ github.actor }}",
      MAINTAINER_BRANCH_OVERRIDE: "${{ inputs.maintainer_branch_override }}",
      TRIGGERING_ACTOR: "${{ github.triggering_actor }}",
    });
    expect(guard.run).toContain('[[ "$REF" == "refs/heads/main" ]]');
    expect(guard.run).toContain(
      '[[ "$MAINTAINER_BRANCH_OVERRIDE" == "true" && "$ACTOR" == "ericksoa" && "$TRIGGERING_ACTOR" == "ericksoa" ]]',
    );
    expect(step(value.jobs.record, "Validate protected Spark dispatch").run).toContain(
      '[[ "$RUNNER_ARCH_KIND" == "ARM64" ]]',
    );
  });

  it("checks out the exact main revision and keeps installation credentials out of the lane", () => {
    const record = workflow().jobs.record;

    expect(step(record, "Checkout exact main revision")).toMatchObject({
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      with: {
        ref: "${{ github.sha }}",
        "fetch-depth": 0,
        "persist-credentials": false,
      },
    });
    expect(step(record, "Prepare E2E workspace").uses).toBe(
      "NVIDIA/NemoClaw/.github/actions/prepare-e2e@f6304bc25fc35bfaa441c8c2fbfee38f72805a75",
    );
    for (const variable of [
      "DOCKER_CONFIG",
      "DOCKERHUB_USERNAME",
      "DOCKERHUB_TOKEN",
      "NVIDIA_API_KEY",
      "NVIDIA_INFERENCE_API_KEY",
      "GITHUB_TOKEN",
      "GH_TOKEN",
    ]) {
      expect(step(record, "Install OpenShell CLI").run).toContain(`-u ${variable}`);
      expect(step(record, "Run and record Spark Express qualification").run).toContain(
        `-u ${variable}`,
      );
    }
    expect(JSON.stringify(record)).not.toContain("secrets.");
  });

  it("records the exact physical test through the sanitized evidence filter", () => {
    const run = step(workflow().jobs.record, "Run and record Spark Express qualification").run;

    expect(run).toContain("set -euo pipefail");
    expect(run).toContain("test/e2e/live/spark-express-vllm.test.ts");
    expect(run).toContain("tools/e2e/spark-express-video-evidence.mts record");
    expect(run).toContain('pipeline_status=("${PIPESTATUS[@]}")');
    expect(run).toContain('test_status="${pipeline_status[0]}"');
    expect(run).toContain('recorder_status="${pipeline_status[1]}"');
    expect(run).toContain("tools/e2e/spark-express-video-evidence.mts finalize");
    expect(run).toContain('exit "$test_status"');
    expect(run).not.toContain("tee ");
    expect(run).not.toContain("script ");
  });

  it("uploads normal diagnostics separately from the one-file sanitized timeline", () => {
    const record = workflow().jobs.record;

    expect(step(record, "Upload Spark Express E2E artifacts")).toMatchObject({
      if: "${{ always() }}",
      uses: "NVIDIA/NemoClaw/.github/actions/upload-e2e-artifacts@7768e15eb90d3ee2d33432f481dfe8747e4f6d57",
    });
    expect(step(record, "Transfer sanitized Spark Express timeline")).toMatchObject({
      if: "${{ always() }}",
      uses: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
      with: {
        name: "spark-express-video-timeline",
        path: "${{ env.NEMOCLAW_SPARK_EVIDENCE_TIMELINE }}",
        "if-no-files-found": "error",
        "retention-days": 1,
      },
    });
  });

  // source-shape-contract: security -- Hosted rendering consumes only the sanitized timeline after a successful protected run and publishes a bounded neutral video directory
  it("renders only successful sanitized timelines on a standard hosted runner", () => {
    const render = workflow().jobs.render;

    expect(render).toMatchObject({
      needs: "record",
      if: "${{ github.repository == 'NVIDIA/NemoClaw' && github.event_name == 'workflow_dispatch' && (github.ref == 'refs/heads/main' || (inputs.maintainer_branch_override && github.actor == 'ericksoa' && github.triggering_actor == 'ericksoa')) && needs.record.result == 'success' }}",
      "runs-on": "ubuntu-24.04",
      "timeout-minutes": 15,
      permissions: { contents: "read" },
    });
    expect(step(render, "Checkout exact evidence renderer")).toMatchObject({
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      with: { ref: "${{ github.sha }}", "persist-credentials": false },
    });
    expect(step(render, "Download sanitized Spark Express timeline")).toMatchObject({
      uses: "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
      with: {
        name: "spark-express-video-timeline",
        path: "${{ runner.temp }}/spark-express-video-input",
      },
    });
    const run = step(render, "Render sanitized Spark Express replay").run;
    expect(run).toContain("tools/e2e/spark-express-video-evidence.mts render");
    expect(run).toContain('--frames "$NEMOCLAW_SPARK_EVIDENCE_FRAMES"');
    expect(run).toContain('--concat "$NEMOCLAW_SPARK_EVIDENCE_CONCAT"');
    expect(run).toContain("playbackDurationSeconds");
    expect(run).toContain("ffmpeg -hide_banner -loglevel error");
    expect(run).toContain('-f concat -safe 0 -i "$NEMOCLAW_SPARK_EVIDENCE_CONCAT"');
    expect(run).toContain('-t "$duration"');
    expect(run).toContain("spark-express-vllm-qualification.mp4");
    expect(step(render, "Upload Spark Express qualification video")).toMatchObject({
      uses: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
      with: {
        name: "spark-express-vllm-qualification-video",
        path: "${{ env.NEMOCLAW_SPARK_EVIDENCE_OUTPUT }}/",
        "include-hidden-files": false,
        "if-no-files-found": "error",
        "retention-days": 14,
      },
    });
    expect(JSON.stringify(workflow())).not.toMatch(
      /pull_request|pull_request_target|workflow_run/u,
    );
  });
});
