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
  const errors: string[] = [];
  const job = record(record(record(workflow).jobs)[TARGET]);
  const steps = Array.isArray(job.steps) ? job.steps.map(record) : [];
  const step = (name: string) => steps.find((entry) => entry.name === name) ?? {};
  const requireEqual = (observed: unknown, expected: unknown, error: string) => {
    if (!isDeepStrictEqual(observed, expected)) errors.push(error);
  };
  requireEqual(
    job.if,
    TRUSTED_SELECTOR,
    "Station dispatch requires an explicit same-repository selection through the trusted main workflow after image publication",
  );
  requireEqual(
    job.needs,
    ["base-image-publication", "generate-matrix"],
    "Station dispatch must wait for its planner and managed-image publication",
  );
  requireEqual(
    job["runs-on"],
    "ubuntu-latest",
    "Station controller must run on a GitHub-hosted runner",
  );
  requireEqual(job["timeout-minutes"], 60, "Station controller must retain its bounded deadline");
  requireEqual(
    job.concurrency,
    { group: "dgx-station-express-dispatch", "cancel-in-progress": false },
    "Station dispatch must use its own queue without cancelling active work",
  );
  requireEqual(
    job.permissions,
    { contents: "read", "id-token": "write" },
    "Station controller must grant only source read and OIDC token permissions",
  );
  const env = record(job.env);
  requireEqual(
    [env.E2E_JOB, env.E2E_TARGET_ID, env.E2E_DEFAULT_ENABLED, env.E2E_GATEWAY_RUNTIMES],
    ["1", TARGET, "0", "agnostic"],
    "Station must be an explicit-only external E2E target",
  );
  requireEqual(
    [env.E2E_OBSERVABLE_OUTCOME, env.E2E_ENVIRONMENT_OR_INFERENCE_ENDPOINT],
    [
      "Station Express installs managed Super VL vLLM and NemoClaw, serves sandbox inference, and removes job runtime",
      "Dedicated DGX Station GB300 with cached Nemotron 3.5 Super VL 120B",
    ],
    "Station evidence metadata must describe the Super VL default and cached model",
  );
  const checkout = step("Check out trusted Station controller");
  requireEqual(
    checkout,
    {
      name: "Check out trusted Station controller",
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      with: {
        repository: "NVIDIA/NemoClaw",
        ref: "${{ github.workflow_sha }}",
        "persist-credentials": false,
      },
    },
    "Station controller checkout must use the reviewed checkout action and trusted workflow revision without stored credentials",
  );
  requireEqual(
    step("Set up Node for Station controller"),
    {
      name: "Set up Node for Station controller",
      uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      with: { "node-version": "24.22.1" },
    },
    "Station controller must use the reviewed Node setup",
  );
  requireEqual(
    step("Install reviewed npm"),
    { name: "Install reviewed npm", uses: E2E_ACTION_PROVENANCE.reviewedNpmSetup.reference },
    "Station controller must install reviewed npm immutably",
  );
  const dispatch = step("Dispatch exact commit to Station through operator backend");
  requireEqual(
    dispatch.env,
    {
      E2E_ARTIFACT_DIR: "${{ runner.temp }}/e2e-artifacts/live/dgx-station-express",
      DGX_STATION_DISPATCH_CANDIDATE_SHA: "${{ inputs.checkout_sha || github.sha }}",
      DGX_STATION_DISPATCH_MANAGED_IMAGE_REVISION:
        "${{ needs.base-image-publication.outputs.managed_image_revision }}",
      DGX_STATION_DISPATCH_URL: "${{ vars.DGX_STATION_DISPATCH_URL }}",
    },
    "Station dispatch must bind separate candidate/image revisions and its own URL variable",
  );
  requireEqual(
    dispatch.run,
    "node --no-warnings tools/e2e/dgx-station-dispatch-client.mts",
    "Station dispatch must invoke only the fixed controller client",
  );
  const upload = step("Upload Station Express artifacts");
  requireEqual(upload.if, "always()", "Station must upload evidence on failure and cancellation");
  requireEqual(
    upload.with,
    {
      name: "e2e-dgx-station-express",
      path: "${{ runner.temp }}/e2e-artifacts/live/dgx-station-express/",
    },
    "Station artifacts must use their own namespace",
  );
  requireEqual(
    steps.map((entry) => entry.name),
    [
      "Check out trusted Station controller",
      "Set up Node for Station controller",
      "Install reviewed npm",
      "Dispatch exact commit to Station through operator backend",
      "Upload Station Express artifacts",
    ],
    "Station controller must run checkout, Node setup, npm setup, dispatch, and upload in order",
  );
  return errors;
}

/** Keep the physical Spark selector on its approved runner and candidate evidence path. */
export function validateSparkExpressWorkflowBoundary(workflow: unknown): string[] {
  const errors: string[] = [];
  const job = record(record(record(workflow).jobs)["spark-express-vllm"]);
  const steps = Array.isArray(job.steps) ? job.steps.map(record) : [];
  const step = (name: string) => steps.find((entry) => entry.name === name) ?? {};
  const requireEqual = (observed: unknown, expected: unknown, error: string) => {
    if (!isDeepStrictEqual(observed, expected)) errors.push(`Spark Express ${error}`);
  };
  requireEqual(
    job.if,
    "${{ always() && needs['base-image-publication'].result == 'success' && needs['generate-matrix'].result == 'success' && needs['package-openshell-sdk'].result == 'success' && github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch' && inputs.allow_dgx_spark_runner_queue && inputs.checkout_sha != '' && inputs.checkout_sha != inputs.base_sha && inputs.checkout_repository == github.repository && contains(fromJSON(needs.generate-matrix.outputs.selected_jobs), 'spark-express-vllm') && ((inputs.jobs == 'spark-express-vllm' && inputs.targets == '') || (inputs.targets == 'spark-express-vllm' && inputs.jobs == '')) }}",
    "requires an explicit same-repository candidate dispatch with Spark queue approval",
  );
  requireEqual(
    job.needs,
    ["base-image-publication", "generate-matrix", "package-openshell-sdk"],
    "must wait for authenticated planning, images and SDK packaging",
  );
  requireEqual(
    job["runs-on"],
    "linux-arm64-gpu-dgx-spark-gb10-protected-1",
    "must use the protected physical GB10 runner",
  );
  requireEqual(
    job.environment,
    "approve-dgx-spark-image-qualification",
    "must retain the Spark approval environment",
  );
  requireEqual(job.permissions, { contents: "read" }, "must retain read-only source permission");
  requireEqual(
    job.concurrency,
    { group: "llama-cpp-dgx-spark-protected-runner", "cancel-in-progress": false },
    "must share the non-cancelling protected Spark queue",
  );
  requireEqual(
    job["timeout-minutes"],
    215,
    "must enclose both serial test and cleanup deadlines plus setup",
  );
  const env = record(job.env);
  for (const [key, value] of Object.entries({
    E2E_TARGET_ID: "spark-express-vllm",
    E2E_DEFAULT_ENABLED: "0",
    E2E_GATEWAY_RUNTIMES: "docker",
    NEMOCLAW_CLI_BIN: "${{ github.workspace }}/bin/nemoclaw.js",
    NEMOCLAW_RUN_LIVE_E2E: "1",
    NEMOCLAW_GATEWAY_RUNTIME: "docker",
  }))
    requireEqual(env[key], value, `must bind ${key}`);
  requireEqual(
    step("Check out trusted Spark preparation"),
    {
      name: "Check out trusted Spark preparation",
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      with: {
        repository: "NVIDIA/NemoClaw",
        ref: "${{ github.workflow_sha }}",
        "persist-credentials": false,
      },
    },
    "must prepare the host from the trusted workflow revision",
  );
  requireEqual(
    step("Remove Docker credentials before candidate checkout"),
    {
      name: "Remove Docker credentials before candidate checkout",
      shell: "bash",
      run: "bash .github/scripts/docker-auth-cleanup.sh",
    },
    "must remove Docker credentials successfully before candidate checkout",
  );
  requireEqual(
    step("Check out Spark candidate"),
    {
      name: "Check out Spark candidate",
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      with: {
        repository: "${{ inputs.checkout_repository || github.repository }}",
        ref: "${{ inputs.checkout_sha || github.sha }}",
        "fetch-depth": 0,
        "persist-credentials": false,
      },
    },
    "must check out the authenticated candidate without stored credentials",
  );
  requireEqual(
    step("Install OpenShell CLI"),
    { name: "Install OpenShell CLI", run: "bash scripts/install-openshell.sh" },
    "must install OpenShell from trusted preparation code",
  );
  requireEqual(
    steps.map((entry) => entry.name),
    [
      "Check out trusted Spark preparation",
      "Authenticate to Docker Hub",
      "Download reviewed OpenShell SDK archive",
      "Prepare E2E workspace",
      "Install OpenShell CLI",
      "Remove Docker credentials before candidate checkout",
      "Check out Spark candidate",
      "Install reviewed OpenShell SDK archive without package credentials",
      "Restore exact-commit CLI artifact",
      "Run Spark Express and Muse qualification",
      "Upload Spark Express artifacts",
      "Clean up Docker auth",
    ],
    "must finish trusted preparation and credential removal before candidate checkout or execution",
  );
  const withoutAuth = {
    ...job,
    steps: steps.filter((entry) => entry.name !== "Authenticate to Docker Hub"),
  };
  if (/\bsecrets\b/iu.test(JSON.stringify(withoutAuth))) {
    errors.push("Spark Express must not expose workflow secrets outside trusted authentication");
  }
  requireEqual(
    step("Install reviewed OpenShell SDK archive without package credentials"),
    {
      name: "Install reviewed OpenShell SDK archive without package credentials",
      uses: E2E_ACTION_PROVENANCE.reviewedSdkInstall.reference,
    },
    "must install candidate dependencies with the pinned credential-free reviewed SDK action",
  );
  requireEqual(
    step("Restore exact-commit CLI artifact").with,
    {
      "provenance-json": "${{ needs.generate-matrix.outputs.cli_artifact_provenance }}",
    },
    "must restore the authenticated candidate CLI",
  );
  const execution = step("Run Spark Express and Muse qualification");
  requireEqual(
    execution.run,
    `set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
OPENSHELL_BIN="$(command -v openshell)"
export OPENSHELL_BIN
npx tsx tools/e2e/live-vitest-invocation.mts run \\
  --test-path test/e2e/live/dgx-express.test.ts --selector '^spark-express-vllm:'
`,
    "must run only the Spark cases with the candidate CLI",
  );
  requireEqual(execution["continue-on-error"], undefined, "must propagate test failures");
  const upload = step("Upload Spark Express artifacts");
  requireEqual(upload.if, "always()", "must retain artifacts after failure or cancellation");
  requireEqual(
    upload.uses,
    E2E_ACTION_PROVENANCE.uploadArtifacts.reference,
    "must use canonical artifact transport",
  );
  requireEqual(upload.with, undefined, "must use the canonical target artifact defaults");
  requireEqual(
    env.E2E_ARTIFACT_DIR,
    "${{ github.workspace }}/e2e-artifacts/live/spark-express-vllm",
    "must retain its own artifact namespace",
  );
  return errors;
}
