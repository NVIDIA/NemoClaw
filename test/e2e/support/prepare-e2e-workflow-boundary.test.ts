// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  PREPARE_E2E_ACTION,
  PREPARE_COMPILED_ARTIFACT_ACTION,
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

  it("loads the dependency installer from the sparse trusted checkout", () => {
    const workflow = readWorkflow() as Workflow;
    const checkout = workflow.jobs["generate-matrix"].steps!.find(
      (step) => step.name === "Check out trusted compiled artifact action",
    )!;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "trusted-build-action-"));
    try {
      const included = String(checkout.with!["sparse-checkout"]).trim().split("\n");
      fs.cpSync(process.cwd(), root, {
        recursive: true,
        filter: (source) => {
          const relative = path.relative(process.cwd(), source);
          return (
            relative === "" ||
            included.some(
              (entry) =>
                entry === relative ||
                entry.startsWith(`${relative}/`) ||
                relative.startsWith(`${entry}/`),
            )
          );
        },
      });
      const result = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          path.join(root, "scripts/checks/prepare-ci-npm-install.mts"),
        ],
        {
          encoding: "utf8",
          cwd: root,
          env: {
            ...process.env,
            NEMOCLAW_CI_NPM_PACKAGE_MODE: "inspect",
            NEMOCLAW_CI_TARGET_ROOT: process.cwd(),
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(typeof JSON.parse(result.stdout).required).toBe("boolean");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a compiler action loaded from the candidate revision", () => {
    const workflow = readWorkflow() as Workflow;
    const checkout = workflow.jobs["generate-matrix"].steps!.find(
      (step) => step.name === "Check out trusted compiled artifact action",
    )!;
    checkout.with!.ref = "${{ inputs.checkout_sha || github.sha }}";
    expect(validatePrepareE2eInvocations(workflow)).toContain(
      "generate-matrix must load the shared compiler from the trusted workflow checkout after candidate checkout",
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
      (step) => step.uses === PREPARE_COMPILED_ARTIFACT_ACTION,
    )!;
    producerPrepare.with = { "build-cli": "false" };

    const consumerJob = workflow.jobs["messaging-providers"];
    const consumerPrepare = consumerJob.steps!.find((step) => step.uses === PREPARE_E2E_ACTION)!;
    delete consumerPrepare.with;
    consumerJob.steps!.splice(consumerJob.steps!.indexOf(consumerPrepare), 0, {
      name: "Build CLI",
      run: "npm run build:cli",
    });

    const sharedJob = workflow.jobs["shared-e2e"];
    const sharedPrepare = sharedJob.steps!.find((step) => step.uses === PREPARE_E2E_ACTION)!;
    delete sharedPrepare.with;
    sharedJob.env!.E2E_EXECUTION_PROFILE = "credential-free";
    sharedJob.env!.E2E_JOB = "1";

    const untrustedJob = workflow.jobs["cloud-onboard"];
    const untrustedPrepare = untrustedJob.steps!.find((step) => step.uses === PREPARE_E2E_ACTION)!;
    untrustedPrepare.uses = "./.github/actions/prepare-e2e";

    const orderedJob = workflow.jobs["openclaw-plugin-runtime-exdev"];
    const orderedPrepareIndex = orderedJob.steps!.findIndex(
      (step) => step.name === PREPARE_E2E_STEP,
    );
    const [orderedPrepare] = orderedJob.steps!.splice(orderedPrepareIndex, 1);
    orderedJob.steps!.unshift(orderedPrepare);

    expect(validatePrepareE2eInvocations(workflow)).toEqual(
      expect.arrayContaining([
        "generate-matrix prepare-e2e must own the only default CLI build",
        "generate-matrix prepare-e2e invocation must not override its canonical contract",
        "messaging-providers prepare-e2e must set build-cli to false",
        "messaging-providers prepare-e2e invocation must not override its canonical contract",
        "messaging-providers must not duplicate prepare-e2e step 'Build CLI'",
        "shared-e2e must not declare E2E_EXECUTION_PROFILE",
        "shared-e2e must not declare E2E_JOB",
        "shared-e2e prepare-e2e must set build-cli to false",
        "shared-e2e prepare-e2e invocation must not override its canonical contract",
        "cloud-onboard must not load prepare-e2e from the target checkout",
        "cloud-onboard must use prepare-e2e exactly once",
        "openclaw-plugin-runtime-exdev must check out the repository before prepare-e2e",
        "openclaw-plugin-runtime-exdev must authenticate to Docker Hub before prepare-e2e",
      ]),
    );
  });
});
