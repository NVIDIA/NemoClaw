// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  PREPARE_E2E_ACTION,
  PREPARE_E2E_STEP,
  validatePrepareE2eAction,
  validatePrepareE2eInvocations,
} from "../../../tools/e2e/prepare-e2e-workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";

type WorkflowStep = Record<string, unknown> & {
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type Workflow = {
  jobs: Record<string, { steps?: WorkflowStep[] }>;
};

describe("prepare-e2e workflow boundary", () => {
  it("keeps one canonical bootstrap invocation on every E2E execution job", () => {
    expect(validatePrepareE2eAction()).toEqual([]);
    expect(validatePrepareE2eInvocations(readWorkflow())).toEqual([]);
  });

  it("rejects action implementation drift", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prepare-e2e-action-"));
    const actionPath = path.join(directory, "action.yaml");
    const source = fs.readFileSync(
      path.join(process.cwd(), ".github/actions/prepare-e2e/action.yaml"),
      "utf8",
    );
    const action = YAML.parse(source) as Record<string, unknown>;
    const runs = action.runs as { steps: WorkflowStep[] };
    runs.steps.find((step) => step.name === "Set up Node")!.uses = "actions/setup-node@v6";
    runs.steps.find((step) => step.name === "Install root dependencies")!.run = "npm install";
    runs.steps.find((step) => step.name === "Build CLI")!.run = "echo skipped";
    fs.writeFileSync(actionPath, YAML.stringify(action));

    try {
      expect(validatePrepareE2eAction(actionPath)).toContain(
        "prepare-e2e must pin Node 22, run npm ci, and conditionally build the CLI",
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects semantic-neutral content drift from the immutable action pin", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prepare-e2e-provenance-"));
    const actionPath = path.join(directory, "action.yaml");
    const source = fs.readFileSync(
      path.join(process.cwd(), ".github/actions/prepare-e2e/action.yaml"),
      "utf8",
    );
    fs.writeFileSync(actionPath, `${source}# unreviewed drift\n`);

    try {
      expect(validatePrepareE2eAction(actionPath)).toEqual([
        "prepare-e2e content must match the action reviewed at its immutable commit pin",
      ]);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects build-mode, duplicate-step, and ordering drift", () => {
    const workflow = readWorkflow() as Workflow;
    const buildJob = workflow.jobs["sandbox-operations"];
    const buildPrepare = buildJob.steps!.find((step) => step.uses === PREPARE_E2E_ACTION)!;
    buildPrepare.with = { "build-cli": "false" };
    buildJob.steps!.splice(buildJob.steps!.indexOf(buildPrepare), 0, {
      name: "Build CLI",
      run: "npm run build:cli",
    });

    const noBuildJob = workflow.jobs["docs-validation"];
    const noBuildPrepare = noBuildJob.steps!.find((step) => step.uses === PREPARE_E2E_ACTION)!;
    delete noBuildPrepare.with;

    const untrustedJob = workflow.jobs["inference-routing"];
    const untrustedPrepare = untrustedJob.steps!.find((step) => step.uses === PREPARE_E2E_ACTION)!;
    untrustedPrepare.uses = "./.github/actions/prepare-e2e";

    const orderedJob = workflow.jobs["network-policy"];
    const orderedPrepareIndex = orderedJob.steps!.findIndex(
      (step) => step.name === PREPARE_E2E_STEP,
    );
    const [orderedPrepare] = orderedJob.steps!.splice(orderedPrepareIndex, 1);
    orderedJob.steps!.unshift(orderedPrepare);

    expect(validatePrepareE2eInvocations(workflow)).toEqual(
      expect.arrayContaining([
        "sandbox-operations prepare-e2e must use the default CLI build",
        "sandbox-operations prepare-e2e invocation must not override its canonical contract",
        "sandbox-operations must not duplicate prepare-e2e step 'Build CLI'",
        "docs-validation prepare-e2e must set build-cli to false",
        "docs-validation prepare-e2e invocation must not override its canonical contract",
        "inference-routing must not load prepare-e2e from the target checkout",
        "inference-routing must use prepare-e2e exactly once",
        "network-policy must check out the repository before prepare-e2e",
        "network-policy must authenticate to Docker Hub before prepare-e2e",
      ]),
    );
  });
});
