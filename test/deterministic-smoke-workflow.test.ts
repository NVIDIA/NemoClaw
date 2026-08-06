// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { type CompositeAction, readYaml, type WorkflowJob } from "./helpers/e2e-workflow-contract";

type Workflow = {
  jobs: Record<string, WorkflowJob & { needs?: string | string[] }>;
};

const buildTypecheck = readYaml<CompositeAction>(".github/actions/ci-build-typecheck/action.yaml");
const pr = readYaml<Workflow>(".github/workflows/pr.yaml");
const main = readYaml<Workflow>(".github/workflows/main.yaml");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts: Record<string, string>;
};

function requiredStep(stepName: string) {
  const step = buildTypecheck.runs.steps.find((candidate) => candidate.name === stepName);
  expect(step, `Missing build-typecheck step: ${stepName}`).toBeDefined();
  return step!;
}

describe("deterministic smoke workflow floor", () => {
  // source-shape-contract: security -- Removing live E2E gating must retain one hermetic built-artifact smoke floor inside the required aggregate
  it("keeps the deterministic smoke floor in the required build and typecheck action", () => {
    const smoke = requiredStep("Run deterministic smoke floor");
    const packageContracts = requiredStep("Verify compiled package contracts");
    const smokeIndex = buildTypecheck.runs.steps.indexOf(smoke);
    const packageContractIndex = buildTypecheck.runs.steps.indexOf(packageContracts);

    expect(smoke.run).toBe("npm run test:smoke");
    expect(packageJson.scripts["test:smoke"]).toBe(
      "npm run clean:cli && npm --prefix nemoclaw run clean && npm run build:cli && npm --prefix nemoclaw run build && vitest run --project package-contract test/package-contract/deterministic-smoke.test.ts",
    );
    expect(packageJson.scripts["test:smoke"]).not.toMatch(
      /live-e2e|workflow run|brev|docker|podman/iu,
    );
    expect(smokeIndex).toBeLessThan(packageContractIndex);
    expect(packageContracts.run).toBe("npx vitest run --project package-contract");
    expect(pr.jobs.checks.needs).toContain("build-typecheck");
    expect(main.jobs.checks.needs).toContain("build-typecheck");
  });
});
