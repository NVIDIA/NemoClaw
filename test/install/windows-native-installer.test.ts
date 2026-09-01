// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  readYaml,
  type Workflow,
  type WorkflowJob,
  type WorkflowStep,
} from "../helpers/e2e-workflow-contract";

const WORKFLOW_PATH = ".github/workflows/platform-vitest-main.yaml";
const OPENSHELL_REVISION = "bcd517bbe08cc80860c9be57699390cd32e8445f";

function workflow(): Workflow {
  return readYaml(WORKFLOW_PATH) as Workflow;
}

function job(name: string): WorkflowJob {
  const value = workflow().jobs[name];
  expect(value, `missing workflow job '${name}'`).toBeDefined();
  return value!;
}

function step(owner: WorkflowJob, name: string): WorkflowStep {
  const value = owner.steps?.find((entry) => entry.name === name);
  expect(value, `missing workflow step '${name}'`).toBeDefined();
  return value!;
}

describe("native Windows candidate installer", () => {
  it("adds an explicit opt-in hosted ARM64 platform lane", () => {
    const platformWorkflow = workflow() as Workflow & {
      on?: {
        workflow_dispatch?: {
          inputs?: Record<string, { default?: boolean; type?: string }>;
        };
      };
    };
    const input = platformWorkflow.on?.workflow_dispatch?.inputs?.run_windows_native_installer;
    const installerJob = job("windows-native-installer");

    expect(input).toEqual(
      expect.objectContaining({
        default: false,
        type: "boolean",
      }),
    );
    expect(installerJob.if).toBe(
      "${{ github.event_name == 'workflow_dispatch' && inputs.run_windows_native_installer }}",
    );
    expect(installerJob["runs-on"]).toBe("windows-11-vs2026-arm");
    expect(installerJob.permissions).toBeUndefined();
    expect(step(installerJob, "Check out the pinned OpenShell Windows candidate").with?.ref).toBe(
      OPENSHELL_REVISION,
    );
    expect(step(installerJob, "Build the pinned OpenShell PR distribution").run).toContain(
      "windows-msvc.ps1 build aarch64-pc-windows-msvc",
    );
    expect(
      step(installerJob, "Qualify install, repair, uninstall, and no-WSL process boundaries").run,
    ).toContain("run-windows-native-installer-qualification.ps1");
    expect(
      step(installerJob, "Qualify install, repair, uninstall, and no-WSL process boundaries").run,
    ).toContain("-OpenShellSha bcd517bbe08cc80860c9be57699390cd32e8445f");
    expect(step(installerJob, "Upload Windows native installer qualification receipts").if).toBe(
      "success()",
    );
    expect(JSON.stringify(installerJob)).not.toContain("NVIDIA_INFERENCE_API_KEY");
  });
});
