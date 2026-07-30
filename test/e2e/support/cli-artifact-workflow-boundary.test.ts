// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLI_ARTIFACT_PACKAGE_STEP,
  CLI_ARTIFACT_PUBLISH_STEP,
  CLI_ARTIFACT_RESTORE_STEP,
  validateCliArtifactRestoreAction,
  validateCliArtifactWorkflowBoundary,
} from "../../../tools/e2e/cli-artifact-workflow-boundary.mts";
import {
  type CompositeAction,
  readRepoText,
  readWorkflow,
  readYaml,
  type Workflow,
} from "../../helpers/e2e-workflow-contract";

const CANDIDATE_SHA = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const PAYLOAD_SHA256 = "b".repeat(64);

function runIdentityValidation(overrides: Record<string, unknown> = {}) {
  const action = readYaml<CompositeAction>(".github/actions/restore-e2e-cli-artifact/action.yaml");
  const workflowSha = "d".repeat(40);
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cli-artifact-identity-"));
  return spawnSync("bash", ["-c", action.runs.steps[0]!.run!], {
    encoding: "utf8",
    env: {
      ...process.env,
      CALLER_WORKFLOW_SHA: workflowSha,
      GITHUB_OUTPUT: path.join(outputDirectory, "github-output"),
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: "98765",
      PROVENANCE_JSON: JSON.stringify({
        kind: "nemoclaw-e2e-cli-provenance-v1",
        artifactDigest: "c".repeat(64),
        artifactId: "12345",
        artifactName: `nemoclaw-cli-${CANDIDATE_SHA}-${PAYLOAD_SHA256}`,
        candidateRepository: "NVIDIA/NemoClaw",
        candidateSha: CANDIDATE_SHA,
        payloadSha256: PAYLOAD_SHA256,
        runAttempt: "1",
        runId: "98765",
        workflowSha,
        ...overrides,
      }),
    },
  });
}

function workflowFixture(): Workflow {
  return JSON.parse(JSON.stringify(readWorkflow())) as Workflow;
}

function requireStep(workflow: Workflow, jobName: string, stepName: string) {
  const step = workflow.jobs[jobName]?.steps?.find((candidate) => candidate.name === stepName);
  expect(step, `${jobName} must contain ${stepName}`).toBeDefined();
  return step!;
}

describe("exact-commit CLI artifact workflow boundary", () => {
  it("builds once and gives every build-backed E2E job the verified artifact", () => {
    expect(validateCliArtifactWorkflowBoundary(readWorkflow())).toEqual([]);
  });

  it("accepts an exact producer and consumer identity", () => {
    const result = runIdentityValidation();
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ["empty artifact ID", { artifactId: "" }],
    ["prefixed upload digest", { artifactDigest: `sha256:${"c".repeat(64)}` }],
    ["malformed candidate SHA", { candidateSha: "abc" }],
    ["different candidate SHA", { candidateSha: "e".repeat(40) }],
    ["unbound artifact name", { artifactName: `nemoclaw-cli-${CANDIDATE_SHA}` }],
    ["malformed payload digest", { payloadSha256: "abc" }],
    ["malformed workflow SHA", { workflowSha: "abc" }],
    ["unknown provenance field", { unexpected: "value" }],
  ])("fails closed for %s", (_case, overrides) => {
    expect(runIdentityValidation(overrides).status).not.toBe(0);
  });

  it("rejects producer identity and content-addressing drift", () => {
    const workflow = workflowFixture();
    const producer = workflow.jobs["generate-matrix"];
    producer.outputs!.cli_artifact_provenance =
      "${{ steps.upload_cli_artifact.outputs.artifact-url }}";
    const packageStep = requireStep(workflow, "generate-matrix", CLI_ARTIFACT_PACKAGE_STEP);
    packageStep.env!.WORKFLOW_SHA = "${{ inputs.checkout_sha }}";
    packageStep.run = packageStep.run!.replace(
      'artifact_name="nemoclaw-cli-${CANDIDATE_SHA}-${payload_sha256}"',
      'artifact_name="nemoclaw-cli-${CANDIDATE_SHA}"',
    );
    const uploadStep = requireStep(workflow, "generate-matrix", CLI_ARTIFACT_PUBLISH_STEP);
    uploadStep.uses = "actions/upload-artifact@v7";

    expect(validateCliArtifactWorkflowBoundary(workflow)).toEqual(
      expect.arrayContaining([
        "generate-matrix must expose exact cli_artifact_provenance provenance",
        "CLI artifact package step must bind candidate and trusted workflow identities explicitly",
        'CLI artifact package step must contain artifact_name="nemoclaw-cli-${CANDIDATE_SHA}-${payload_sha256}"',
        "CLI artifact upload must use the immutable content-addressed upload contract",
      ]),
    );
  });

  it("rejects incomplete consumer provenance and a mutable action reference", () => {
    const workflow = workflowFixture();
    const restore = requireStep(workflow, "sandbox-operations", CLI_ARTIFACT_RESTORE_STEP);
    restore.uses = "NVIDIA/NemoClaw/.github/actions/restore-e2e-cli-artifact@main";
    restore.with = { "provenance-json": "${{ inputs.checkout_sha }}" };

    expect(validateCliArtifactWorkflowBoundary(workflow)).toContain(
      "sandbox-operations must use the immutable complete CLI artifact restore contract",
    );
  });

  it("rejects action implementation drift that weakens extraction or payload verification", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cli-artifact-action-"));
    const actionPath = path.join(directory, "action.yaml");
    const source = readRepoText(".github/actions/restore-e2e-cli-artifact/action.yaml")
      .replace("tar --no-same-owner --no-same-permissions", "tar")
      .replace('[[ "$actual_payload_sha256" == "$PAYLOAD_SHA256" ]]', '[[ -s "$payload" ]]');
    fs.writeFileSync(actionPath, source);

    expect(validateCliArtifactRestoreAction(actionPath)).toEqual(
      expect.arrayContaining([
        "CLI artifact restore action must match its immutable workflow pin",
        "CLI artifact payload verification must contain tar --no-same-owner --no-same-permissions",
        'CLI artifact payload verification must contain [[ "$actual_payload_sha256" == "$PAYLOAD_SHA256" ]]',
      ]),
    );
  });

  it("rejects missing consumer restoration", () => {
    const workflow = workflowFixture();
    workflow.jobs["cloud-inference"].steps = workflow.jobs["cloud-inference"].steps!.filter(
      (step) => step.name !== CLI_ARTIFACT_RESTORE_STEP,
    );

    expect(validateCliArtifactWorkflowBoundary(workflow)).toContain(
      "cloud-inference must verify and restore the exact CLI artifact exactly once",
    );
  });

  it("keeps installer-backed no-build jobs outside the artifact handoff", () => {
    const workflow = workflowFixture();
    const inheritedRestore = requireStep(workflow, "sandbox-operations", CLI_ARTIFACT_RESTORE_STEP);
    workflow.jobs["security-posture"].steps!.push(inheritedRestore);

    expect(validateCliArtifactWorkflowBoundary(workflow)).toContain(
      "security-posture must not consume the shared CLI artifact",
    );
  });
});
