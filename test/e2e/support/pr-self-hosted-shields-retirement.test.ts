// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

type WorkflowStep = {
  env?: Record<string, string>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  env?: Record<string, string>;
  if?: string;
  needs?: string;
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  "runs-on"?: string;
  steps?: WorkflowStep[];
  "timeout-minutes"?: number;
};

type Workflow = { jobs: Record<string, WorkflowJob> };

const WORKFLOW_PATH = ".github/workflows/pr-self-hosted.yaml";

function workflow(): Workflow {
  return YAML.parse(readFileSync(WORKFLOW_PATH, "utf8")) as Workflow;
}

describe("released Shields retirement PR qualification", () => {
  // source-shape-contract: security -- The copied-branch selector must bind the exact PR head and a closed owning-path set before uncredentialed self-hosted candidate code can execute
  it("selects only owning changes from an exact copied PR head", () => {
    const selector = workflow().jobs["select-shields-retirement-upgrade"];
    const selection = selector?.steps?.find(
      (step) => step.name === "Select the released Shields retirement upgrade from PR files",
    );

    expect(selector).toMatchObject({
      outputs: { selected: "${{ steps.changed.outputs.selected }}" },
      permissions: { contents: "read", "pull-requests": "read" },
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 5,
    });
    expect(selection?.env).toEqual({ GH_TOKEN: "${{ github.token }}" });
    expect(selection?.run).toContain('[[ "$head_sha" == "$GITHUB_SHA" ]]');
    expect(selection?.run).toContain(
      '.filename == "test/e2e/live/shields-retirement-upgrade.test.ts"',
    );
    expect(selection?.run).toContain(
      '.filename == "src/lib/state/migrations/removed-immutability.ts"',
    );
    expect(selection?.run).toContain('.filename == ".github/workflows/pr-self-hosted.yaml"');
    expect(selection?.run).not.toContain("NVIDIA_INFERENCE_API_KEY");
    expect(selection?.run).not.toContain("DOCKERHUB_TOKEN");
  });

  // source-shape-contract: security -- The copied-branch job must run only the exact catalogue target without repository or provider secrets while preserving the reviewed checkout and action pins
  it("runs the exact catalogue target without repository secrets", () => {
    const job = workflow().jobs["shields-retirement-upgrade"];
    const run = job?.steps?.find(
      (step) => step.name === "Run the released Shields retirement upgrade",
    );

    expect(job).toMatchObject({
      if: "${{ needs.select-shields-retirement-upgrade.outputs.selected == 'true' }}",
      needs: "select-shields-retirement-upgrade",
      "runs-on": "linux-amd64-cpu4",
      "timeout-minutes": 130,
      env: {
        E2E_TARGET_ID: "shields-retirement-upgrade",
        E2E_WORKLOAD_SOURCE: "local-dockerfile",
        NEMOCLAW_CLI_BIN: "${{ github.workspace }}/bin/nemoclaw.js",
        NEMOCLAW_E2E_EXPECTED_SHA: "${{ github.sha }}",
        NEMOCLAW_RUN_LIVE_E2E: "1",
      },
    });
    expect(job?.steps?.find((step) => step.name === "Checkout exact PR head")).toMatchObject({
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      with: { "persist-credentials": false, ref: "${{ github.sha }}" },
    });
    expect(
      job?.steps?.find((step) => step.name === "Bind E2E correlation identity")?.run,
    ).toContain("NEMOCLAW_E2E_CORRELATION_ID");
    expect(run?.run).toContain(
      "npx tsx tools/e2e/target-catalogue.mts run \\\n  shields-retirement-upgrade \\\n  test/e2e/live/shields-retirement-upgrade.test.ts",
    );
    expect(JSON.stringify(job)).not.toContain("secrets.");
    expect(JSON.stringify(job)).not.toContain("github.token");
  });
});
