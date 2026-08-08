// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { validateLlamaCppDgxSparkQualificationWorkflow } from "../../../tools/e2e/llama-cpp-dgx-spark-qualification-workflow-boundary.mts";

type WorkflowRecord = Record<string, unknown>;

function workflow(): WorkflowRecord {
  return YAML.parse(
    fs.readFileSync(
      path.resolve(import.meta.dirname, "../../../.github/workflows/e2e.yaml"),
      "utf8",
    ),
  ) as WorkflowRecord;
}

function job(value: WorkflowRecord, id: string): Record<string, unknown> {
  return (value.jobs as Record<string, Record<string, unknown>>)[id];
}

function namedStep(value: WorkflowRecord, jobId: string, name: string): Record<string, unknown> {
  const step = (job(value, jobId).steps as Array<Record<string, unknown>>).find(
    (candidate) => candidate.name === name,
  );
  expect(step, `workflow step '${name}' is missing`).toBeDefined();
  return step as Record<string, unknown>;
}

describe("llama.cpp DGX Spark qualification workflow boundary (#8260)", () => {
  it("accepts the exact trusted qualification lane", () => {
    expect(validateLlamaCppDgxSparkQualificationWorkflow(workflow())).toEqual([]);
  });

  it("requires DGX Spark opt-in before protected runner assignment", () => {
    const value = workflow();
    const triggers = value.on as {
      workflow_dispatch: {
        inputs: Record<string, Record<string, unknown>>;
      };
    };
    const input = triggers.workflow_dispatch.inputs.allow_dgx_spark_runner_queue!;
    input.type = "string";
    input.default = true;
    input.description = "Queue the runner";
    job(value, "llama-cpp-dgx-spark-plan").if = "${{ true }}";
    job(value, "llama-cpp-dgx-spark-qualification").if =
      "${{ needs.llama-cpp-dgx-spark-plan.outputs.execution == 'enabled' }}";

    expect(validateLlamaCppDgxSparkQualificationWorkflow(value)).toEqual(
      expect.arrayContaining([
        "workflow_dispatch allow_dgx_spark_runner_queue input must be boolean",
        "workflow_dispatch allow_dgx_spark_runner_queue input must default to false",
        "workflow_dispatch allow_dgx_spark_runner_queue input must require repository administrator confirmation from the authoritative NVIDIA/NemoClaw Settings -> Actions -> Runners inventory and document queued timeout behavior",
        "llama-cpp-dgx-spark-plan must require allow_dgx_spark_runner_queue and retain manual selectors",
        "llama-cpp-dgx-spark-qualification must require allow_dgx_spark_runner_queue after the trusted plan is enabled",
      ]),
    );
  });

  it("does not record manual PR risk signals on main pushes", () => {
    const value = workflow();
    const jobEnv = job(value, "llama-cpp-dgx-spark-qualification").env as Record<string, unknown>;
    jobEnv.NEMOCLAW_E2E_EXPECTED_SHA = "${{ inputs.checkout_sha || github.sha }}";

    expect(validateLlamaCppDgxSparkQualificationWorkflow(value)).toContain(
      "llama-cpp-dgx-spark-qualification env must bind NEMOCLAW_E2E_EXPECTED_SHA to ${{ inputs.checkout_sha }}",
    );
  });

  it("rejects bypassing the declarative protected-runner plan", () => {
    const value = workflow();
    job(value, "llama-cpp-dgx-spark-qualification")["runs-on"] = "self-hosted";

    expect(validateLlamaCppDgxSparkQualificationWorkflow(value)).toContain(
      "llama-cpp-dgx-spark-qualification runner must come from validated YAML",
    );
  });

  it("rejects checking candidate source out over trusted qualification code", () => {
    const value = workflow();
    const checkout = namedStep(
      value,
      "llama-cpp-dgx-spark-qualification",
      "Checkout exact llama.cpp qualification candidate",
    );
    (checkout.with as Record<string, unknown>).path = ".";

    expect(validateLlamaCppDgxSparkQualificationWorkflow(value)).toContain(
      "llama.cpp qualification candidate checkout must bind path to .candidate-llama-cpp",
    );
  });

  it.each([
    [
      "llama-cpp-dgx-spark-plan",
      "Checkout exact llama.cpp candidate configuration",
      "llama-cpp-dgx-spark-plan must pin checkout",
    ],
    [
      "llama-cpp-dgx-spark-qualification",
      "Checkout trusted llama.cpp qualification",
      "llama-cpp-dgx-spark-qualification must pin trusted checkout",
    ],
    [
      "llama-cpp-dgx-spark-qualification",
      "Checkout exact llama.cpp qualification candidate",
      "llama-cpp-dgx-spark-qualification must pin candidate checkout",
    ],
  ])("rejects an unpinned %s checkout", (jobId, name, error) => {
    const value = workflow();
    namedStep(value, jobId, name).uses = "actions/checkout@main";

    expect(validateLlamaCppDgxSparkQualificationWorkflow(value)).toContain(error);
  });

  it("rejects host networking or extra Buildx configuration", () => {
    const value = workflow();
    const buildx = namedStep(
      value,
      "llama-cpp-dgx-spark-qualification",
      "Set up protected llama.cpp Buildx",
    );
    buildx.with = { driver: "docker-container", "driver-opts": "network=host" };

    expect(validateLlamaCppDgxSparkQualificationWorkflow(value)).toContain(
      "llama-cpp-dgx-spark-qualification must use the host-network-free Docker driver",
    );
  });

  it("rejects a plan path that depends on unavailable job-level runner context", () => {
    const value = workflow();
    const protectedJob = job(value, "llama-cpp-dgx-spark-qualification");
    protectedJob.env = {
      ...(protectedJob.env as Record<string, unknown>),
      NEMOCLAW_LLAMA_CPP_QUALIFICATION_PLAN: "${{ runner.temp }}/llama-cpp-dgx-spark-plan.json",
    };

    expect(validateLlamaCppDgxSparkQualificationWorkflow(value)).toContain(
      "llama-cpp-dgx-spark-qualification env must bind NEMOCLAW_LLAMA_CPP_QUALIFICATION_PLAN to ${{ github.workspace }}/.llama-cpp-qualification/plan.json",
    );
  });

  it("rejects exposing the protected model path at job scope", () => {
    const value = workflow();
    const protectedJob = job(value, "llama-cpp-dgx-spark-qualification");
    protectedJob.env = {
      ...(protectedJob.env as Record<string, unknown>),
      MODEL_HOST_PATH: "/models/model.gguf",
    };

    expect(validateLlamaCppDgxSparkQualificationWorkflow(value)).toContain(
      "llama-cpp-dgx-spark-qualification must not expose MODEL_HOST_PATH at job scope",
    );
  });

  it("rejects executing candidate-controlled plan compiler code", () => {
    const value = workflow();
    const compile = namedStep(
      value,
      "llama-cpp-dgx-spark-plan",
      "Compile exact candidate llama.cpp qualification plan",
    );
    compile.run = `${String(compile.run)}\nnpx tsx .candidate-llama-cpp/scripts/leak.ts`;

    expect(validateLlamaCppDgxSparkQualificationWorkflow(value)).toContain(
      "llama-cpp-dgx-spark-plan must not execute candidate-controlled scripts",
    );
  });

  it("rejects cleanup that can be skipped after qualification failure", () => {
    const value = workflow();
    namedStep(
      value,
      "llama-cpp-dgx-spark-qualification",
      "Remove protected llama.cpp qualification resources",
    ).if = "success()";

    expect(validateLlamaCppDgxSparkQualificationWorkflow(value)).toContain(
      "llama-cpp-dgx-spark-qualification cleanup must always run",
    );
  });

  it("rejects installing OpenShell outside declarative agent activation", () => {
    const value = workflow();
    namedStep(
      value,
      "llama-cpp-dgx-spark-qualification",
      "Install OpenShell CLI for declarative OpenClaw qualification",
    ).if = "always()";

    expect(validateLlamaCppDgxSparkQualificationWorkflow(value)).toContain(
      "llama-cpp-dgx-spark-qualification must gate OpenShell installation on the declarative agent qualification",
    );
  });

  it("rejects installing OpenShell through candidate-controlled code", () => {
    const value = workflow();
    const install = namedStep(
      value,
      "llama-cpp-dgx-spark-qualification",
      "Install OpenShell CLI for declarative OpenClaw qualification",
    );
    install.run = `${String(install.run)}\nbash .candidate-llama-cpp/scripts/install-openshell.sh`;

    expect(validateLlamaCppDgxSparkQualificationWorkflow(value)).toContain(
      "llama-cpp-dgx-spark-qualification must install OpenShell only from trusted helper code",
    );
  });

  it("rejects qualification before the trusted plan is materialized", () => {
    const value = workflow();
    const protectedJob = job(value, "llama-cpp-dgx-spark-qualification");
    const workflowSteps = protectedJob.steps as Array<Record<string, unknown>>;
    const qualify = namedStep(
      value,
      "llama-cpp-dgx-spark-qualification",
      "Build and qualify exact llama.cpp candidate",
    );
    protectedJob.steps = [qualify, ...workflowSteps.filter((step) => step !== qualify)];

    expect(validateLlamaCppDgxSparkQualificationWorkflow(value)).toContain(
      "llama-cpp-dgx-spark-qualification trusted planning, execution, cleanup, and evidence steps drifted",
    );
  });
});
