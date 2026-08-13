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
    uploadStep(workflow.jobs["brave-search"]).uses = DIRECT_UPLOAD_ACTION;
    uploadStep(workflow.jobs["shared-e2e"]).uses =
      "NVIDIA/NemoClaw/.github/actions/upload-e2e-artifacts@main";

    expect(validateUploadE2eArtifactsInvocations(workflow)).toEqual(
      expect.arrayContaining([
        "inference-routing must not load upload-e2e-artifacts from the target checkout",
        "inference-routing must use upload-e2e-artifacts exactly once",
        "brave-search must not invoke actions/upload-artifact directly",
        "brave-search must use upload-e2e-artifacts exactly once",
        "shared-e2e must use the reviewed immutable upload-e2e-artifacts reference",
        "shared-e2e must use upload-e2e-artifacts exactly once",
      ]),
    );
  });

  it("rejects reusing the protected build-cache upload exception for another step", () => {
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

  it.each([
    ["name", "another-cache-artifact"],
    ["path", "another-cache-path/"],
  ])("rejects protected build-cache upload %s drift", (input, value) => {
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

  it("rejects duplicate exact protected build-cache upload steps", () => {
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
    const duplicateJob = workflow.jobs["inference-routing"];
    duplicateJob.steps!.push({ ...uploadStep(duplicateJob) });

    expect(validateUploadE2eArtifactsInvocations(workflow)).toEqual(
      expect.arrayContaining([
        "shared-e2e must use upload-e2e-artifacts exactly once",
        "inference-routing must use upload-e2e-artifacts exactly once",
      ]),
    );
  });

  it("rejects scorecard push runtime summary drift", () => {
    const workflow = mutableWorkflow();
    uploadStep(workflow.jobs.scorecard).with!.path = "runtime-summary.json";

    expect(validateUploadE2eArtifactsInvocations(workflow)).toContain(
      "scorecard must use upload-e2e-artifacts exactly once with its push runtime summary contract",
    );
  });

  it("rejects default, explicit-exception, caller-key, and caller-if drift", () => {
    const workflow = mutableWorkflow();
    const defaultJob = workflow.jobs["brave-search"];
    uploadStep(defaultJob).with = { name: "e2e-brave-search" };
    defaultJob.env!.E2E_TARGET_ID = "not a selector id";

    uploadStep(workflow.jobs["common-egress-agent"]).with!.name = "e2e-common-egress-agent";
    uploadStep(workflow.jobs["mcp-bridge"]).if = "always()";
    uploadStep(workflow.jobs["openshell-gateway-auth-contract"]).if = "always()";
    uploadStep(workflow.jobs["shared-e2e"]).env = { UNEXPECTED: "1" };
    workflow.jobs["shared-e2e"].env!.E2E_EXECUTION_PROFILE = "credential-free";
    workflow.jobs["shared-e2e"].env!.E2E_JOB = "1";
    workflow.jobs["shared-e2e"].env!.E2E_TARGET_ID = "shared-e2e";
    const orderedJob = workflow.jobs["brave-search"];
    const orderedUpload = uploadStep(orderedJob);
    orderedJob.steps!.splice(orderedJob.steps!.indexOf(orderedUpload), 1);
    orderedJob.steps!.unshift(orderedUpload);

    expect(validateUploadE2eArtifactsInvocations(workflow)).toEqual(
      expect.arrayContaining([
        "brave-search upload-e2e-artifacts invocation must not override its contract",
        "brave-search upload-e2e-artifacts must use the action defaults",
        "brave-search default upload caller must declare a valid E2E_TARGET_ID",
        "common-egress-agent upload-e2e-artifacts must preserve its explicit name/path contract",
        "mcp-bridge upload-e2e-artifacts invocation must remain gated by its reviewed pre-upload checks",
        "openshell-gateway-auth-contract upload-e2e-artifacts invocation must remain gated by its reviewed pre-upload checks",
        "shared-e2e must not declare E2E_EXECUTION_PROFILE",
        "shared-e2e must not declare E2E_JOB",
        "shared-e2e upload-e2e-artifacts invocation must not override its contract",
        "shared-e2e default upload caller E2E_TARGET_ID must be '${{ matrix.id }}'",
        "brave-search upload-e2e-artifacts invocation must follow artifact producers and precede only Docker auth cleanup",
      ]),
    );
  });

  it("requires the skill-agent semantic progress artifact", () => {
    const workflow = mutableWorkflow();
    const upload = uploadStep(workflow.jobs["skill-agent"]);
    upload.with!.path = String(upload.with!.path).replace(
      "e2e-artifacts/live/skill-agent/*/test-progress.json\n",
      "",
    );

    expect(validateUploadE2eArtifactsInvocations(workflow)).toContain(
      "skill-agent upload-e2e-artifacts must preserve its explicit name/path contract",
    );
  });

  it("derives execution jobs even when a marker and its upload disappear together", () => {
    const workflow = mutableWorkflow();
    const removedJob = workflow.jobs["brave-search"];
    delete removedJob.env!.E2E_JOB;
    removedJob.steps = removedJob.steps!.filter(
      (step) => step.uses !== UPLOAD_E2E_ARTIFACTS_ACTION,
    );

    expect(validateUploadE2eArtifactsInvocations(workflow)).toContain(
      "brave-search must use upload-e2e-artifacts exactly once",
    );
  });
});
