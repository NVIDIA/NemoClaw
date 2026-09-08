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

  it("keeps real macOS OpenShell state out of the non-live suite", () => {
    const steps = job("macos-vitest").steps ?? [];
    const nonLiveIndex = steps.findIndex(
      (entry) => entry.name === "Run full Vitest suite on macOS",
    );
    const installIndex = steps.findIndex(
      (entry) => entry.name === "Install pinned OpenShell for macOS E2E",
    );
    const liveIndex = steps.findIndex((entry) => entry.name === "Run macOS live E2E");
    expect(nonLiveIndex).toBeGreaterThanOrEqual(0);
    expect(installIndex).toBeGreaterThan(nonLiveIndex);
    expect(liveIndex).toBeGreaterThan(installIndex);
    expect(steps[installIndex]?.if).toContain("matrix.shard == 1");
  });

  it.each(["docker", "gnu-tar", "iproute2mac", "podman"])(
    "installs the %s host tool resolved by macOS platform fixtures",
    (formula) => {
      const install = step("macos-vitest", "Install macOS test dependencies").run ?? "";
      expect(install).toContain(formula);
    },
  );

  it("puts GNU tar first on the macOS fixture path", () => {
    const install = step("macos-vitest", "Install macOS test dependencies").run ?? "";
    expect(install).toContain('"$(brew --prefix gnu-tar)/libexec/gnubin"');
  });

  it("starts Docker and qualifies both WSL container clients before the suite", () => {
    const steps = job("wsl-vitest").steps ?? [];
    const install = step("wsl-vitest", "Install Ubuntu dependencies").run ?? "";
    const runtime = step("wsl-vitest", "Start the WSL container runtime").run ?? "";
    const runtimeIndex = steps.findIndex(
      (entry) => entry.name === "Start the WSL container runtime",
    );
    const suiteIndex = steps.findIndex((entry) => entry.name === "Run full Vitest suite in WSL");
    expect(install).toContain("'docker.io'");
    expect(install).toContain("'podman'");
    expect(runtime).toContain("service docker start");
    expect(runtime).toContain("docker info");
    expect(runtime).toContain("podman --version");
    expect(runtime).toContain("ip -Version");
    expect(runtimeIndex).toBeGreaterThanOrEqual(0);
    expect(suiteIndex).toBeGreaterThan(runtimeIndex);
  });

  it("scopes WSL live-E2E settings to the credentialed live step", () => {
    const wsl = job("wsl-vitest");
    const live = step("wsl-vitest", "Run WSL live E2E");
    const liveOnlyEnvironment = {
      NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_RECREATE_SANDBOX: "1",
      NEMOCLAW_SANDBOX_NAME: "e2e-wsl",
    };
    expect(wsl.env).not.toHaveProperty("NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE");
    expect(wsl.env).not.toHaveProperty("NEMOCLAW_NON_INTERACTIVE");
    expect(wsl.env).not.toHaveProperty("NEMOCLAW_RECREATE_SANDBOX");
    expect(wsl.env).not.toHaveProperty("NEMOCLAW_SANDBOX_NAME");
    expect(live.env).toMatchObject(liveOnlyEnvironment);
  });

  it.each(["macos-vitest", "wsl-vitest"])(
    "stages the approved OpenShell SDK for %s dependencies",
    (jobName) => {
      const install = step(
        jobName,
        jobName === "macos-vitest"
          ? "Install dependencies"
          : "Install dependencies and build in WSL",
      );
      expect(install.env).toMatchObject({
        NODE_AUTH_TOKEN:
          "${{ github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.token || '' }}",
      });
      expect(install.run).toContain(".github/actions/ci-install-dependencies.sh");
      expect(install.run).toContain("npm ci --ignore-scripts");
    },
  );
});
