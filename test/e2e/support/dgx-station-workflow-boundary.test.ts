// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { validateDgxStationDispatchBoundary } from "../../../tools/e2e/dgx-station-workflow-boundary.mts";
import { validateE2eWorkflow } from "../../../tools/e2e/workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract.ts";

describe("Station workflow authorization and ownership", () => {
  it("accepts the checked-in explicit Station controller", () => {
    expect(validateDgxStationDispatchBoundary(readWorkflow())).toEqual([]);
    expect(validateE2eWorkflow(readWorkflow())).toEqual([]);
  });

  it.each([
    ["if", "${{ github.event_name == 'pull_request' }}", "trusted main workflow"],
    ["needs", ["generate-matrix"], "managed-image publication"],
    ["runs-on", "self-hosted", "GitHub-hosted"],
    ["timeout-minutes", 360, "bounded deadline"],
    ["permissions", { contents: "write", "id-token": "write" }, "only source read"],
    [
      "concurrency",
      { group: "jetson-nvmap-gpu-dispatch", "cancel-in-progress": true },
      "own queue",
    ],
    [
      "env",
      { E2E_JOB: "1", E2E_TARGET_ID: "dgx-station-express", E2E_DEFAULT_ENABLED: "1" },
      "explicit-only",
    ],
  ])("rejects an unsafe %s policy", (field, value, expected) => {
    const workflow = readWorkflow();
    const job = (workflow.jobs as Record<string, Record<string, unknown>>)["dgx-station-express"];
    job[field as string] = value;
    expect(validateDgxStationDispatchBoundary(workflow).join("\n")).toContain(expected);
  });

  it.each([
    [
      0,
      "with",
      {
        repository: "NVIDIA/NemoClaw",
        ref: "${{ inputs.checkout_sha }}",
        "persist-credentials": true,
      },
      "trusted workflow revision",
    ],
    [2, "env", { DGX_STATION_DISPATCH_URL: "${{ vars.JETSON_DISPATCH_URL }}" }, "own URL variable"],
    [2, "run", "bash install.sh", "fixed controller client"],
    [3, "if", "success()", "failure and cancellation"],
    [3, "with", { name: "e2e-jetson-nvmap-gpu" }, "own namespace"],
  ])("rejects an unsafe controller step %s %s", (index, field, value, expected) => {
    const workflow = readWorkflow();
    const job = (workflow.jobs as Record<string, { steps: Record<string, unknown>[] }>)[
      "dgx-station-express"
    ];
    job.steps[index as number][field as string] = value;
    expect(validateDgxStationDispatchBoundary(workflow).join("\n")).toContain(expected);
  });
});
