// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

type WorkflowStep = Record<string, unknown> & { name?: string };
type WorkflowJob = Record<string, unknown> & { steps?: WorkflowStep[] };
type Workflow = {
  on: { workflow_dispatch?: { inputs?: Record<string, Record<string, unknown>> } };
  jobs: Record<string, WorkflowJob>;
};

const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const DOWNLOAD = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const UPLOAD = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";

function readWorkflow(file: string): Workflow {
  return YAML.parse(
    fs.readFileSync(path.resolve(import.meta.dirname, `../../../${file}`), "utf8"),
  ) as Workflow;
}

function step(job: WorkflowJob, name: string): WorkflowStep {
  const value = job.steps?.find((entry) => entry.name === name);
  expect(value, `missing workflow step '${name}'`).toBeDefined();
  return value!;
}

describe("native runtime qualification workflow boundary", () => {
  // source-shape-contract: security -- The dispatch-only selector must bypass every candidate-controlled checkout, build, and planner step
  it("keeps the selector dispatch-only and skips candidate execution", () => {
    const workflow = readWorkflow(".github/workflows/e2e.yaml");
    const input = workflow.on.workflow_dispatch?.inputs?.native_runtime_qualification_run_id;
    const generate = workflow.jobs["generate-matrix"]!;
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../../.github/workflows/e2e.yaml"),
      "utf8",
    );

    expect(input).toMatchObject({ required: false, default: "", type: "string" });
    expect(source).toContain("native-runtime-qualification::false:false");
    expect(source).toContain("^[1-9][0-9]{0,19}$");
    expect(source).toContain("The trusted workflow revision cannot qualify itself");
    expect((generate.steps ?? []).filter((entry) => entry.uses === CHECKOUT)).toEqual([
      expect.objectContaining({
        if: expect.stringContaining("inputs.jobs != 'native-runtime-qualification'"),
      }),
    ]);
    expect(step(generate, "Prepare E2E workspace").if).toContain(
      "inputs.jobs != 'native-runtime-qualification'",
    );
    expect(step(generate, "Package exact-commit CLI").if).toContain(
      "inputs.jobs != 'native-runtime-qualification'",
    );
  });

  // source-shape-contract: security -- Trusted matrix compilation must authenticate the producer dispatch receipt before any case artifact is consumed
  it("compiles trusted rows and invokes one reusable collector per case", () => {
    const workflow = readWorkflow(".github/workflows/e2e.yaml");
    const plan = workflow.jobs["native-runtime-qualification-plan"]!;
    const collect = workflow.jobs["native-runtime-qualification-collect"]!;
    const checkout = step(plan, "Check out the trusted qualification planner");

    expect(plan.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(plan.if).toContain("github.ref == 'refs/heads/main'");
    expect(checkout).toMatchObject({ uses: CHECKOUT, with: { ref: "${{ github.workflow_sha }}" } });
    expect(step(plan, "Authenticate the producer run and current pull request").run).toContain(
      "gh api",
    );
    expect(step(plan, "Download the trusted dispatch receipt")).toMatchObject({
      uses: DOWNLOAD,
      with: {
        "artifact-ids": "${{ steps.source.outputs.dispatch_artifact_id }}",
        "merge-multiple": true,
      },
    });
    expect(step(plan, "Validate the trusted dispatch receipt").run).toContain(
      "native-runtime-qualification-collector.mts dispatch",
    );
    expect(step(plan, "Compile the trusted qualification matrix").run).toContain(
      "native-runtime-qualification-plan.mts --ci-output",
    );
    expect(collect).toMatchObject({
      permissions: { actions: "read", contents: "read" },
      uses: "./.github/workflows/e2e-native-runtime-qualification-case.yaml",
      strategy: {
        "fail-fast": false,
        matrix: "${{ fromJSON(needs.native-runtime-qualification-plan.outputs.matrix) }}",
      },
    });
    expect(collect).not.toHaveProperty("runs-on");
    expect(JSON.stringify(collect)).not.toContain("secrets.");
  });

  // source-shape-contract: security -- Each untrusted producer artifact must resolve to one immutable run-bound identity before receipt creation
  it("authenticates each immutable artifact before producing a receipt", () => {
    const workflow = readWorkflow(".github/workflows/e2e-native-runtime-qualification-case.yaml");
    const collect = workflow.jobs.collect!;
    const resolve = step(collect, "Resolve the immutable case artifact");
    const download = step(collect, "Download the immutable case artifact");

    expect(collect["runs-on"]).toBe("ubuntu-latest");
    expect(workflow).toMatchObject({ permissions: { actions: "read", contents: "read" } });
    expect(JSON.stringify(workflow)).not.toMatch(
      /NVIDIA_API_KEY|NVIDIA_INFERENCE_API_KEY|DOCKERHUB_TOKEN/,
    );
    expect(resolve.run).toContain("gh api");
    expect(resolve.run).toContain(".total_count == 1");
    expect(resolve.run).toContain(".size_in_bytes <= 1048576");
    expect(resolve.run).toContain(".workflow_run.id");
    expect(resolve.run).toContain("/attempts/${PRODUCER_RUN_ATTEMPT}/jobs");
    expect(resolve.run).toContain('.conclusion == "success"');
    expect(download).toMatchObject({
      uses: DOWNLOAD,
      with: {
        "artifact-ids": "${{ steps.artifact.outputs.id }}",
        "merge-multiple": true,
        "run-id": "${{ inputs.producer_run_id }}",
      },
    });
    expect(step(collect, "Upload the validated case receipt").uses).toBe(UPLOAD);
  });

  // source-shape-contract: security -- Aggregate evidence must re-read mutable source identities and remain downstream of all authenticated case receipts
  it("always aggregates complete receipts after re-reading mutable identities", () => {
    const workflow = readWorkflow(".github/workflows/e2e.yaml");
    const aggregate = workflow.jobs["native-runtime-qualification"]!;

    expect(aggregate.if).toContain("always()");
    expect(
      step(aggregate, "Reauthenticate the producer run and current pull request").run,
    ).toContain("gh api");
    expect(
      step(aggregate, "Reauthenticate the producer run and current pull request").run,
    ).toContain("actions/artifacts/");
    expect(step(aggregate, "Download validated case receipts").uses).toBe(DOWNLOAD);
    expect(
      (
        step(aggregate, "Aggregate the complete qualification evidence").env as Record<
          string,
          unknown
        >
      ).PR_NUMBER,
    ).toBe("${{ inputs.pr_number }}");
    expect(step(aggregate, "Upload the complete qualification evidence").uses).toBe(UPLOAD);
    expect(JSON.stringify(aggregate)).not.toContain("inputs.checkout_repository ||");
  });
});
