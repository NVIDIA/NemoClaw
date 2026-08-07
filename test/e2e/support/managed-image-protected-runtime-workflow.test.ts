// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { validateManagedImageMultiarchWorkflow } from "../../../tools/e2e/managed-image-multiarch-workflow-boundary.mts";
import { validateManagedImageProtectedRuntimeWorkflow } from "../../../tools/e2e/managed-image-protected-runtime-workflow-boundary.mts";
import { validateE2eWorkflow } from "../../../tools/e2e/workflow-boundary.mts";

type WorkflowRecord = Record<string, unknown>;

function workflow(): WorkflowRecord {
  return YAML.parse(
    fs.readFileSync(
      path.resolve(import.meta.dirname, "../../../.github/workflows/e2e.yaml"),
      "utf8",
    ),
  ) as WorkflowRecord;
}

function runtimeJob(value: WorkflowRecord): Record<string, unknown> {
  return (value.jobs as Record<string, Record<string, unknown>>)["managed-image-protected-runtime"];
}

function multiarchJob(value: WorkflowRecord): Record<string, unknown> {
  return (value.jobs as Record<string, Record<string, unknown>>)["managed-image-multiarch-startup"];
}

function namedStep(value: WorkflowRecord, name: string): Record<string, unknown> {
  const step = (runtimeJob(value).steps as Array<Record<string, unknown>>).find(
    (step) => step.name === name,
  );
  expect(step, `workflow step '${name}' is missing`).toBeDefined();
  return step as Record<string, unknown>;
}

describe("protected managed-image runtime workflow boundary", () => {
  it("accepts the exact activated trusted runtime lane", () => {
    expect(validateManagedImageProtectedRuntimeWorkflow(workflow())).toEqual([]);
  });

  it("accepts the exact hosted-build to protected-runtime cache handoff", () => {
    const value = workflow();

    expect(validateManagedImageMultiarchWorkflow(value)).toEqual([]);
    expect(validateManagedImageProtectedRuntimeWorkflow(value)).toEqual([]);
  });

  it("does not record manual PR risk signals on main pushes", () => {
    const value = workflow();
    const jobEnv = multiarchJob(value).env as Record<string, unknown>;
    jobEnv.NEMOCLAW_E2E_EXPECTED_SHA = "${{ inputs.checkout_sha || github.sha }}";

    expect(validateManagedImageMultiarchWorkflow(value)).toContain(
      "managed-image-multiarch-startup env must bind NEMOCLAW_E2E_EXPECTED_SHA to ${{ inputs.checkout_sha }}",
    );
  });

  it("binds protected candidate identity on ordinary main runs", () => {
    const value = workflow();
    const jobEnv = multiarchJob(value).env as Record<string, unknown>;
    jobEnv.NEMOCLAW_PROTECTED_MANAGED_IMAGE_HEAD_SHA = "${{ inputs.checkout_sha }}";

    expect(validateManagedImageMultiarchWorkflow(value)).toContain(
      "managed-image-multiarch-startup env must bind NEMOCLAW_PROTECTED_MANAGED_IMAGE_HEAD_SHA to ${{ inputs.checkout_sha || github.sha }}",
    );
  });

  it("ships the exact activation contract consumed by the trusted lane (#7744)", () => {
    const activation = JSON.parse(
      fs.readFileSync(
        path.resolve(
          import.meta.dirname,
          "../../../ci/protected-managed-image-runtime-activation-v1.json",
        ),
        "utf8",
      ),
    ) as unknown;

    expect(activation).toEqual({
      agents: ["openclaw", "hermes", "langchain-deepagents-code"],
      contractVersion: 1,
      jobId: "managed-image-protected-runtime",
      platform: "linux/amd64",
      providers: ["ollama", "nim", "vllm"],
    });
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

  it("rejects checking candidate source out over trusted qualification code", () => {
    const value = workflow();
    const candidateCheckout = namedStep(value, "Checkout exact protected runtime candidate source");
    (candidateCheckout.with as Record<string, unknown>).path = ".";

    expect(validateManagedImageProtectedRuntimeWorkflow(value)).toContain(
      "managed-image-protected-runtime candidate checkout must bind path to .candidate-runtime",
    );
  });

  it("rejects exposing the NGC credential to candidate-controlled steps", () => {
    const value = workflow();
    namedStep(value, "Validate protected runtime activation contract").env = {
      NVIDIA_API_KEY: "${{ secrets.NVIDIA_API_KEY }}",
    };

    expect(validateManagedImageProtectedRuntimeWorkflow(value)).toContain(
      "managed-image-protected-runtime must expose NVIDIA_API_KEY only to trusted qualification code",
    );
  });

  it("rejects executing candidate checkout paths in the secret-bearing qualification step", () => {
    const value = workflow();
    const qualification = namedStep(
      value,
      "Run all-agent GPU, local inference, rollback, and cleanup qualification",
    );
    qualification.run = `${String(qualification.run)}\nnpx tsx .candidate-runtime/leak.ts`;

    expect(validateManagedImageProtectedRuntimeWorkflow(value)).toContain(
      "managed-image-protected-runtime trusted qualification must not execute candidate checkout paths",
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

  it("rejects protected runtime execution without the hosted cache producer", () => {
    const value = workflow();
    runtimeJob(value).needs = ["generate-matrix"];

    expect(validateManagedImageProtectedRuntimeWorkflow(value)).toContain(
      "managed-image-protected-runtime must depend on generate-matrix and managed-image-multiarch-startup",
    );
  });

  it("rejects protected runtime permissions beyond same-run artifact access", () => {
    const value = workflow();
    runtimeJob(value).permissions = { actions: "read", contents: "read" };

    expect(validateManagedImageProtectedRuntimeWorkflow(value)).toContain(
      "managed-image-protected-runtime permissions must be exactly contents: read",
    );
  });

  it("rejects removing the exact protected runtime cache download", () => {
    const value = workflow();
    const job = runtimeJob(value);
    job.steps = (job.steps as Array<Record<string, unknown>>).filter(
      (step) => step.name !== "Download exact protected runtime build cache",
    );

    expect(validateManagedImageProtectedRuntimeWorkflow(value)).toContain(
      "managed-image-protected-runtime must define exactly one 'Download exact protected runtime build cache' step",
    );
  });

  it("rejects Docker authentication before the protected cache download", () => {
    const value = workflow();
    const job = runtimeJob(value);
    const workflowSteps = job.steps as Array<Record<string, unknown>>;
    const auth = namedStep(value, "Authenticate to Docker Hub");
    job.steps = [
      ...workflowSteps.slice(0, 3),
      auth,
      ...workflowSteps.slice(3).filter((step) => step !== auth),
    ];

    expect(validateE2eWorkflow(value)).toContain(
      "managed-image-protected-runtime Docker Hub auth must run immediately after the protected cache download",
    );
  }, 15_000);

  it("rejects a GPU rebuild that can reach the network on a cache miss", () => {
    const value = workflow();
    const build = namedStep(value, "Build exact all-agent protected runtime images");
    build.run = String(build.run).replace(
      '--offline-cache "$NEMOCLAW_PROTECTED_MANAGED_IMAGE_BUILD_CACHE"',
      "",
    );

    expect(validateManagedImageProtectedRuntimeWorkflow(value)).toContain(
      "managed-image-protected-runtime step 'Build exact all-agent protected runtime images' must include --offline-cache \"$NEMOCLAW_PROTECTED_MANAGED_IMAGE_BUILD_CACHE\"",
    );
  });

  it("rejects a hosted producer that is not selected with protected runtime", () => {
    const value = workflow();
    multiarchJob(value).if =
      "${{ contains(format(',{0},', inputs.jobs), ',managed-image-multiarch-startup,') || contains(format(',{0},', inputs.targets), ',managed-image-multiarch-startup,') }}";

    expect(validateManagedImageMultiarchWorkflow(value)).toContain(
      "managed-image-multiarch-startup must run on main pushes and retain manual selectors",
    );
  });

  it("rejects removing the exact amd64 build cache publication", () => {
    const value = workflow();
    const job = multiarchJob(value);
    job.steps = (job.steps as Array<Record<string, unknown>>).filter(
      (step) => step.name !== "Publish exact amd64 protected runtime build cache",
    );

    expect(validateManagedImageMultiarchWorkflow(value)).toContain(
      "managed-image-multiarch-startup must define exactly one 'Publish exact amd64 protected runtime build cache' step",
    );
  });
});
