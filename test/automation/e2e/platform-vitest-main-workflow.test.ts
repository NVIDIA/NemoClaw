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
const workflow = readYaml<
  Workflow & {
    concurrency: { group: string; queue: "max"; "cancel-in-progress": boolean };
    on: { push: { branches: string[]; "paths-ignore": string[] } };
    permissions: Record<string, string>;
  }
>(WORKFLOW_PATH);
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
  // source-shape-contract: compatibility -- Exact concurrency settings preserve distinct main commit evidence without overlapping platform runs
  it("preserves distinct main-commit evidence in a serialized queue", () => {
    expect(workflow.concurrency).toEqual({
      group: "platform-evidence-${{ github.ref }}",
      queue: "max",
      "cancel-in-progress": false,
    });
  });

  // source-shape-contract: security -- Main only execution and exact workflow permissions keep package credentials out of candidate controlled runs
  it("grants only the read access needed to install reviewed dependencies", () => {
    expect(Object.keys(workflow.on)).toEqual(["push"]);
    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(
      Object.entries(workflow.jobs)
        .filter(([, workflowJob]) => workflowJob.permissions !== undefined)
        .map(([name, workflowJob]) => [name, workflowJob.permissions]),
    ).toEqual([
      ["macos-vitest", { contents: "read", packages: "read" }],
      ["macos-live-e2e", { contents: "read", packages: "read" }],
      ["wsl-vitest", { contents: "read", packages: "read" }],
    ]);
    expect(JSON.stringify(workflow)).not.toContain("sdk-artifact-run-id");
    expect(JSON.stringify(workflow)).not.toContain("actions/download-artifact");
  });

  it("marks the container checkout safe before generating build identity", () => {
    const run = step("ubuntu-2604-contract", "Build CLI").run ?? "";
    expect(run).toContain('git config --global --add safe.directory "$GITHUB_WORKSPACE"');
    expect(run).toContain('test "$(git rev-parse --verify HEAD)" = "$GITHUB_SHA"');
    expect(run.indexOf("safe.directory")).toBeLessThan(run.indexOf("npm run build:cli"));
  });
  it("limits credentialed WSL E2E to the first main-branch shard", () => {
    const live = step("wsl-vitest", "Run WSL live E2E");
    const detection = step("wsl-vitest", "Detect Docker availability in WSL");
    expect(live.if).toContain("matrix.shard == 1");
    expect(live.if).toContain("steps.wsl_docker.outputs.docker_ok == 'true'");
    expect(live.if).toContain("github.ref == 'refs/heads/main'");
    expect(live.env).toMatchObject({
      GITHUB_TOKEN: "${{ github.token }}",
      NVIDIA_INFERENCE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
    });
    expect(detection.run).toContain("-User $env:WSL_TEST_USER");
    expect(live.run).toContain("-User $env:WSL_TEST_USER");
  });

  it("keeps credentialed macOS E2E independent from non-live shard failures", () => {
    const nonLive = job("macos-vitest");
    const liveJob = job("macos-live-e2e");
    const live = step("macos-live-e2e", "Run macOS live E2E");
    const installOpenShell = step("macos-live-e2e", "Install pinned OpenShell");
    expect(nonLive.steps).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Run macOS live E2E" })]),
    );
    expect(liveJob.needs).toBeUndefined();
    expect(liveJob["timeout-minutes"]).toBe(150);
    expect(liveJob.if).toContain("github.ref == 'refs/heads/main'");
    expect(JSON.stringify(liveJob)).not.toContain("brew install");
    expect(live.env).toHaveProperty("NEMOCLAW_RUN_LIVE_E2E", "1");
    expect(installOpenShell.run).toContain("scripts/install-openshell.sh");
    expect(live.if).toContain("steps.macos_docker.outputs.docker_ok == 'true'");
    expect(live.env).toMatchObject({
      GITHUB_TOKEN: "${{ github.token }}",
      NVIDIA_INFERENCE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
    });
  });

  it("verifies GNU tar without replacing the native macOS tar", () => {
    const install = step("macos-vitest", "Install macOS test dependencies").run ?? "";
    const vitest = step("macos-vitest", "Run full Vitest suite on macOS").run ?? "";
    expect(install).toContain('test -x "$(command -v gtar)"');
    expect(install.indexOf('test -x "$(command -v gtar)"')).toBeLessThan(
      install.indexOf("brew install"),
    );
    expect(install).not.toContain('ln -s "$(command -v gtar)"');
    expect(install).not.toContain('"$RUNNER_TEMP/nemoclaw-bin"');
    expect(install).not.toMatch(/brew install[^\n]*(?:docker|gnu-tar|iproute2mac|podman)/u);
    expect(vitest).toContain('ln -s "$(command -v gtar)" "$RUNNER_TEMP/nemoclaw-vitest-bin/tar"');
    expect(vitest).toContain('PATH="$RUNNER_TEMP/nemoclaw-vitest-bin:$PATH"');
    expect(vitest).not.toContain("GITHUB_PATH");
  });

  // source-shape-contract: compatibility -- Exact WSL workflow ordering stops the runtime for hermetic tests before main only startup
  it("installs container clients before Vitest but starts Docker only afterward", () => {
    const steps = job("wsl-vitest").steps ?? [];
    const install = step("wsl-vitest", "Install Ubuntu dependencies").run ?? "";
    const stopped =
      step("wsl-vitest", "Stop WSL container runtime before non-live tests").run ?? "";
    const runtime = step("wsl-vitest", "Start the WSL container runtime").run ?? "";
    const installIndex = steps.findIndex((entry) => entry.name === "Install Ubuntu dependencies");
    const stoppedIndex = steps.findIndex(
      (entry) => entry.name === "Stop WSL container runtime before non-live tests",
    );
    const runtimeIndex = steps.findIndex(
      (entry) => entry.name === "Start the WSL container runtime",
    );
    const suiteIndex = steps.findIndex((entry) => entry.name === "Run full Vitest suite in WSL");
    const detectionIndex = steps.findIndex(
      (entry) => entry.name === "Detect Docker availability in WSL",
    );
    const liveIndex = steps.findIndex((entry) => entry.name === "Run WSL live E2E");
    expect(install).toContain("'docker.io'");
    expect(install).toContain("'gcc'");
    expect(install).toContain("'libc6-dev'");
    expect(install).toContain("'podman'");
    expect(install).toContain("'procps'");
    expect(install).toContain("'iproute2'");
    expect(install).toContain("'zip'");
    expect(install).toContain("'gnu-coreutils'");
    expect(install).not.toContain("service docker start");
    expect(stopped).toContain("service docker stop");
    expect(stopped).toContain("if docker info >/dev/null 2>&1; then");
    expect(stopped).toContain("exit 1");
    expect(runtime).not.toContain("Install-WslUbuntuDependencies");
    expect(runtime).toContain("service docker start");
    expect(runtime).toContain("docker info");
    expect(runtime).toContain("podman --version");
    expect(runtime).toContain("ip -Version");
    expect(step("wsl-vitest", "Resolve workspace paths for WSL").run).toContain(
      "-WorkdirPrefix '/home/nemoclaw-ci/nemoclaw-wsl-vitest'",
    );
    expect(step("wsl-vitest", "Start the WSL container runtime").if).toBe(
      "${{ matrix.shard == 1 && github.ref == 'refs/heads/main' }}",
    );
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(stoppedIndex).toBeGreaterThanOrEqual(0);
    expect(runtimeIndex).toBeGreaterThanOrEqual(0);
    expect(suiteIndex).toBeGreaterThanOrEqual(0);
    expect(detectionIndex).toBeGreaterThanOrEqual(0);
    expect(liveIndex).toBeGreaterThanOrEqual(0);
    expect(stoppedIndex).toBeGreaterThan(installIndex);
    expect(stoppedIndex).toBeLessThan(suiteIndex);
    expect(runtimeIndex).toBeGreaterThan(suiteIndex);
    expect(detectionIndex).toBeGreaterThan(runtimeIndex);
    expect(liveIndex).toBeGreaterThan(detectionIndex);
  });

  it("uses one native WSL npm cache for installation and package-contract tests", () => {
    const install = step("wsl-vitest", "Install dependencies and build in WSL").run ?? "";
    const vitest = step("wsl-vitest", "Run full Vitest suite in WSL").run ?? "";
    expect(install).toContain('export NPM_CONFIG_CACHE="`$HOME/.npm"');
    expect(vitest).toContain('export NPM_CONFIG_CACHE="`$HOME/.npm"');
  });

  const liveOnlyEnvironment = {
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: "e2e-wsl",
  };

  it.each(Object.entries(liveOnlyEnvironment))(
    "scopes WSL %s to the credentialed live step",
    (key, value) => {
      const wsl = job("wsl-vitest");
      const live = step("wsl-vitest", "Run WSL live E2E");
      expect(wsl.env).not.toHaveProperty(key);
      const leakedSteps = (wsl.steps ?? [])
        .filter((entry) => entry.name !== "Run WSL live E2E")
        .filter((entry) => Object.hasOwn(entry.env ?? {}, key) || entry.run?.includes(key));
      expect(leakedSteps).toEqual([]);
      expect(live.env).toHaveProperty(key, value);
    },
  );

  it.each([
    { jobName: "macos-vitest", stepName: "Install dependencies" },
    { jobName: "macos-live-e2e", stepName: "Install dependencies" },
    { jobName: "wsl-vitest", stepName: "Install dependencies and build in WSL" },
  ])(
    "limits the package credential to trusted $jobName dependency installation",
    ({ jobName, stepName }) => {
      const install = step(jobName, stepName);
      expect(install.env).toEqual({ NODE_AUTH_TOKEN: "${{ github.token }}" });
      expect(install.run).toContain(".github/actions/ci-install-dependencies.sh");
    },
  );

  it("removes the package credential before the WSL build", () => {
    const install = step("wsl-vitest", "Install dependencies and build in WSL");
    expect(install.run).toContain("unset NODE_AUTH_TOKEN");
  });
});
