// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { reconcileWorkflowConsumers } from "../../../tools/e2e/workflow-execution-discovery.mts";
import type { E2eInventoryTarget } from "../../../tools/e2e/target-inventory.mts";

const file = "test/e2e/live/proof.test.ts";
const workflow = ".github/workflows/proof.yaml";
const target: E2eInventoryTarget = {
  id: "proof",
  route: "external-workflow",
  definition: { id: "proof", workflow, job: "proof", tests: [{ file, project: "e2e-live" }] },
};
const source = (run: string, job = "proof") =>
  new Map([[workflow, YAML.stringify({ jobs: { [job]: { steps: [{ run }] } } })]]);

describe("workflow execution discovery", () => {
  it("accepts a registered direct consumer without importing the test", () => {
    expect(
      reconcileWorkflowConsumers(source(`npx vitest run ${file}`), [target], () => true),
    ).toEqual([]);
  });

  it("rejects an unregistered live test consumer", () => {
    expect(reconcileWorkflowConsumers(source(`npx vitest run ${file}`), [], () => true)).toEqual([
      `${workflow}:proof: test consumer has no inventory route: ${file}`,
    ]);
  });

  it("rejects a registered test moved to another job", () => {
    const errors = reconcileWorkflowConsumers(
      source(`npx vitest run ${file}`, "other"),
      [target],
      () => true,
    );
    expect(errors).toContain(`proof: registered workflow job is missing: ${workflow}:proof`);
    expect(errors).toContain(`${workflow}:other: test consumer has no inventory route: ${file}`);
  });

  it("rejects a test removed from its registered job", () => {
    expect(reconcileWorkflowConsumers(source("echo complete"), [target], () => true)).toEqual([
      `proof: workflow job no longer references ${file}`,
    ]);
  });

  it("rejects a missing registered test file", () => {
    expect(
      reconcileWorkflowConsumers(source(`npx vitest run ${file}`), [target], () => false),
    ).toEqual([`proof: registered test file is missing: ${file}`]);
  });

  it("requires a delegated script to exist and remain in its owning job", () => {
    const entrypoint = "tools/e2e/dispatch.mts";
    const delegated = { ...target, definition: { ...target.definition, entrypoint } };
    expect(
      reconcileWorkflowConsumers(source(`node ${entrypoint}`), [delegated], () => true),
    ).toEqual([]);
    expect(reconcileWorkflowConsumers(source("echo complete"), [delegated], () => true)).toContain(
      `proof: delegated entry point is missing from its workflow job: ${entrypoint}`,
    );
  });

  it("rejects another workflow invoking a registered packaged-image test", () => {
    const packaged = "test/e2e-runtime/image.test.ts";
    const registration: E2eInventoryTarget = {
      ...target,
      definition: { ...target.definition, tests: [{ file: packaged, project: "integration" }] },
    };
    const workflows = source(`npx vitest run ${packaged}`);
    workflows.set(".github/workflows/other.yaml", workflows.get(workflow)!);
    expect(reconcileWorkflowConsumers(workflows, [registration], () => true)).toEqual([
      `.github/workflows/other.yaml:proof: test consumer has no inventory route: ${packaged}`,
    ]);
  });
});
