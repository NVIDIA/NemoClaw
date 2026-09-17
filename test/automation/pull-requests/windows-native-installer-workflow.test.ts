// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  readYaml,
  topLevelAndTerms,
  type Workflow,
  type WorkflowJob,
} from "../../helpers/e2e-workflow-contract";

type WindowsInstallerWorkflow = Workflow & {
  concurrency: { "cancel-in-progress": string; group: string };
  on: {
    pull_request: { paths: string[]; types: string[] };
    workflow_dispatch: { inputs: Record<string, unknown> };
  };
  permissions: Record<string, string>;
};

function requiredJob(workflow: WindowsInstallerWorkflow, name: string): WorkflowJob {
  const job = workflow.jobs[name];
  expect(job, `missing Windows installer job '${name}'`).toBeDefined();
  return job!;
}

const workflow = readYaml<WindowsInstallerWorkflow>(
  ".github/workflows/windows-native-installer.yaml",
);
const privilegedJobCases = Object.entries(workflow.jobs)
  .filter(([name]) => name !== "windows-runtime-controls")
  .map(([name, job]) => ({ job, name }));
const dispatchGate = "github.event_name == 'workflow_dispatch'";

describe("native Windows installer pull request controls", () => {
  // source-shape-contract: security -- Untrusted pull request code must reach only the credential-free Windows control job while privileged delivery jobs remain manual
  it("routes Windows pull requests through credential-free controls only (#8178)", () => {
    const controls = requiredJob(workflow, "windows-runtime-controls");
    const checkout = controls.steps?.find(
      (step) => step.name === "Check out the native ownership controls",
    );
    const controllerTests = controls.steps?.find(
      (step) => step.name === "Exercise installed acceptance controller compatibility",
    );
    const cancellationControls = controls.steps?.find(
      (step) => step.name === "Verify setup cancellation checkpoints before configuration mutation",
    );
    const evidence = controls.steps?.find(
      (step) => step.name === "Upload runtime ownership control evidence",
    );
    const pullRequestJobs = Object.entries(workflow.jobs)
      .filter(([, job]) => job.if?.includes("github.event_name == 'pull_request'"))
      .map(([name]) => name);

    expect(workflow.on.pull_request).toEqual({
      types: ["opened", "synchronize", "reopened"],
      paths: [
        ".github/actions/setup-reviewed-npm/**",
        ".github/workflows/windows-native-installer.yaml",
        "bin/nemoclaw.js",
        "ci/reviewed-npm-audit.json",
        "packaging/windows/**",
        "scripts/checks/*windows-native*",
        "scripts/install-windows-native.ps1",
        "test/security/windows-native-*.test.ts",
        "test/support/windows-native-*.ts",
      ],
    });
    expect(workflow.permissions).toEqual({ actions: "read", contents: "read" });
    expect(workflow.concurrency["cancel-in-progress"]).toBe(
      "${{ github.event_name == 'pull_request' }}",
    );
    expect(pullRequestJobs).toEqual(["windows-runtime-controls"]);
    expect(controls.if).toBe(
      "${{ github.event_name == 'pull_request' || (github.event_name == 'workflow_dispatch' && !inputs.run_windows_native_installer && inputs.test_native_windows_runtime) }}",
    );
    expect(controls.permissions).toEqual({ contents: "read" });
    expect(JSON.stringify(controls)).not.toContain("secrets.");
    expect(checkout).toMatchObject({
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      with: { "persist-credentials": false },
    });
    expect(controllerTests?.run).toEqual(
      expect.stringContaining(
        "packaging/windows/installer/control-installed-openclaw-input.test.mts",
      ),
    );
    expect(controllerTests?.run).toEqual(
      expect.stringContaining("packaging/windows/installer/run-installed-acceptance.test.mts"),
    );
    expect(controllerTests?.run).toEqual(
      expect.stringContaining("packaging/windows/installer/qualify-finished-package.test.mts"),
    );
    expect(controllerTests?.run).toEqual(
      expect.stringContaining("packaging/windows/runtime/native-ui-tunnel.test.mts"),
    );
    expect(cancellationControls?.run).toEqual(
      expect.stringContaining(
        "packaging/windows/tests/setup-cancellation/Setup.Cancellation.Controls.csproj",
      ),
    );
    expect(cancellationControls?.run).toEqual(
      expect.stringContaining("setup-cancellation-controls.log"),
    );
    expect(evidence?.if).toBe("always()");
    expect(topLevelAndTerms("${{ " + dispatchGate + " && true || true }}")).not.toContain(
      dispatchGate,
    );
    expect(topLevelAndTerms("${{ " + dispatchGate + " && (true || false) }}")).toContain(
      dispatchGate,
    );
    expect(topLevelAndTerms(`\${{ true || ${dispatchGate} }}`)).not.toContain(dispatchGate);
    expect(topLevelAndTerms(`\${{ always() && ${dispatchGate} && true }}`)).toContain(dispatchGate);
  });

  it.each(privilegedJobCases)("keeps $name manual", ({ job, name }) => {
    expect(
      topLevelAndTerms(job.if),
      `${name} must have a mandatory manual top-level AND gate`,
    ).toContain(dispatchGate);
    expect(job.if, `${name} must not execute for pull requests`).not.toContain("pull_request");
  });
});
