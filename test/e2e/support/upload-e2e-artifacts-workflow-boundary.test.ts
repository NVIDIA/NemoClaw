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

describe("E2E artifact uploads", () => {
  it("uses the shared uploader in every E2E execution job", () => {
    expect(validateUploadE2eArtifactsAction()).toEqual([]);
    expect(validateUploadE2eArtifactsInvocations(readWorkflow())).toEqual([]);
  });

  it("rejects any change to the upload action pinned by the workflow", () => {
    expect(validateActionSourceMutation((source) => `${source}# unreviewed drift\n`)).toEqual([
      "upload-e2e-artifacts content must match the action reviewed at its immutable commit pin",
    ]);
  });

  it("retains E2E artifacts for 14 days", () => {
    const policyErrors = validateActionMutation((action) => {
      action.runs.steps[0].with!["retention-days"] = 7;
    });
    expect(policyErrors).toContain(
      "upload-e2e-artifacts must preserve artifact defaults, hidden-file policy, missing-file behavior, and retention",
    );
  });

  it("uploads artifacts even when an earlier step fails", () => {
    const errors = validateActionMutation((action) => {
      action.runs.steps[0].if = "${{ success() }}";
    });
    expect(errors).toContain("upload-e2e-artifacts inner step must run with always()");
  });

  it("uses the pinned shared action for ordinary E2E result uploads", () => {
    const workflow = mutableWorkflow();
    uploadStep(workflow.jobs["messaging-providers"]).uses = LOCAL_UPLOAD_ACTION;
    uploadStep(workflow.jobs["openclaw-plugin-runtime-exdev"]).uses = DIRECT_UPLOAD_ACTION;
    uploadStep(workflow.jobs["shared-e2e"]).uses =
      "NVIDIA/NemoClaw/.github/actions/upload-e2e-artifacts@main";

    expect(validateUploadE2eArtifactsInvocations(workflow)).toEqual(
      expect.arrayContaining([
        "messaging-providers must not load upload-e2e-artifacts from the target checkout",
        "messaging-providers must use upload-e2e-artifacts exactly once",
        "openclaw-plugin-runtime-exdev must not invoke actions/upload-artifact directly",
        "openclaw-plugin-runtime-exdev must use upload-e2e-artifacts exactly once",
        "shared-e2e must use the reviewed immutable upload-e2e-artifacts reference",
        "shared-e2e must use upload-e2e-artifacts exactly once",
      ]),
    );
  });

  it("allows the named protected build-cache step to upload directly", () => {
    const workflow = mutableWorkflow();
    const job = workflow.jobs["managed-image-multiarch-startup"];
    const cacheUpload = job.steps?.find(
      (step) => step.name === "Publish exact amd64 protected runtime build cache",
    );
    expect(cacheUpload).toBeDefined();
    cacheUpload!.name = "Publish another direct artifact";

    expect(validateUploadE2eArtifactsInvocations(workflow)).toContain(
      "managed-image-multiarch-startup must not invoke actions/upload-artifact directly",
    );
  });

  it("allows only the exact 30-day native runtime aggregate upload", () => {
    const workflow = mutableWorkflow();
    const upload = workflow.jobs["native-runtime-qualification-producer-aggregate"].steps?.find(
      (step) => step.name === "Upload aggregate evidence",
    );
    expect(upload).toBeDefined();
    upload!.with!["retention-days"] = 14;

    expect(validateUploadE2eArtifactsInvocations(workflow)).toContain(
      "native-runtime-qualification-producer-aggregate must not invoke actions/upload-artifact directly",
    );
  });

  it.each([
    ["name", "another-cache-artifact"],
    ["path", "another-cache-path/"],
  ])("uses the required protected build-cache upload %s", (input, value) => {
    const workflow = mutableWorkflow();
    const job = workflow.jobs["managed-image-multiarch-startup"];
    const cacheUpload = job.steps?.find(
      (step) => step.name === "Publish exact amd64 protected runtime build cache",
    );
    expect(cacheUpload).toBeDefined();
    cacheUpload!.with![input] = value;

    expect(validateUploadE2eArtifactsInvocations(workflow)).toEqual(
      expect.arrayContaining([
        "managed-image-multiarch-startup must define exactly one exact protected build-cache direct upload",
        "managed-image-multiarch-startup must not invoke actions/upload-artifact directly",
      ]),
    );
  });

  it("allows only one protected build-cache upload step", () => {
    const workflow = mutableWorkflow();
    const job = workflow.jobs["managed-image-multiarch-startup"];
    const cacheUpload = job.steps?.find(
      (step) => step.name === "Publish exact amd64 protected runtime build cache",
    );
    expect(cacheUpload).toBeDefined();
    job.steps!.push({ ...cacheUpload!, with: { ...cacheUpload!.with } });

    expect(validateUploadE2eArtifactsInvocations(workflow)).toContain(
      "managed-image-multiarch-startup must define exactly one exact protected build-cache direct upload",
    );
  });

  it("rejects missing and duplicate shared upload invocations", () => {
    const workflow = mutableWorkflow();
    const missingJob = workflow.jobs["shared-e2e"];
    missingJob.steps = missingJob.steps!.filter(
      (step) => step.uses !== UPLOAD_E2E_ARTIFACTS_ACTION,
    );
    const duplicateJob = workflow.jobs["messaging-providers"];
    duplicateJob.steps!.push({ ...uploadStep(duplicateJob) });

    expect(validateUploadE2eArtifactsInvocations(workflow)).toEqual(
      expect.arrayContaining([
        "shared-e2e must use upload-e2e-artifacts exactly once",
        "messaging-providers must use upload-e2e-artifacts exactly once",
      ]),
    );
  });

  it("uploads the scorecard summary from its configured path", () => {
    const workflow = mutableWorkflow();
    uploadStep(workflow.jobs.scorecard).with!.path = "runtime-summary.json";

    expect(validateUploadE2eArtifactsInvocations(workflow)).toContain(
      "scorecard must use upload-e2e-artifacts exactly once with its push runtime summary contract",
    );
  });

  it("requires each caller to use its configured inputs and condition", () => {
    const workflow = mutableWorkflow();
    const defaultJob = workflow.jobs["messaging-providers"];
    uploadStep(defaultJob).with = { name: "e2e-messaging-providers" };
    defaultJob.env!.E2E_TARGET_ID = "not a selector id";

    uploadStep(workflow.jobs["hermes-gpu-startup"]).with!.name = "e2e-hermes-gpu-startup";
    uploadStep(workflow.jobs["mcp-bridge"]).if = "always()";
    uploadStep(workflow.jobs["openshell-gateway-auth-contract"]).if = "always()";
    uploadStep(workflow.jobs["shared-e2e"]).env = { UNEXPECTED: "1" };
    workflow.jobs["shared-e2e"].env!.E2E_EXECUTION_PROFILE = "credential-free";
    workflow.jobs["shared-e2e"].env!.E2E_JOB = "1";
    workflow.jobs["shared-e2e"].env!.E2E_TARGET_ID = "shared-e2e";
    const orderedJob = workflow.jobs["messaging-providers"];
    const orderedUpload = uploadStep(orderedJob);
    orderedJob.steps!.splice(orderedJob.steps!.indexOf(orderedUpload), 1);
    orderedJob.steps!.unshift(orderedUpload);

    expect(validateUploadE2eArtifactsInvocations(workflow)).toEqual(
      expect.arrayContaining([
        "messaging-providers upload-e2e-artifacts must preserve its explicit name/path contract",
        "hermes-gpu-startup upload-e2e-artifacts must preserve its explicit name/path contract",
        "mcp-bridge upload-e2e-artifacts invocation must remain gated by its reviewed pre-upload checks",
        "openshell-gateway-auth-contract upload-e2e-artifacts invocation must remain gated by its reviewed pre-upload checks",
        "shared-e2e must not declare E2E_EXECUTION_PROFILE",
        "shared-e2e must not declare E2E_JOB",
        "shared-e2e upload-e2e-artifacts invocation must not override its contract",
        "messaging-providers upload-e2e-artifacts invocation must follow artifact producers and precede only Docker auth cleanup",
      ]),
    );
  });

  it("derives execution jobs even when a marker and its upload disappear together", () => {
    const workflow = mutableWorkflow();
    const removedJob = workflow.jobs["openclaw-plugin-runtime-exdev"];
    delete removedJob.env!.E2E_JOB;
    removedJob.steps = removedJob.steps!.filter(
      (step) => step.uses !== UPLOAD_E2E_ARTIFACTS_ACTION,
    );

    expect(validateUploadE2eArtifactsInvocations(workflow)).toContain(
      "openclaw-plugin-runtime-exdev must use upload-e2e-artifacts exactly once",
    );
  });
});
