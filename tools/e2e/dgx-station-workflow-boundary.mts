// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

const TARGET = "dgx-station-express";
const TRUSTED_SELECTOR =
  "${{ always() && needs['base-image-publication'].result == 'success' && needs['base-image-publication'].outputs.managed_image_revision != '' && needs['generate-matrix'].result == 'success' && github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch' && (inputs.checkout_repository == '' || inputs.checkout_repository == github.repository) && contains(fromJSON(needs.generate-matrix.outputs.selected_jobs), 'dgx-station-express') && (inputs.jobs == 'dgx-station-express' || inputs.targets == 'dgx-station-express') }}";
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
  const checkout = step("Check out trusted Station controller");
  requireEqual(
    checkout.with,
    {
      repository: "NVIDIA/NemoClaw",
      ref: "${{ github.workflow_sha }}",
      "persist-credentials": false,
    },
    "Station controller checkout must use the trusted workflow revision without stored credentials",
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
    steps.length,
    4,
    "Station controller must contain only checkout, Node setup, dispatch, and upload",
  );
  return errors;
}
