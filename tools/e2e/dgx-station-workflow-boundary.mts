// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import { E2E_ACTION_PROVENANCE } from "./workflow-boundary-policy.mts";

const TARGET = "dgx-station-express";
const TRUSTED_SELECTOR =
  "${{ always() && needs['base-image-publication'].result == 'success' && needs['base-image-publication'].outputs.managed_image_revision != '' && needs['generate-matrix'].result == 'success' && github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch' && (inputs.checkout_sha == '' || inputs.checkout_sha != inputs.base_sha) && (inputs.checkout_repository == '' || inputs.checkout_repository == github.repository) && contains(fromJSON(needs.generate-matrix.outputs.selected_jobs), 'dgx-station-express') && ((inputs.jobs == 'dgx-station-express' && inputs.targets == '') || (inputs.targets == 'dgx-station-express' && inputs.jobs == '')) }}";
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
}

export function validateDgxStationDispatchBoundary(workflow: unknown): string[] {
  return validateDgxDispatchBoundary(workflow, TARGET);
}

export function validateDgxSparkDispatchBoundary(workflow: unknown): string[] {
  return validateDgxDispatchBoundary(workflow, "spark-vllm-extra-arguments");
}

function validateDgxDispatchBoundary(workflow: unknown, target: string): string[] {
  const spark = target === "spark-vllm-extra-arguments";
  const platform = spark ? "Spark" : "Station";
  const prefix = spark ? "DGX_SPARK_DISPATCH" : "DGX_STATION_DISPATCH";
  const errors: string[] = [];
  const job = record(record(record(workflow).jobs)[target]);
  const steps = Array.isArray(job.steps) ? job.steps.map(record) : [];
  const step = (name: string) => steps.find((entry) => entry.name === name) ?? {};
  const requireEqual = (observed: unknown, expected: unknown, error: string) => {
    if (!isDeepStrictEqual(observed, expected)) errors.push(error);
  };
  requireEqual(
    job.if,
    TRUSTED_SELECTOR.replaceAll(TARGET, target),
    `${platform} dispatch requires an explicit same-repository selection through the trusted main workflow after image publication`,
  );
  requireEqual(
    job.needs,
    ["base-image-publication", "generate-matrix"],
    `${platform} dispatch must wait for its planner and managed-image publication`,
  );
  requireEqual(
    job["runs-on"],
    "ubuntu-latest",
    `${platform} controller must run on a GitHub-hosted runner`,
  );
  requireEqual(
    job["timeout-minutes"],
    spark ? 95 : 60,
    `${platform} controller must retain its bounded deadline`,
  );
  requireEqual(
    job.concurrency,
    { group: `${target}-dispatch`, "cancel-in-progress": false },
    `${platform} dispatch must use its own queue without cancelling active work`,
  );
  requireEqual(
    job.permissions,
    { contents: "read", "id-token": "write" },
    `${platform} controller must grant only source read and OIDC token permissions`,
  );
  const env = record(job.env);
  requireEqual(
    [
      env.E2E_JOB,
      env.E2E_TARGET_ID,
      env.E2E_DEFAULT_ENABLED,
      env.E2E_GATEWAY_RUNTIMES,
      env.E2E_TEST_FILE,
      env.E2E_AGENT_RUNTIME,
    ],
    ["1", target, "0", "agnostic", "test/e2e/live/dgx-express.test.ts", "openclaw"],
    `${platform} must be an explicit-only external E2E target`,
  );
  requireEqual(
    [env.E2E_OBSERVABLE_OUTCOME, env.E2E_ENVIRONMENT_OR_INFERENCE_ENDPOINT],
    [
      spark
        ? "Spark automatic vLLM selection preserves the memory-sized recipe with extra arguments, serves sandbox inference, and removes job runtime"
        : "Station Express installs managed Super VL vLLM and NemoClaw, serves sandbox inference, and removes job runtime",
      spark
        ? "Dedicated DGX Spark GB10 reporting 60 GB to below 64 GB unified memory"
        : "Dedicated DGX Station GB300 with cached Nemotron 3.5 Super VL 120B",
    ],
    spark
      ? "Spark evidence metadata must describe the GB10 memory tier and extra-arguments scenario"
      : "Station evidence metadata must describe the Super VL default and cached model",
  );
  const checkout = step(`Check out trusted ${platform} controller`);
  requireEqual(
    checkout,
    {
      name: `Check out trusted ${platform} controller`,
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      with: {
        repository: "NVIDIA/NemoClaw",
        ref: "${{ github.workflow_sha }}",
        "persist-credentials": false,
      },
    },
    `${platform} controller checkout must use the reviewed checkout action and trusted workflow revision without stored credentials`,
  );
  requireEqual(
    step(`Set up Node for ${platform} controller`),
    {
      name: `Set up Node for ${platform} controller`,
      uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      with: { "node-version": "24.22.1" },
    },
    `${platform} controller must use the reviewed Node setup`,
  );
  requireEqual(
    step("Install reviewed npm"),
    { name: "Install reviewed npm", uses: E2E_ACTION_PROVENANCE.reviewedNpmSetup.reference },
    `${platform} controller must install reviewed npm immutably`,
  );
  const dispatch = step(`Dispatch exact commit to ${platform} through operator backend`);
  requireEqual(
    dispatch.env,
    {
      E2E_ARTIFACT_DIR: `\${{ runner.temp }}/e2e-artifacts/live/${target}`,
      [`${prefix}_CANDIDATE_SHA`]: "${{ inputs.checkout_sha || github.sha }}",
      [`${prefix}_MANAGED_IMAGE_REVISION`]:
        "${{ needs.base-image-publication.outputs.managed_image_revision }}",
      [`${prefix}_URL`]: `\${{ vars.${prefix}_URL }}`,
    },
    `${platform} dispatch must bind separate candidate/image revisions and its own URL variable`,
  );
  requireEqual(
    dispatch.run,
    `node --no-warnings tools/e2e/dgx-${platform.toLowerCase()}-dispatch-client.mts`,
    `${platform} dispatch must invoke only the fixed controller client`,
  );
  const upload = step(`Upload ${platform} Express artifacts`);
  requireEqual(
    upload.if,
    "always()",
    `${platform} must upload evidence on failure and cancellation`,
  );
  requireEqual(
    upload.with,
    {
      name: `e2e-${target}`,
      path: `\${{ runner.temp }}/e2e-artifacts/live/${target}/`,
    },
    `${platform} artifacts must use their own namespace`,
  );
  requireEqual(
    steps.map((entry) => entry.name),
    [
      `Check out trusted ${platform} controller`,
      `Set up Node for ${platform} controller`,
      "Install reviewed npm",
      `Dispatch exact commit to ${platform} through operator backend`,
      `Upload ${platform} Express artifacts`,
    ],
    `${platform} controller must run checkout, Node setup, npm setup, dispatch, and upload in order`,
  );
  return errors;
}
