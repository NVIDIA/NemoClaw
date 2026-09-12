// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { target } from "../registry/builder.ts";
import {
  buildExecutionInventory,
  listTargets,
  type E2eInventoryTarget,
  reconcileWorkflowExecutionDiscovery,
  sharedTarget,
} from "../../../tools/e2e/target-inventory.mts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const RUN_TARGETS = path.join(REPO_ROOT, "test/e2e/registry/run.ts");
const TSX = path.join(REPO_ROOT, "node_modules/.bin/tsx");

const WORKFLOW_FIXTURE: Extract<E2eInventoryTarget, { route: "workflow" }> = {
  id: "proof",
  route: "workflow",
  definition: {
    id: "proof",
    workflow: ".github/workflows/e2e.yaml",
    targetId: "proof",
    defaultEnabled: true,
    gatewayRuntimes: ["docker"],
    testFiles: ["test/e2e/live/proof.test.ts"],
    owningPaths: [],
    coverage: [
      {
        gatewayRuntimes: ["docker"],
        row: {
          id: "proof",
          variant: "",
          source: "retained-workflow",
          agentRuntime: "none",
          observableOutcome: "The proof completes",
          environmentOrInferenceEndpoint: "Linux Docker host",
          unresolvedReason: "",
        },
      },
    ],
  },
};

function runTargetCli(args: string[]) {
  return spawnSync(TSX, [RUN_TARGETS, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: Number(process.env.E2E_SPAWN_TIMEOUT_MS ?? 60_000),
  });
}

const EXTERNAL_WORKFLOW_FIXTURE: Extract<E2eInventoryTarget, { route: "external-workflow" }> = {
  id: "external-proof",
  route: "external-workflow",
  definition: {
    id: "external-proof",
    workflow: ".github/workflows/proof.yaml",
    job: "prove",
    tests: [{ file: "test/e2e-runtime/proof.test.ts", project: "integration" }],
  },
};

const MANUAL_FIXTURE: Extract<E2eInventoryTarget, { route: "manual" }> = {
  id: "manual-proof",
  route: "manual",
  definition: {
    id: "manual-proof",
    tests: [{ file: "test/e2e/live/manual-proof.test.ts", project: "e2e-live" }],
    instructions: "test/e2e/README.md#manual-proof",
    prerequisites: ["A prepared local test host"],
  },
};

describe("deterministic target registry", () => {
  it.each([
    { instructions: "", prerequisites: ["A prepared host"] },
    { instructions: "test/e2e/README.md", prerequisites: [] },
    { instructions: "test/e2e/README.md", prerequisites: [" "] },
  ])("rejects a manual target without instructions or prerequisites: %j", (requirements) => {
    const entry = MANUAL_FIXTURE;
    expect(() =>
      buildExecutionInventory([
        {
          ...entry,
          definition: { ...entry.definition, ...requirements },
        },
      ]),
    ).toThrow("requires instructions and prerequisites");
  });

  it("rejects a manual declaration without an executable test file", () => {
    const entry = MANUAL_FIXTURE;
    expect(() =>
      buildExecutionInventory([
        {
          ...entry,
          definition: { ...entry.definition, tests: [] },
        },
      ]),
    ).toThrow("requires test files");
  });

  it("retains the workflow owner and Vitest project of an external test", () => {
    const entry = EXTERNAL_WORKFLOW_FIXTURE;
    expect([...buildExecutionInventory([entry]).values()]).toEqual([entry]);
  });

  it.each([
    { workflow: "../outside.yaml", job: "prove" },
    { workflow: ".github/workflows/proof.yaml", job: "" },
  ])("rejects an external target without a repository workflow job: %j", (owner) => {
    const entry = EXTERNAL_WORKFLOW_FIXTURE;
    expect(() =>
      buildExecutionInventory([{ ...entry, definition: { ...entry.definition, ...owner } }]),
    ).toThrow("requires a workflow job owner");
  });

  it("rejects an external target without tests", () => {
    const entry = EXTERNAL_WORKFLOW_FIXTURE;
    expect(() =>
      buildExecutionInventory([{ ...entry, definition: { ...entry.definition, tests: [] } }]),
    ).toThrow("requires test files");
  });

  it("rejects an external test path outside the test directory", () => {
    const entry = EXTERNAL_WORKFLOW_FIXTURE;
    expect(() =>
      buildExecutionInventory([
        {
          ...entry,
          definition: {
            ...entry.definition,
            tests: [{ file: "../outside.test.ts", project: "integration" }],
          },
        },
      ]),
    ).toThrow("has an invalid test path");
  });

  it("should reject duplicate target IDs", () => {
    const first = target("duplicate-id")
      .manifest("test/e2e/manifests/openclaw-nvidia.yaml")
      .build();
    const second = target("duplicate-id").manifest("synthetic/second-manifest.yaml").build();

    expect(() =>
      buildExecutionInventory(
        [first, second].map((definition) => ({
          id: definition.id,
          route: "typed" as const,
          definition,
        })),
      ),
    ).toThrow(/duplicate-id/);
  });

  it("rejects a typed target that reuses a shared target ID", () => {
    const shared = sharedTarget("vllm-docker-storage");
    const typed = target(shared.id).build();
    expect(() =>
      buildExecutionInventory([
        { id: shared.id, route: "shared", definition: shared },
        { id: typed.id, route: "typed", definition: typed },
      ]),
    ).toThrow("Duplicate target IDs: vllm-docker-storage");
  });

  it("rejects coverage attached to another workflow target", () => {
    const entry = WORKFLOW_FIXTURE;
    const definition = {
      ...entry.definition,
      coverage: entry.definition.coverage.map((coverage) => ({
        ...coverage,
        row: { ...coverage.row, id: "another-job" },
      })),
    };
    expect(() => buildExecutionInventory([{ ...entry, definition }])).toThrow(
      "Workflow coverage identity differs from target",
    );
  });

  it("rejects a workflow target without execution coverage", () => {
    const entry = WORKFLOW_FIXTURE;
    expect(() =>
      buildExecutionInventory([{ ...entry, definition: { ...entry.definition, coverage: [] } }]),
    ).toThrow("requires execution coverage");
  });

  it("rejects an undisposed workflow job and a missing registered job", () => {
    expect(
      reconcileWorkflowExecutionDiscovery(
        { workflowJobs: ["unexpected"], liveTestToJobs: new Map() },
        { workflowJobs: ["required"], liveTestToJobs: new Map() },
      ),
    ).toEqual([
      "Discovered workflow job unexpected has no inventory disposition",
      "Registered workflow job required is missing",
    ]);
  });

  it("rejects a workflow that dispatches a registered test through another job", () => {
    expect(
      reconcileWorkflowExecutionDiscovery(
        {
          workflowJobs: ["owner"],
          liveTestToJobs: new Map([["test/e2e/live/proof.test.ts", ["other"]]]),
        },
        {
          workflowJobs: ["owner"],
          liveTestToJobs: new Map([["test/e2e/live/proof.test.ts", ["owner"]]]),
        },
      ),
    ).toEqual(["Workflow test route differs from the inventory: test/e2e/live/proof.test.ts"]);
  });

  it("should reject target IDs that are unsafe for workflow regex filters and artifact paths", () => {
    const unsafe = target("bad.id").manifest("test/e2e/manifests/openclaw-nvidia.yaml").build();

    expect(() =>
      buildExecutionInventory([{ id: unsafe.id, route: "typed", definition: unsafe }]),
    ).toThrow(/not safe for workflow regex filters/);

    const result = runTargetCli(["--emit-live-matrix", "--targets", "../escape"]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(
      /Selected target ID '\.\.\/escape' is not safe/,
    );
  });

  // source-shape-contract: compatibility -- The target CLI must reject unknown selectors with actionable registered choices
  it("should return actionable unknown target error", () => {
    const result = runTargetCli(["--emit-live-matrix", "--targets", "does-not-exist"]);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toMatch(/does-not-exist/);
    expect(output).toMatch(/Available targets:/);
    expect(listTargets().every((registered) => output.includes(registered.id))).toBe(true);
  });

  // source-shape-contract: compatibility -- The target CLI must preserve requested ordering for multiple live selectors
  it("CLI should emit multiple selected live matrix entries", () => {
    const selectedIds = listTargets()
      .slice(0, 2)
      .map((registered) => registered.id);
    const result = runTargetCli(["--emit-live-matrix", "--targets", selectedIds.join(",")]);

    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.map((entry: { id: string }) => entry.id)).toEqual(selectedIds);
  });
});
