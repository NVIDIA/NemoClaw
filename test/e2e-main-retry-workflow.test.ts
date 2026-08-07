// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import YAML from "yaml";
import { describe, expect, it } from "vitest";

type Step = {
  name?: string;
  uses?: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
  with?: Record<string, unknown>;
};

type Workflow = {
  name: string;
  on: { workflow_run: { workflows: string[]; types: string[] } };
  permissions: Record<string, string>;
  jobs: {
    evaluate: {
      if: string;
      concurrency: Record<string, unknown>;
      permissions: Record<string, string>;
      steps: Step[];
    };
  };
};

function workflow(): Workflow {
  return YAML.parse(fs.readFileSync(".github/workflows/e2e-main-retry.yaml", "utf8")) as Workflow;
}

function step(name: string): Step {
  return workflow().jobs.evaluate.steps.find((candidate) => candidate.name === name)!;
}

describe("main E2E retry workflow", () => {
  // source-shape-contract: security -- The write-capable retry controller must subscribe only to the reviewed E2E workflow completion event
  it("subscribes only to completed E2E workflow runs", () => {
    const value = workflow();
    expect(value.name).toBe("E2E / Main Retry");
    expect(value.on).toEqual({ workflow_run: { workflows: ["E2E"], types: ["completed"] } });
    expect(value.permissions).toEqual({});
  });

  // source-shape-contract: security -- Source identity and attempt guards prevent fork, PR, manual, and out-of-range retry writes
  it("accepts only trusted main push attempts one through three", () => {
    const guard = workflow().jobs.evaluate.if;
    for (const fragment of [
      "github.run_attempt == 1",
      "github.repository == 'NVIDIA/NemoClaw'",
      "github.event.workflow_run.status == 'completed'",
      "github.event.workflow_run.event == 'push'",
      "github.event.workflow_run.path == '.github/workflows/e2e.yaml'",
      "github.event.workflow_run.display_title == 'E2E main'",
      "github.event.workflow_run.head_branch == 'main'",
      "github.event.workflow_run.head_repository.full_name == 'NVIDIA/NemoClaw'",
      "github.event.workflow_run.run_attempt >= 1",
      "github.event.workflow_run.run_attempt <= 3",
    ]) {
      expect(guard).toContain(fragment);
    }
    expect(guard).not.toContain("pull_request");
    expect(guard).not.toContain("workflow_dispatch");
    expect(guard).not.toContain("||");
    expect(guard.match(/&&/gu)).toHaveLength(9);
  });

  // source-shape-contract: security -- Source-run serialization and least privilege prevent concurrent or broader GitHub mutations
  it("uses one source-run concurrency identity and least privileges", () => {
    const job = workflow().jobs.evaluate;
    expect(job.concurrency).toEqual({
      group: "e2e-main-retry-${{ github.event.workflow_run.id }}",
      "cancel-in-progress": false,
    });
    expect(job.permissions).toEqual({ actions: "write", contents: "read" });
  });

  // source-shape-contract: security -- Trusted default-branch controller code must run before any write-capable GitHub request
  it("checks out trusted controller code and invokes the bounded helper", () => {
    expect(step("Checkout trusted retry controller")).toMatchObject({
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      with: { ref: "${{ github.workflow_sha }}", "persist-credentials": false },
    });
    expect(step("Evaluate main E2E retry")).toMatchObject({
      env: {
        GITHUB_TOKEN: "${{ github.token }}",
        RETRY_EVIDENCE_PATH: "${{ runner.temp }}/e2e-main-retry-evidence.json",
        SOURCE_RUN_ID: "${{ github.event.workflow_run.id }}",
      },
    });
    expect(step("Evaluate main E2E retry").run).toContain("tools/e2e/main-run-retry.mts");
  });

  // source-shape-contract: security -- The bounded upload step must run after evaluation failure without widening artifact paths
  it("runs the bounded evidence-upload step after evaluation failure", () => {
    expect(step("Upload retry evidence")).toMatchObject({
      if: "${{ always() }}",
      uses: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
      with: {
        name: "e2e-main-retry-${{ github.event.workflow_run.id }}-${{ github.event.workflow_run.run_attempt }}",
        path: "${{ runner.temp }}/e2e-main-retry-evidence.json",
        "if-no-files-found": "warn",
        "retention-days": 14,
      },
    });
  });
});
