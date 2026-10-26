// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  cliArtifactRestoreNodeRequirements,
  cliArtifactRestoreNodeVersions,
  DEFAULT_CLI_ARTIFACT_RESTORE_ACTION_PATHS,
  validateCliArtifactRestoreAction,
  validateCliArtifactRestoreToolchain,
} from "../../../tools/e2e/cli-artifact-restore-action-boundary.mts";
import { E2E_ACTION_PROVENANCE } from "../../../tools/e2e/workflow-boundary-policy.mts";

type WorkflowStep = Record<string, unknown> & {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};
type Workflow = { jobs: Record<string, { steps?: WorkflowStep[] }> };

const E2E_WORKFLOW = ".github/workflows/e2e.yaml";
const STANDARD_PROFILE_WORKFLOW = ".github/workflows/e2e-standard-profile.yaml";
// The action pin that ran the Node 24.18.1 helper after the Node 24.22.1 upgrade.
const STALE_RESTORE_ACTION =
  "NVIDIA/NemoClaw/.github/actions/restore-e2e-cli-artifact@b1494a0828a80a8d5dc862effc9e85ac987f8b4a";

function readWorkflow(file: string): Workflow {
  return YAML.parse(fs.readFileSync(file, "utf8")) as Workflow;
}

function restoreStep(workflow: Workflow, job: string): WorkflowStep {
  return workflow.jobs[job].steps!.find(
    (step) => step.name === "Restore exact-commit CLI artifact",
  )!;
}

function withRestoreHelper(transform: (source: string) => string, run: (file: string) => void) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-restore-helper-"));
  try {
    const file = path.join(directory, "restore-cli-artifact.sh");
    fs.writeFileSync(
      file,
      transform(fs.readFileSync(DEFAULT_CLI_ARTIFACT_RESTORE_ACTION_PATHS.restoreScript, "utf8")),
    );
    run(file);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
}

const downgradeNode = (source: string) => source.replaceAll("24.22.1", "24.18.1");

describe("pinned CLI artifact restore action", () => {
  it("executes the reviewed local helpers at its immutable pin", () => {
    expect(validateCliArtifactRestoreAction()).toEqual([]);
  });

  it("rejects a pinned helper that differs from the local helper", () => {
    withRestoreHelper(downgradeNode, (restoreScript) => {
      expect(
        validateCliArtifactRestoreAction({
          ...DEFAULT_CLI_ARTIFACT_RESTORE_ACTION_PATHS,
          restoreScript,
        }),
      ).toEqual([
        "restore-e2e-cli-artifact restore helper must match the helper reviewed at its immutable commit pin",
      ]);
    });
  });

  it("requires the same Node version for consumers and producer manifests", () => {
    const requirements = cliArtifactRestoreNodeRequirements(
      fs.readFileSync(DEFAULT_CLI_ARTIFACT_RESTORE_ACTION_PATHS.restoreScript, "utf8"),
    );
    expect(requirements.consumer).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(requirements.manifest).toBe(requirements.consumer);
  });

  it.each([
    [E2E_WORKFLOW, true, 12],
    [STANDARD_PROFILE_WORKFLOW, false, 1],
  ] as const)(
    "%s restores under the Node version accepted by the pinned helper",
    (file, requireProducer, restoreCount) => {
      const workflow = readWorkflow(file);
      const versions = cliArtifactRestoreNodeVersions(workflow);
      expect(versions.consumers).toHaveLength(restoreCount);
      expect(new Set(versions.consumers.map((consumer) => consumer.uses))).toEqual(
        new Set([E2E_ACTION_PROVENANCE.restoreCliArtifact.reference]),
      );
      expect(validateCliArtifactRestoreToolchain(workflow, { requireProducer })).toEqual([]);
    },
  );

  it("rejects a pinned helper that requires a different Node version than the prepared runtime", () => {
    withRestoreHelper(downgradeNode, (restoreScriptPath) => {
      const errors = validateCliArtifactRestoreToolchain(readWorkflow(E2E_WORKFLOW), {
        requireProducer: true,
        restoreScriptPath,
      });
      expect(errors).toContain(
        "live must prepare Node v24.18.1 before the pinned CLI artifact restore helper",
      );
      expect(errors).toContain(
        "generate-matrix must package the CLI artifact under Node v24.18.1 accepted by the pinned restore helper",
      );
    });
  });

  it("rejects a stale restore action pin in any E2E job", () => {
    const workflow = readWorkflow(E2E_WORKFLOW);
    restoreStep(workflow, "hermes-e2e").uses = STALE_RESTORE_ACTION;
    expect(validateCliArtifactRestoreToolchain(workflow, { requireProducer: true })).toEqual([
      "hermes-e2e must restore the CLI artifact with the reviewed action reference",
    ]);
  });

  it("rejects a Node override between workspace preparation and restore", () => {
    const workflow = readWorkflow(E2E_WORKFLOW);
    const steps = workflow.jobs["mcp-bridge"].steps!;
    steps.splice(steps.indexOf(restoreStep(workflow, "mcp-bridge")), 0, {
      name: "Select another Node",
      uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      with: { "node-version": "24.18.1" },
    });
    expect(validateCliArtifactRestoreToolchain(workflow, { requireProducer: true })).toEqual([
      "mcp-bridge must prepare Node v24.22.1 before the pinned CLI artifact restore helper",
    ]);
  });

  it("rejects a consumer without a recognized Node setup", () => {
    const workflow: Workflow = {
      jobs: {
        run: {
          steps: [
            {
              name: "Install reviewed npm",
              uses: E2E_ACTION_PROVENANCE.reviewedNpmSetup.reference,
            },
            {
              name: "Restore exact-commit CLI artifact",
              uses: E2E_ACTION_PROVENANCE.restoreCliArtifact.reference,
            },
          ],
        },
      },
    };
    expect(validateCliArtifactRestoreToolchain(workflow, { requireProducer: false })).toEqual([
      "run must prepare Node v24.22.1 before the pinned CLI artifact restore helper",
    ]);
  });
});
