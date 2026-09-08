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
  it("limits credentialed WSL E2E to the first main-branch shard", () => {
    const live = step("wsl-vitest", "Run WSL live E2E");
    expect(live.if).toContain("matrix.shard == 1");
    expect(live.if).toContain("steps.wsl_docker.outputs.docker_ok == 'true'");
    expect(live.if).toContain("github.ref == 'refs/heads/main'");
    expect(live.env).toMatchObject({
      GITHUB_TOKEN: "${{ github.token }}",
      NVIDIA_INFERENCE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
    });
  });

  it("isolates credentialed macOS E2E from mutable non-live dependencies", () => {
    const nonLive = job("macos-vitest");
    const liveJob = job("macos-live-e2e");
    const live = step("macos-live-e2e", "Run macOS live E2E");
    const installOpenShell = step("macos-live-e2e", "Install pinned OpenShell");
    expect(nonLive.steps).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Run macOS live E2E" })]),
    );
    expect(liveJob.needs).toBe("macos-vitest");
    expect(liveJob.if).toContain("github.ref == 'refs/heads/main'");
    expect(JSON.stringify(liveJob)).not.toContain("brew install");
    expect(installOpenShell.run).toContain("scripts/install-openshell.sh");
    expect(live.if).toContain("steps.macos_docker.outputs.docker_ok == 'true'");
    expect(live.env).toMatchObject({
      GITHUB_TOKEN: "${{ github.token }}",
      NVIDIA_INFERENCE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
    });
  });

  it("uses the runner's preinstalled GNU tar without adding mutable formulae", () => {
    const install = step("macos-vitest", "Install macOS test dependencies").run ?? "";
    expect(install).toContain('test -x "$(command -v gtar)"');
    expect(install.indexOf('test -x "$(command -v gtar)"')).toBeLessThan(
      install.indexOf("brew install"),
    );
    expect(install).toContain('ln -s "$(command -v gtar)" "$RUNNER_TEMP/nemoclaw-bin/tar"');
    expect(install).toContain('"$RUNNER_TEMP/nemoclaw-bin"');
    expect(install).not.toMatch(/brew install[^\n]*(?:docker|gnu-tar|iproute2mac|podman)/u);
  });

  it("keeps container clients out of the non-live WSL suite", () => {
    const steps = job("wsl-vitest").steps ?? [];
    const install = step("wsl-vitest", "Install Ubuntu dependencies").run ?? "";
    const runtime = step("wsl-vitest", "Install and start the WSL container runtime").run ?? "";
    const runtimeIndex = steps.findIndex(
      (entry) => entry.name === "Install and start the WSL container runtime",
    );
    const suiteIndex = steps.findIndex((entry) => entry.name === "Run full Vitest suite in WSL");
    expect(install).not.toContain("'docker.io'");
    expect(install).not.toContain("'podman'");
    expect(runtime).toContain("'docker.io'");
    expect(runtime).toContain("'podman'");
    expect(runtime).toContain("service docker start");
    expect(runtime).toContain("docker info");
    expect(runtime).toContain("podman --version");
    expect(runtime).toContain("ip -Version");
    expect(runtimeIndex).toBeGreaterThanOrEqual(0);
    expect(suiteIndex).toBeGreaterThanOrEqual(0);
    expect(runtimeIndex).toBeGreaterThan(suiteIndex);
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
          "${{ github.repository == 'NVIDIA/NemoClaw' && (github.event_name == 'workflow_dispatch' || (github.event_name == 'push' && github.ref == 'refs/heads/main')) && github.token || '' }}",
      });
      expect(install.run).toContain(".github/actions/ci-install-dependencies.sh");
      expect(install.run).toContain("npm ci --ignore-scripts");
    },
  );
});
