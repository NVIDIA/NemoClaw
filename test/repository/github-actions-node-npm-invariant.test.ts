// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const GITHUB_ROOT = path.join(REPO_ROOT, ".github");
const SETUP_NODE = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const REVIEWED_NPM_ACTION = "setup-reviewed-npm";
const AUDIT_ACTION = ".github/actions/ci-reviewed-npm-audit/action.yaml";

type Step = { uses?: string; with?: Record<string, unknown> };
type ActionDocument = { runs?: { steps?: Step[] } };
type WorkflowDocument = { jobs?: Record<string, { steps?: Step[] }> };
type StepGroup = { file: string; label: string; steps: Step[] };

function yamlFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);
    return entry.isDirectory()
      ? yamlFiles(candidate)
      : /\.ya?ml$/u.test(entry.name)
        ? [candidate]
        : [];
  });
}

function stepGroups(file: string): StepGroup[] {
  const document = YAML.parse(fs.readFileSync(file, "utf8")) as ActionDocument & WorkflowDocument;
  return [
    ...Object.entries(document.jobs ?? {}).flatMap(([label, definition]) =>
      definition.steps ? [{ file, label, steps: definition.steps }] : [],
    ),
    ...(document.runs?.steps ? [{ file, label: "runs", steps: document.runs.steps }] : []),
  ];
}

const identity = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "ci/reviewed-npm-audit.json"), "utf8"),
) as { nodeVersion: string; npmVersion: string };
const setupNodeSteps = yamlFiles(GITHUB_ROOT)
  .flatMap(stepGroups)
  .flatMap(({ file, label, steps }) =>
    steps.flatMap((step, index) =>
      step.uses?.startsWith("actions/setup-node@") ? [{ file, label, steps, step, index }] : [],
    ),
  );

describe("controlled setup-node environments", () => {
  // source-shape-contract: security -- Every controlled setup-node environment must install the integrity-bound npm release before later workflow steps execute.
  it("selects the reviewed Node and npm identities before further steps", () => {
    const setupIdentities = setupNodeSteps.map(({ step }) => [
      step.uses,
      String(step.with?.["node-version"]),
    ]);
    const reviewedNpmSteps = setupNodeSteps
      .filter(({ file }) => path.relative(REPO_ROOT, file) !== AUDIT_ACTION)
      .map(({ steps, index }) => steps[index + 1]?.uses);

    expect(identity).toMatchObject({ nodeVersion: "24.18.1", npmVersion: "12.0.2" });
    expect(
      setupIdentities.every(
        ([action, node]) => action === SETUP_NODE && node === identity.nodeVersion,
      ),
    ).toBe(true);
    expect(reviewedNpmSteps.every((action) => action?.includes(REVIEWED_NPM_ACTION))).toBe(true);
  });
});
