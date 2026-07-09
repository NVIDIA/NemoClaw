// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  UPLOAD_E2E_ARTIFACTS_ACTION,
  validateUploadE2eArtifactsAction,
  validateUploadE2eArtifactsInvocations,
} from "../../../tools/e2e/upload-e2e-artifacts-workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";

const ACTION_PATH = join(
  process.cwd(),
  ".github",
  "actions",
  "upload-e2e-artifacts",
  "action.yaml",
);
const LOCAL_UPLOAD_ACTION = "./.github/actions/upload-e2e-artifacts";
const DIRECT_UPLOAD_ACTION = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";

type MutableStep = Record<string, unknown> & {
  name?: string;
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type MutableJob = Record<string, unknown> & {
  env?: Record<string, unknown>;
  steps?: MutableStep[];
};

type MutableWorkflow = {
  jobs: Record<string, MutableJob>;
};

type MutableAction = {
  runs: {
    steps: MutableStep[];
  };
};

function mutableWorkflow(): MutableWorkflow {
  return readWorkflow() as unknown as MutableWorkflow;
}

function uploadStep(job: MutableJob): MutableStep {
  const upload = job.steps?.find((step) => step.uses === UPLOAD_E2E_ARTIFACTS_ACTION);
  expect(upload).toBeDefined();
  return upload!;
}

function validateActionSourceMutation(mutate: (source: string) => string): string[] {
  const directory = mkdtempSync(join(tmpdir(), "nemoclaw-upload-e2e-artifacts-"));
  const actionPath = join(directory, "action.yaml");
  try {
    writeFileSync(actionPath, mutate(readFileSync(ACTION_PATH, "utf8")));
    return validateUploadE2eArtifactsAction(actionPath);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function validateActionMutation(mutate: (action: MutableAction) => void): string[] {
  return validateActionSourceMutation((source) => {
    const action = YAML.parse(source) as MutableAction;
    mutate(action);
    return YAML.stringify(action);
  });
}

describe("upload-e2e-artifacts workflow boundary", () => {
  it("binds one canonical uploader to every E2E execution job", () => {
    expect(validateUploadE2eArtifactsAction()).toEqual([]);
    expect(validateUploadE2eArtifactsInvocations(readWorkflow())).toEqual([]);
  });

  it("rejects semantic-neutral action byte drift from the immutable provenance", () => {
    expect(validateActionSourceMutation((source) => `${source}# unreviewed drift\n`)).toEqual([
      "upload-e2e-artifacts content must match the action reviewed at its immutable commit pin",
    ]);
  });

  it("rejects action upload-policy and inner always drift", () => {
    const policyErrors = validateActionMutation((action) => {
      action.runs.steps[0].with!["retention-days"] = 7;
    });
    expect(policyErrors).toContain(
      "upload-e2e-artifacts must preserve artifact defaults, hidden-file policy, missing-file behavior, and retention",
    );

    const alwaysErrors = validateActionMutation((action) => {
      action.runs.steps[0].if = "${{ success() }}";
    });
    expect(alwaysErrors).toContain("upload-e2e-artifacts inner step must run with always()");
  });

  it("rejects checkout-local, direct, and unreviewed remote upload actions", () => {
    const workflow = mutableWorkflow();
    uploadStep(workflow.jobs["inference-routing"]).uses = LOCAL_UPLOAD_ACTION;
    uploadStep(workflow.jobs["network-policy"]).uses = DIRECT_UPLOAD_ACTION;
    uploadStep(workflow.jobs["docs-validation"]).uses =
      "NVIDIA/NemoClaw/.github/actions/upload-e2e-artifacts@main";

    expect(validateUploadE2eArtifactsInvocations(workflow)).toEqual(
      expect.arrayContaining([
        "inference-routing must not load upload-e2e-artifacts from the target checkout",
        "inference-routing must use upload-e2e-artifacts exactly once",
        "network-policy must not invoke actions/upload-artifact directly",
        "network-policy must use upload-e2e-artifacts exactly once",
        "docs-validation must use the reviewed immutable upload-e2e-artifacts reference",
        "docs-validation must use upload-e2e-artifacts exactly once",
      ]),
    );
  });

  it("rejects missing and duplicate shared upload invocations", () => {
    const workflow = mutableWorkflow();
    const missingJob = workflow.jobs["openshell-version-pin"];
    missingJob.steps = missingJob.steps!.filter(
      (step) => step.uses !== UPLOAD_E2E_ARTIFACTS_ACTION,
    );
    const duplicateJob = workflow.jobs["cloud-inference"];
    duplicateJob.steps!.push({ ...uploadStep(duplicateJob) });

    expect(validateUploadE2eArtifactsInvocations(workflow)).toEqual(
      expect.arrayContaining([
        "openshell-version-pin must use upload-e2e-artifacts exactly once",
        "cloud-inference must use upload-e2e-artifacts exactly once",
      ]),
    );
  });

  it("rejects default, explicit-exception, caller-key, and caller-if drift", () => {
    const workflow = mutableWorkflow();
    const defaultJob = workflow.jobs["credential-migration"];
    uploadStep(defaultJob).with = { name: "e2e-credential-migration" };
    defaultJob.env!.E2E_TARGET_ID = "not a selector id";

    uploadStep(workflow.jobs["hermes-slack"]).with!.path = "e2e-artifacts/live/hermes-slack/";
    uploadStep(workflow.jobs["gpu-e2e"]).if = "success()";
    uploadStep(workflow.jobs["mcp-bridge"]).if = "always()";
    uploadStep(workflow.jobs["docs-validation"]).env = { UNEXPECTED: "1" };
    const orderedJob = workflow.jobs["network-policy"];
    const orderedUpload = uploadStep(orderedJob);
    orderedJob.steps!.splice(orderedJob.steps!.indexOf(orderedUpload), 1);
    orderedJob.steps!.unshift(orderedUpload);

    expect(validateUploadE2eArtifactsInvocations(workflow)).toEqual(
      expect.arrayContaining([
        "credential-migration upload-e2e-artifacts invocation must not override its contract",
        "credential-migration upload-e2e-artifacts must use the action defaults",
        "credential-migration default upload caller must declare a valid E2E_TARGET_ID",
        "hermes-slack upload-e2e-artifacts must preserve its explicit name/path contract",
        "gpu-e2e upload-e2e-artifacts invocation must run with always()",
        "mcp-bridge upload-e2e-artifacts invocation must remain gated by its reviewed pre-upload checks",
        "docs-validation upload-e2e-artifacts invocation must not override its contract",
        "network-policy upload-e2e-artifacts invocation must follow artifact producers and precede only Docker auth cleanup",
      ]),
    );
  });

  it("rejects execution-inventory drift even when its upload disappears with it", () => {
    const workflow = mutableWorkflow();
    const removedJob = workflow.jobs["credential-sanitization"];
    delete removedJob.env!.E2E_JOB;
    removedJob.steps = removedJob.steps!.filter(
      (step) => step.uses !== UPLOAD_E2E_ARTIFACTS_ACTION,
    );

    expect(validateUploadE2eArtifactsInvocations(workflow)).toEqual(
      expect.arrayContaining([
        "upload-e2e-artifacts must cover exactly 75 live and E2E_JOB execution jobs",
        "upload-e2e-artifacts must keep exactly 63 default callers",
      ]),
    );
  });
});
