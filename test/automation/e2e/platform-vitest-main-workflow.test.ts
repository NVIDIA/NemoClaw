// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  readRepoText,
  readYaml,
  type Workflow,
  type WorkflowJob,
  type WorkflowStep,
} from "../../helpers/e2e-workflow-contract";

const WORKFLOW_PATH = ".github/workflows/platform-vitest-main.yaml";
const WSL_HELPER_PATH = "tools/wsl/ci-helper.ps1";
const MACOS_REQUIREMENTS_PATH = "ci/platform-vitest-macos-requirements.lock";
const MAIN_ONLY_PACKAGE_TOKEN = "${{ github.ref == 'refs/heads/main' && github.token || '' }}";
const workflow = readYaml<Workflow>(WORKFLOW_PATH);
const wslHelperSource = readRepoText(WSL_HELPER_PATH);

function job(name: string): WorkflowJob {
  const candidate = workflow.jobs[name];
  expect(candidate, `missing ${name} job`).toBeDefined();
  return candidate;
}

function step(jobName: string, name: string): WorkflowStep {
  const candidate = job(jobName).steps?.find((entry) => entry.name === name);
  expect(candidate, `missing ${jobName} step ${name}`).toBeDefined();
  return candidate!;
}

describe("platform evidence workflow", () => {
  it("marks the container checkout safe before generating build identity", () => {
    const run = step("ubuntu-2604-contract", "Build CLI").run ?? "";
    expect(run).toContain('git config --global --add safe.directory "$GITHUB_WORKSPACE"');
    expect(run).toContain('test "$(git rev-parse --verify HEAD)" = "$GITHUB_SHA"');
    expect(run.indexOf("safe.directory")).toBeLessThan(run.indexOf("npm run build:cli"));
  });
  it("installs authenticated dependencies before isolating the macOS suite from OpenShell", () => {
    const installDependencies = step("macos-vitest", "Install dependencies");
    const installOpenShell = step("macos-vitest", "Install pinned OpenShell");
    const stepNames = job("macos-vitest").steps?.map(({ name }) => name) ?? [];

    expect(installDependencies.env).toMatchObject({ NODE_AUTH_TOKEN: MAIN_ONLY_PACKAGE_TOKEN });
    expect(installDependencies.run).toBe("bash .github/actions/ci-install-dependencies.sh");
    expect(stepNames.indexOf("Run full Vitest suite on macOS")).toBeLessThan(
      stepNames.indexOf("Install pinned OpenShell"),
    );
    expect(installOpenShell.if).toContain("matrix.shard == 1");
    expect(installOpenShell.if).toContain("github.ref == 'refs/heads/main'");
  });

  it("normalizes WSL checkout modes and installs the reviewed SDK with the job token", () => {
    const install = step("wsl-vitest", "Install dependencies and build in WSL");

    expect(wslHelperSource).toContain('"chmod -R go-w $workdirLiteral"');
    expect(install.env).toMatchObject({ NODE_AUTH_TOKEN: MAIN_ONLY_PACKAGE_TOKEN });
    expect(install.run).toContain("'NODE_AUTH_TOKEN', 'GITHUB_EVENT_NAME', 'GITHUB_REF'");
    expect(install.run).toContain("bash .github/actions/ci-install-dependencies.sh");
  });

  it.each([
    {
      job: "macos-vitest",
      step: "Run macOS live E2E",
      dockerOutput: "steps.macos_docker.outputs.docker_ok == 'true'",
    },
    {
      job: "wsl-vitest",
      step: "Run WSL live E2E",
      dockerOutput: "steps.wsl_docker.outputs.docker_ok == 'true'",
    },
  ])("limits credentialed $job E2E to the first main-branch shard", (workflowCase) => {
    const live = step(workflowCase.job, workflowCase.step);
    expect(live.if).toContain("matrix.shard == 1");
    expect(live.if).toContain(workflowCase.dockerOutput);
    expect(live.if).toContain("github.ref == 'refs/heads/main'");
    expect(live.env).toMatchObject({
      GITHUB_TOKEN: "${{ github.token }}",
      NVIDIA_INFERENCE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
    });
  });
});
