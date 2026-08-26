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
  return namedJobStep(value, "managed-image-protected-runtime", name);
}

function namedJobStep(value: WorkflowRecord, jobId: string, name: string): Record<string, unknown> {
  const job = (value.jobs as Record<string, Record<string, unknown>>)[jobId];
  const step = (job.steps as Array<Record<string, unknown>>).find((step) => step.name === name);
  expect(step, `workflow step '${name}' is missing`).toBeDefined();
  return step as Record<string, unknown>;
}

function namedMultiarchStep(value: WorkflowRecord, name: string): Record<string, unknown> {
  const step = (multiarchJob(value).steps as Array<Record<string, unknown>>).find(
    (step) => step.name === name,
  );
  expect(step, `workflow step '${name}' is missing`).toBeDefined();
  return step as Record<string, unknown>;
}

describe("protected managed-image runtime workflow", () => {
  it("accepts the checked-in protected runtime job", () => {
    expect(validateManagedImageProtectedRuntimeWorkflow(workflow())).toEqual([]);
  });

  it("accepts the hosted build-cache handoff to the protected runtime job", () => {
    const value = workflow();

    expect(validateManagedImageMultiarchWorkflow(value)).toEqual([]);
    expect(validateManagedImageProtectedRuntimeWorkflow(value)).toEqual([]);
  });

  // source-shape-contract: security -- Both protected jobs must execute the shared Hermes resolver from trusted workflow code
  it.each([
    [
      "managed-image-multiarch-startup",
      "Resolve reviewed Hermes platform base image",
      "./.trusted-hermes-resolver/.github/actions/resolve-reviewed-hermes-platform",
      "agents/hermes/Dockerfile",
      validateManagedImageMultiarchWorkflow,
    ],
    [
      "managed-image-protected-runtime",
      "Resolve reviewed Hermes runtime base image",
      "./.github/actions/resolve-reviewed-hermes-platform",
      ".candidate-runtime/agents/hermes/Dockerfile",
      validateManagedImageProtectedRuntimeWorkflow,
    ],
  ] as const)(
    "%s binds Hermes resolution to trusted workflow code",
    (jobId, stepName, actionPath, dockerfilePath, validate) => {
      const value = workflow();
      const step = namedJobStep(value, jobId, stepName);
      expect(step.uses).toBe(actionPath);
      expect((step.with as Record<string, unknown>)["dockerfile-path"]).toBe(dockerfilePath);
      step.uses = "./.github/actions/resolve-hermes-base-image";

      expect(validate(value)).toContain(
        `${jobId} must use the shared reviewed Hermes platform resolver`,
      );

      const changedInput = workflow();
      const changedInputStep = namedJobStep(changedInput, jobId, stepName);
      (changedInputStep.with as Record<string, unknown>)["dockerfile-path"] = "Dockerfile";
      expect(validate(changedInput)).toContain(
        `${jobId} Hermes platform resolver must bind dockerfile-path to ${dockerfilePath}`,
      );
    },
  );

  it("rejects a multiarch resolver from candidate source after registry authentication", () => {
    const value = workflow();
    namedJobStep(
      value,
      "managed-image-multiarch-startup",
      "Resolve reviewed Hermes platform base image",
    ).uses = "./.github/actions/resolve-reviewed-hermes-platform";

    expect(validateManagedImageMultiarchWorkflow(value)).toContain(
      "managed-image-multiarch-startup must use the shared reviewed Hermes platform resolver",
    );
    expect(validateE2eWorkflow(value)).toContain(
      "managed-image-multiarch-startup step 'Resolve reviewed Hermes platform base image' action must be pinned to a full commit SHA",
    );
  });

  it("requires the multiarch resolver checkout from the trusted workflow revision", () => {
    const value = workflow();
    const trustedCheckout = namedJobStep(
      value,
      "managed-image-multiarch-startup",
      "Checkout trusted Hermes resolver",
    );
    (trustedCheckout.with as Record<string, unknown>).ref =
      "${{ inputs.checkout_sha || github.sha }}";

    expect(validateManagedImageMultiarchWorkflow(value)).toContain(
      "managed-image-multiarch-startup trusted Hermes resolver checkout must bind ref to ${{ inputs.workflow_sha || github.workflow_sha }}",
    );
  });

  // source-shape-contract: security -- Both protected jobs must reject extra resolver actions before candidate execution
  it.each([
    [
      "managed-image-multiarch-startup",
      "Resolve reviewed Hermes platform base image",
      validateManagedImageMultiarchWorkflow,
    ],
    [
      "managed-image-protected-runtime",
      "Resolve reviewed Hermes runtime base image",
      validateManagedImageProtectedRuntimeWorkflow,
    ],
  ] as const)("%s rejects duplicate Hermes resolver steps", (jobId, stepName, validate) => {
    const value = workflow();
    const job = (value.jobs as Record<string, Record<string, unknown>>)[jobId];
    const step = namedJobStep(value, jobId, stepName);
    (job.steps as Array<Record<string, unknown>>).push(structuredClone(step));

    expect(validate(value)).toContain(`${jobId} must define exactly one '${stepName}' step`);
  });

  it("runs protected runtime checks from .candidate-runtime", () => {
    const value = workflow();
    const jobEnv = runtimeJob(value).env as Record<string, unknown>;
    jobEnv.NEMOCLAW_E2E_TESTED_ROOT = "${{ github.workspace }}";

    expect(validateManagedImageProtectedRuntimeWorkflow(value)).toContain(
      "managed-image-protected-runtime env must bind NEMOCLAW_E2E_TESTED_ROOT to ${{ github.workspace }}/.candidate-runtime",
    );
  });

  it("does not activate protected PR risk reporting for ordinary main runs (#8664)", () => {
    const value = workflow();
    const jobEnv = runtimeJob(value).env as Record<string, unknown>;
    jobEnv.NEMOCLAW_E2E_EXPECTED_SHA = "${{ inputs.checkout_sha || github.sha }}";

    expect(validateManagedImageProtectedRuntimeWorkflow(value)).toContain(
      "managed-image-protected-runtime env must bind NEMOCLAW_E2E_EXPECTED_SHA to ${{ inputs.checkout_sha }}",
    );
  });

  it("does not record manual PR risk signals on main pushes", () => {
    const value = workflow();
    const jobEnv = multiarchJob(value).env as Record<string, unknown>;
    jobEnv.NEMOCLAW_E2E_EXPECTED_SHA = "${{ inputs.checkout_sha || github.sha }}";

    expect(validateManagedImageMultiarchWorkflow(value)).toContain(
      "managed-image-multiarch-startup env must bind NEMOCLAW_E2E_EXPECTED_SHA to ${{ inputs.checkout_sha }}",
    );
  });

  it("uses github.sha for main pushes", () => {
    const value = workflow();
    const jobEnv = multiarchJob(value).env as Record<string, unknown>;
    jobEnv.NEMOCLAW_PROTECTED_MANAGED_IMAGE_HEAD_SHA = "${{ inputs.checkout_sha }}";

    expect(validateManagedImageMultiarchWorkflow(value)).toContain(
      "managed-image-multiarch-startup env must bind NEMOCLAW_PROTECTED_MANAGED_IMAGE_HEAD_SHA to ${{ inputs.checkout_sha || github.sha }}",
    );
  });

  it("lists every supported agent and provider in the activation file (#7744)", () => {
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

  it("does not replace workflow code with the source under test", () => {
    const value = workflow();
    const candidateCheckout = namedStep(value, "Checkout exact protected runtime candidate source");
    (candidateCheckout.with as Record<string, unknown>).path = ".";

    expect(validateManagedImageProtectedRuntimeWorkflow(value)).toContain(
      "managed-image-protected-runtime candidate checkout must bind path to .candidate-runtime",
    );
  });

  it("passes the NGC credential only to the qualification step", () => {
    const value = workflow();
    namedStep(value, "Validate protected runtime activation contract").env = {
      NVIDIA_API_KEY: "${{ secrets.NVIDIA_API_KEY }}",
    };

    expect(validateManagedImageProtectedRuntimeWorkflow(value)).toContain(
      "managed-image-protected-runtime must expose NVIDIA_API_KEY only to trusted qualification code",
    );
  });

  it("rejects an unguarded qualification credential", () => {
    const value = workflow();
    const qualification = namedStep(
      value,
      "Run all-agent GPU, local inference, rollback, and cleanup qualification",
    );
    qualification.env = { NVIDIA_API_KEY: "${{ secrets.NVIDIA_API_KEY }}" };

    expect(validateManagedImageProtectedRuntimeWorkflow(value)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "managed-image-protected-runtime qualification env must bind NVIDIA_API_KEY",
        ),
      ]),
    );
  });

  it("prevents the credentialed qualification step from executing .candidate-runtime files", () => {
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

  it("requires NIM in the activation file", () => {
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

  it("runs qualification only after every agent image is built", () => {
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
      "managed-image-protected-runtime must depend on base-image-publication, generate-matrix, and managed-image-multiarch-startup",
    );
  });

  it("rejects a mutable DCode base in protected runtime qualification", () => {
    const value = workflow();
    const bases = namedStep(value, "Resolve exact amd64 runtime base images");
    bases.run = `${String(bases.run)}\nghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base:latest`;

    expect(validateManagedImageProtectedRuntimeWorkflow(value)).toContain(
      "managed-image-protected-runtime must not resolve the DCode base from a mutable alias",
    );
  });

  it("rejects protected runtime permissions beyond same-run artifact access", () => {
    const value = workflow();
    runtimeJob(value).permissions = { actions: "read", contents: "read" };

    expect(validateManagedImageProtectedRuntimeWorkflow(value)).toContain(
      "managed-image-protected-runtime permissions must be exactly contents: read",
    );
  });

  it("requires one protected runtime cache download", () => {
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

  it("requires GPU rebuilds to import the hosted build cache", () => {
    const value = workflow();
    const build = namedStep(value, "Build exact all-agent protected runtime images");
    build.run = String(build.run).replace(
      '--cache-from "$NEMOCLAW_PROTECTED_MANAGED_IMAGE_BUILD_CACHE"',
      "",
    );

    expect(validateManagedImageProtectedRuntimeWorkflow(value)).toContain(
      "managed-image-protected-runtime step 'Build exact all-agent protected runtime images' must include --cache-from \"$NEMOCLAW_PROTECTED_MANAGED_IMAGE_BUILD_CACHE\"",
    );
  });

  it("rejects a hosted producer that is not selected with protected runtime", () => {
    const value = workflow();
    multiarchJob(value).if =
      "${{ contains(format(',{0},', inputs.jobs), ',managed-image-multiarch-startup,') || contains(format(',{0},', inputs.targets), ',managed-image-multiarch-startup,') }}";

    expect(validateManagedImageMultiarchWorkflow(value)).toContain(
      "managed-image-multiarch-startup must use the trusted execution plan",
    );
  });

  it("requires the validated base publication before protected multiarch startup", () => {
    const value = workflow();
    multiarchJob(value).needs = "generate-matrix";

    expect(validateManagedImageMultiarchWorkflow(value)).toContain(
      "managed-image-multiarch-startup must depend on base-image-publication and generate-matrix",
    );
  });

  it("selects each protected DCode base from the validated platform contract", () => {
    const value = workflow();
    const bases = namedMultiarchStep(value, "Resolve exact platform base images");
    (bases.env as Record<string, unknown>).DCODE_BASE_CONTRACT = "${{ inputs.base_contract }}";

    expect(validateManagedImageMultiarchWorkflow(value)).toContain(
      "managed-image-multiarch-startup exact base resolution must bind DCODE_BASE_CONTRACT to ${{ needs.base-image-publication.outputs.dcode_base_contract }}",
    );
  });

  it("rejects a mutable DCode base in protected multiarch startup", () => {
    const value = workflow();
    const bases = namedMultiarchStep(value, "Resolve exact platform base images");
    bases.run = `${String(bases.run)}\nghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base:latest`;

    expect(validateManagedImageMultiarchWorkflow(value)).toContain(
      "managed-image-multiarch-startup must not resolve the DCode base from a mutable alias",
    );
  });

  it("requires one amd64 build-cache upload", () => {
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
