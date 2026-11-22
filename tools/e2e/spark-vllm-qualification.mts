// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createPrivateRegularFile, readPrivateRegularFile } from "./private-file.mts";

export const SPARK_VLLM_TARGET = "spark-vllm-extra-arguments";
export const SPARK_VLLM_JOB_IF =
  "${{ !cancelled() && needs['base-image-publication'].result == 'success' && needs['base-image-publication'].outputs.managed_image_revision != '' && needs['generate-matrix'].result == 'success' && needs['package-openshell-sdk'].result == 'success' && github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch' && inputs.allow_dgx_spark_runner_queue && inputs.checkout_repository == github.repository && inputs.checkout_sha != '' && inputs.checkout_sha != inputs.base_sha && inputs.workflow_sha == github.workflow_sha && contains(fromJSON(needs.generate-matrix.outputs.selected_jobs), 'spark-vllm-extra-arguments') && ((inputs.jobs == 'spark-vllm-extra-arguments' && inputs.targets == '') || (inputs.targets == 'spark-vllm-extra-arguments' && inputs.jobs == '')) }}";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  assert(value && typeof value === "object" && !Array.isArray(value), "expected a JSON object");
  return value as RecordValue;
}
function readJson(file: string): RecordValue {
  return record(JSON.parse(readPrivateRegularFile(file, { maxBytes: 1024 * 1024 })!));
}

/** Check existing live artifacts; never turn a skipped test or incomplete cleanup into proof. */
export function sparkVllmQualificationReceipt(directory: string, env: NodeJS.ProcessEnv) {
  const candidateSha = env.NEMOCLAW_E2E_EXPECTED_SHA ?? "";
  const managedImageRevision = env.E2E_MANAGED_IMAGE_REVISION ?? "";
  const workflowSha = env.SPARK_VLLM_WORKFLOW_SHA ?? "";
  for (const sha of [candidateSha, managedImageRevision, workflowSha]) {
    assert(
      /^[a-f0-9]{40}$/u.test(sha),
      "qualification requires exact candidate, image and workflow revisions",
    );
  }
  assert(/^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ID ?? ""), "qualification requires a run ID");
  assert(
    /^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ATTEMPT ?? ""),
    "qualification requires a run attempt",
  );
  assert(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
      env.NEMOCLAW_E2E_CORRELATION_ID ?? "",
    ),
    "qualification requires a correlation ID",
  );
  const signal = readJson(path.join(directory, "risk-signal.json"));
  assert.deepEqual(
    [
      signal.version,
      signal.shardId,
      signal.jobId,
      signal.expectedSha,
      signal.testedSha,
      signal.correlationId,
      signal.passed,
      signal.failed,
      signal.skipped,
      signal.pending,
      signal.unhandledErrors,
      signal.runReason,
    ],
    [
      1,
      "default",
      SPARK_VLLM_TARGET,
      candidateSha,
      candidateSha,
      env.NEMOCLAW_E2E_CORRELATION_ID,
      1,
      0,
      0,
      0,
      0,
      "passed",
    ],
    "qualification requires exactly one passing candidate-bound live case",
  );
  const roots = readdirSync(directory, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );
  assert.equal(roots.length, 1, "qualification requires one scenario artifact directory");
  const scenario = path.join(directory, roots[0]!.name);
  const target = readJson(path.join(scenario, "target.json"));
  const result = readJson(path.join(scenario, "target-result.json"));
  assert.equal(target.id, SPARK_VLLM_TARGET);
  assert.equal(target.scenario, "extra-arguments");
  assert.equal(target.presetId, "vllm.dgx-spark-gb10.single-64gb.qwen3-6-35b-a3b-nvfp4");
  assert.deepEqual(
    [result.id, result.scenario, result.status],
    [SPARK_VLLM_TARGET, "extra-arguments", "passed"],
  );
  const cleanup = readJson(path.join(scenario, "cleanup.json"));
  assert.deepEqual(cleanup.failures, [], "qualification requires successful cleanup");
  assert(Array.isArray(cleanup.passed));
  assert(cleanup.passed.includes("remove nemoclaw-vllm"));
  assert(cleanup.passed.includes(`remove sandbox ${String(target.sandboxName)}`));
  const memory = readJson(
    path.join(scenario, "shell", "spark-extra-arguments-physical-memory.result.json"),
  );
  const memoryBytes = Number(String(memory.stdout).trim());
  assert(Number.isSafeInteger(memoryBytes), "qualification requires retained host memory");
  const inspected = readJson(
    path.join(scenario, "shell", "spark-express-vllm-container-inspect.result.json"),
  );
  const [container] = JSON.parse(String(inspected.stdout)) as unknown[];
  const containerId = record(container).Id;
  assert(
    /^[a-f0-9]{64}$/u.test(String(containerId)),
    "qualification requires the installed container identity",
  );
  const imageAuthority = record(JSON.parse(env.E2E_MANAGED_IMAGE_COHORT_RECEIPT ?? ""));
  assert.equal(imageAuthority.kind, "nemoclaw-managed-image-cohort-receipt-v1");
  assert.equal(
    imageAuthority.revision,
    managedImageRevision,
    "qualification image authority mismatch",
  );
  return {
    kind: "nemoclaw-spark-vllm-qualification-v1",
    candidateSha,
    managedImageRevision,
    workflowSha,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    correlationId: signal.correlationId,
    memoryBytes,
    containerId,
    signal,
    imageAuthority,
    scenario: path.basename(scenario),
    target,
    result,
    cleanup,
  };
}

/** Bind the physical execution to the reviewed workflow, approval and image producer. */
export function validateSparkVllmWorkflowBoundary(workflow: unknown): string[] {
  const root = workflow as { jobs?: Record<string, unknown> } | undefined;
  const value = root?.jobs?.[SPARK_VLLM_TARGET];
  if (!value || typeof value !== "object") return ["Spark vLLM qualification job is required"];
  const job = record(value);
  const errors: string[] = [];
  const requireEqual = (actual: unknown, expected: unknown, label: string) => {
    if (!isDeepStrictEqual(actual, expected))
      errors.push(`Spark vLLM qualification must preserve ${label}`);
  };
  requireEqual(job.if, SPARK_VLLM_JOB_IF, "explicit trusted main dispatch and runner opt-in");
  requireEqual(
    job.needs,
    ["base-image-publication", "generate-matrix", "package-openshell-sdk"],
    "candidate and image prerequisites",
  );
  requireEqual(
    job["runs-on"],
    "linux-arm64-gpu-dgx-spark-gb10-protected-1",
    "the protected physical runner",
  );
  requireEqual(
    job.environment,
    "approve-dgx-spark-image-qualification",
    "protected environment approval",
  );
  requireEqual(
    job.concurrency,
    { group: "llama-cpp-dgx-spark-protected-runner", "cancel-in-progress": false },
    "exclusive non-cancelling Spark access",
  );
  requireEqual(
    job.permissions,
    { actions: "read", contents: "read", "pull-requests": "read" },
    "read-only artifact and source permissions",
  );
  requireEqual(job["timeout-minutes"], 95, "the bounded scenario and cleanup budget");
  const env = record(job.env ?? {});
  for (const [key, expected] of Object.entries({
    E2E_TARGET_ID: SPARK_VLLM_TARGET,
    E2E_DEFAULT_ENABLED: "0",
    E2E_ARTIFACT_DIR: "${{ github.workspace }}/e2e-artifacts/live/spark-vllm-extra-arguments",
    SPARK_VLLM_WORKFLOW_SHA: "${{ github.workflow_sha }}",
    NEMOCLAW_RUN_LIVE_E2E: "1",
    NEMOCLAW_GATEWAY_RUNTIME: "docker",
    E2E_WORKLOAD_SOURCE: "${{ needs.generate-matrix.outputs.workload_source }}",
    NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG_JSON:
      "${{ needs.base-image-publication.outputs.managed_image_catalog }}",
    NEMOCLAW_E2E_REQUIRE_EXECUTED_TEST: "1",
    E2E_GATEWAY_RUNTIMES: "docker",
    E2E_MANAGED_IMAGE_REVISION:
      "${{ needs.base-image-publication.outputs.managed_image_revision }}",
    E2E_MANAGED_IMAGE_COHORT_RECEIPT:
      "${{ needs.base-image-publication.outputs.managed_image_receipt }}",
  }))
    requireEqual(env[key], expected, key);
  const steps = (Array.isArray(job.steps) ? job.steps : []).map(record);
  const step = (name: string) => steps.find((item) => item.name === name) ?? {};
  requireEqual(
    step("Check out trusted Spark receipt validator").with,
    {
      repository: "NVIDIA/NemoClaw",
      ref: "${{ github.workflow_sha }}",
      path: ".trusted-spark",
      "persist-credentials": false,
    },
    "trusted receipt-validator checkout",
  );
  requireEqual(
    step("Check out exact Spark candidate").with,
    {
      repository: "${{ inputs.checkout_repository || github.repository }}",
      ref: "${{ inputs.checkout_sha || github.sha }}",
      "fetch-depth": 0,
      "persist-credentials": false,
      clean: true,
    },
    "exact credential-free candidate checkout",
  );
  requireEqual(
    step("Run Spark vLLM extra arguments").run,
    "npx --no-install tsx tools/e2e/live-vitest-invocation.mts run --test-path test/e2e/live/dgx-express.test.ts --selector '^spark-vllm-extra-arguments:'",
    "the existing scenario selector",
  );
  requireEqual(
    step("Validate Spark vLLM qualification receipt").run,
    "node --no-warnings --import tsx .trusted-spark/tools/e2e/spark-vllm-qualification.mts",
    "the trusted canonical receipt consumer",
  );
  requireEqual(
    step("Upload Spark vLLM qualification artifacts").if,
    "always()",
    "failure and cleanup diagnostics",
  );
  requireEqual(
    step("Upload Spark vLLM qualification artifacts").with,
    undefined,
    "shared artifact defaults",
  );
  const expectedSteps = [
    [
      "Check out exact Spark candidate",
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    ],
    [
      "Check out trusted Spark receipt validator",
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    ],
    ["Verify approved Spark source identity", undefined],
    [
      "Download reviewed OpenShell SDK archive",
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
    ],
    [
      "Prepare E2E workspace",
      "NVIDIA/NemoClaw/.github/actions/prepare-e2e@e7e587da7c6c2c48aa112533c7eaeb549e40a351",
    ],
    [
      "Install reviewed OpenShell SDK archive without package credentials",
      "NVIDIA/NemoClaw/.github/actions/install-reviewed-openshell-sdk@855b8b80e13c4dbd59411672e3c3dd7720bc590f",
    ],
    [
      "Restore exact-commit CLI artifact",
      "NVIDIA/NemoClaw/.github/actions/restore-e2e-cli-artifact@3c6d991640414a2d78f95f629d67194d44829554",
    ],
    ["Run Spark vLLM extra arguments", undefined],
    ["Validate Spark vLLM qualification receipt", undefined],
    [
      "Upload Spark vLLM qualification artifacts",
      "NVIDIA/NemoClaw/.github/actions/upload-e2e-artifacts@7768e15eb90d3ee2d33432f481dfe8747e4f6d57",
    ],
  ];
  requireEqual(
    steps.map((item) => [item.name, item.uses]),
    expectedSteps,
    "ordered immutable preparation, execution and retention",
  );
  requireEqual(
    step("Restore exact-commit CLI artifact").with,
    { "provenance-json": "${{ needs.generate-matrix.outputs.cli_artifact_provenance }}" },
    "CLI artifact provenance",
  );
  requireEqual(
    step("Verify approved Spark source identity").env,
    { EXPECTED_SHA: "${{ inputs.checkout_sha }}", TRUSTED_SHA: "${{ github.workflow_sha }}" },
    "source identity inputs",
  );
  const identity = String(step("Verify approved Spark source identity").run ?? "");
  requireEqual(
    identity.trim(),
    [
      "set -euo pipefail",
      'test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"',
      'test "$(git -C .trusted-spark rev-parse HEAD)" = "$TRUSTED_SHA"',
      'git diff --exit-code "$TRUSTED_SHA" "$EXPECTED_SHA" -- package.json package-lock.json .npmrc',
      'test "$(uname -m)" = aarch64',
      "nvidia-smi",
      "openshell --version",
    ].join("\n"),
    "source and host admission before preparation",
  );
  requireEqual(job["continue-on-error"], undefined, "failure propagation");
  requireEqual(job.container, undefined, "physical host execution");
  requireEqual(job.defaults, undefined, "canonical execution directory");
  for (const item of steps) {
    for (const key of ["continue-on-error", "working-directory", "env"]) {
      if (item.name !== "Verify approved Spark source identity" || key !== "env")
        requireEqual(item[key], undefined, `step ${key}`);
    }
    if (item.name !== "Upload Spark vLLM qualification artifacts")
      requireEqual(item.if, undefined, "unconditional proof steps");
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.env.E2E_ARTIFACT_DIR ?? "";
  assert(path.isAbsolute(directory), "qualification requires an absolute artifact directory");
  const receipt = sparkVllmQualificationReceipt(directory, process.env);
  createPrivateRegularFile(
    path.join(directory, "spark-vllm-qualification.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
}
