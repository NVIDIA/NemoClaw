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
  jobs: Record<string, { env?: Record<string, unknown>; steps?: WorkflowStep[] }>;
};

describe("prepare-e2e workflow boundary", () => {
  it("requires one workspace preparation step per E2E job and one candidate CLI build in generate-matrix", () => {
    expect(validatePrepareE2eAction()).toEqual([]);
    expect(validatePrepareE2eInvocations(readWorkflow())).toEqual([]);
  });

  it("keeps the installer-backed security posture matrix on the no-build bootstrap", () => {
    const workflow = readWorkflow() as Workflow;
    const securityPostureJob = workflow.jobs["security-posture"];
    const prepare = securityPostureJob.steps!.find((step) => step.uses === PREPARE_E2E_ACTION)!;
    delete prepare.with;

    expect(validatePrepareE2eInvocations(workflow)).toEqual(
      expect.arrayContaining([
        "security-posture prepare-e2e must set build-cli to false",
        "security-posture prepare-e2e invocation must not override its canonical contract",
      ]),
    );
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
    runs.steps.find((step) => step.name === "Set up Node")!.uses = "actions/setup-node@v7";
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
    const artifactProducer = workflow.jobs["generate-matrix"];
    const producerPrepare = artifactProducer.steps!.find(
      (step) => step.uses === PREPARE_E2E_ACTION,
    )!;
    producerPrepare.with = { "build-cli": "false" };

    const consumerJob = workflow.jobs["sandbox-operations"];
    const consumerPrepare = consumerJob.steps!.find((step) => step.uses === PREPARE_E2E_ACTION)!;
    delete consumerPrepare.with;
    consumerJob.steps!.splice(consumerJob.steps!.indexOf(consumerPrepare), 0, {
      name: "Build CLI",
      run: "npm run build:cli",
    });

    const noBuildJob = workflow.jobs["bootstrap-install-smoke"];
    const noBuildPrepare = noBuildJob.steps!.find((step) => step.uses === PREPARE_E2E_ACTION)!;
    delete noBuildPrepare.with;

    const sharedJob = workflow.jobs["shared-e2e"];
    const sharedPrepare = sharedJob.steps!.find((step) => step.uses === PREPARE_E2E_ACTION)!;
    delete sharedPrepare.with;
    sharedJob.env!.E2E_EXECUTION_PROFILE = "credential-free";
    sharedJob.env!.E2E_JOB = "1";

    const untrustedJob = workflow.jobs["inference-routing"];
    const untrustedPrepare = untrustedJob.steps!.find((step) => step.uses === PREPARE_E2E_ACTION)!;
    untrustedPrepare.uses = "./.github/actions/prepare-e2e";

    const orderedJob = workflow.jobs["brave-search"];
    const orderedPrepareIndex = orderedJob.steps!.findIndex(
      (step) => step.name === PREPARE_E2E_STEP,
    );
    const [orderedPrepare] = orderedJob.steps!.splice(orderedPrepareIndex, 1);
    orderedJob.steps!.unshift(orderedPrepare);

    expect(validatePrepareE2eInvocations(workflow)).toEqual(
      expect.arrayContaining([
        "generate-matrix prepare-e2e must own the only default CLI build",
        "generate-matrix prepare-e2e invocation must not override its canonical contract",
        "sandbox-operations prepare-e2e must set build-cli to false",
        "sandbox-operations prepare-e2e invocation must not override its canonical contract",
        "sandbox-operations must not duplicate prepare-e2e step 'Build CLI'",
        "bootstrap-install-smoke prepare-e2e must set build-cli to false",
        "bootstrap-install-smoke prepare-e2e invocation must not override its canonical contract",
        "shared-e2e must not declare E2E_EXECUTION_PROFILE",
        "shared-e2e must not declare E2E_JOB",
        "shared-e2e prepare-e2e must set build-cli to false",
        "shared-e2e prepare-e2e invocation must not override its canonical contract",
        "inference-routing must not load prepare-e2e from the target checkout",
        "inference-routing must use prepare-e2e exactly once",
        "brave-search must check out the repository before prepare-e2e",
        "brave-search must authenticate to Docker Hub before prepare-e2e",
      ]),
    );
  });
});
