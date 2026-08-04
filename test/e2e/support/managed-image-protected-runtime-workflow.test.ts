// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { validateManagedImageProtectedRuntimeWorkflow } from "../../../tools/e2e/managed-image-protected-runtime-workflow-boundary.mts";

type WorkflowRecord = Record<string, unknown>;

function workflow(): WorkflowRecord {
  return YAML.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../.github/workflows/e2e.yaml"), "utf8"),
  ) as WorkflowRecord;
}

function runtimeJob(value: WorkflowRecord): Record<string, unknown> {
  return (value.jobs as Record<string, Record<string, unknown>>)["managed-image-protected-runtime"];
}

function namedStep(value: WorkflowRecord, name: string): Record<string, unknown> {
  return (runtimeJob(value).steps as Array<Record<string, unknown>>).find(
    (step) => step.name === name,
  )!;
}

describe("protected managed-image runtime workflow boundary", () => {
  it("accepts the exact dormant trusted runtime lane", () => {
    expect(validateManagedImageProtectedRuntimeWorkflow(workflow())).toEqual([]);
  });

  it("rejects job-scoped NGC credentials", () => {
    const value = workflow();
    runtimeJob(value).env = {
      ...(runtimeJob(value).env as Record<string, unknown>),
      NVIDIA_API_KEY: "${{ secrets.NVIDIA_API_KEY }}",
    };

    expect(validateManagedImageProtectedRuntimeWorkflow(value)).toContain(
      "managed-image-protected-runtime must not expose NVIDIA_API_KEY at job scope",
    );
  });

  it("rejects removing NIM from the activation contract", () => {
    const value = workflow();
    const step = namedStep(value, "Validate protected runtime activation contract");
    step.run = String(step.run).replace(
      '.providers == ["ollama", "nim", "vllm"]',
      '.providers == ["ollama", "vllm"]',
    );

    expect(validateManagedImageProtectedRuntimeWorkflow(value)).toContain(
      'managed-image-protected-runtime step \'Validate protected runtime activation contract\' must include .providers == ["ollama", "nim", "vllm"]',
    );
  });

  it("rejects qualification before exact all-agent image construction", () => {
    const value = workflow();
    const job = runtimeJob(value);
    const workflowSteps = job.steps as Array<Record<string, unknown>>;
    const qualification = namedStep(
      value,
      "Run all-agent GPU, local inference, rollback, and cleanup qualification",
    );
    job.steps = [qualification, ...workflowSteps.filter((step) => step !== qualification)];

    expect(validateManagedImageProtectedRuntimeWorkflow(value)).toContain(
      "managed-image-protected-runtime protected qualification and cleanup steps drifted",
    );
  });
});
