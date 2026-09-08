// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { UPLOAD_E2E_ARTIFACTS_ACTION } from "../../../tools/e2e/upload-e2e-artifacts-workflow-boundary.mts";
import { validateJetsonDispatchBoundary } from "../../../tools/e2e/workflow-boundary.mts";

const REQUIRED_SELECTOR =
  "${{ always() && needs['base-image-publication'].result == 'success' && needs['base-image-publication'].outputs.managed_image_revision != '' && needs['generate-matrix'].result == 'success' && github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && (github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.allow_jetson_dispatch && (inputs.checkout_repository == '' || inputs.checkout_repository == github.repository) && ((inputs.jobs == '' && inputs.targets == '') || contains(fromJSON(needs.generate-matrix.outputs.selected_jobs), 'jetson-nvmap-gpu')))) }}";

function syntheticJetsonWorkflow(selector = REQUIRED_SELECTOR): unknown {
  return {
    on: {
      workflow_dispatch: {
        inputs: {
          allow_jetson_dispatch: {
            default: false,
            description:
              "Requires the operator-owned dispatch backend, JETSON_DISPATCH_URL, and test/e2e/docs/jetson-dispatch.md",
            type: "boolean",
          },
        },
      },
    },
    jobs: {
      "base-image-publication": {
        outputs: {
          managed_image_revision: "${{ steps.validate_managed_cohort.outputs.revision }}",
        },
      },
      "jetson-nvmap-gpu": {
        concurrency: { group: "jetson-nvmap-gpu-dispatch", "cancel-in-progress": false },
        if: selector,
        needs: ["base-image-publication", "generate-matrix"],
        permissions: { contents: "read", "id-token": "write" },
        "runs-on": "ubuntu-latest",
        steps: [
          {
            name: "Check out trusted Jetson controller",
            uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
            with: {
              repository: "NVIDIA/NemoClaw",
              ref: "${{ github.workflow_sha }}",
              "persist-credentials": false,
            },
          },
          {
            name: "Set up Node for Jetson controller",
            uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
            with: { "node-version": 22 },
          },
          {
            env: {
              E2E_ARTIFACT_DIR: "${{ runner.temp }}/e2e-artifacts/live/jetson-nvmap-gpu",
              JETSON_DISPATCH_CANDIDATE_SHA: "${{ inputs.checkout_sha || github.sha }}",
              JETSON_DISPATCH_MANAGED_IMAGE_REVISION:
                "${{ needs.base-image-publication.outputs.managed_image_revision }}",
              JETSON_DISPATCH_URL: "${{ vars.JETSON_DISPATCH_URL }}",
            },
            name: "Dispatch exact commit to Jetson through operator backend",
            run: "node --experimental-strip-types --no-warnings tools/e2e/jetson-dispatch-client.mts",
          },
          {
            if: "always()",
            name: "Upload Jetson nvmap GPU artifacts",
            uses: UPLOAD_E2E_ARTIFACTS_ACTION,
            with: {
              name: "e2e-jetson-nvmap-gpu",
              path: "${{ runner.temp }}/e2e-artifacts/live/jetson-nvmap-gpu/",
            },
          },
        ],
        "timeout-minutes": 60,
      },
    },
  };
}

describe("Jetson managed-image revision boundary", () => {
  it("rejects dispatch without an ARM-qualified managed-image revision", () => {
    expect(validateJetsonDispatchBoundary(syntheticJetsonWorkflow())).toEqual([]);

    const selectorWithoutRevision = REQUIRED_SELECTOR.replace(
      " && needs['base-image-publication'].outputs.managed_image_revision != ''",
      "",
    );
    expect(
      validateJetsonDispatchBoundary(syntheticJetsonWorkflow(selectorWithoutRevision)),
    ).toContain(
      "jetson-nvmap-gpu job must run on trusted main pushes and require opt-in for same-repository manual selections",
    );
  });
});
