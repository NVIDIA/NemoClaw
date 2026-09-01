// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import { type CommandRunner, HostCliClient } from "../fixtures/clients/index.ts";
import type { E2ETargetFixtures } from "../fixtures/e2e-test.ts";
import { type DockerRuntimeReady, EnvironmentPhaseFixture } from "../fixtures/phases/index.ts";
import type {
  ShellProbeResult,
  ShellProbeRunOptions,
  TrustedShellCommand,
} from "../fixtures/shell-probe.ts";
import type { TargetEnvironment } from "../registry/types.ts";

interface RunnerCall {
  command: string;
  args: string[];
  options?: ShellProbeRunOptions;
}

function shellResult(exitCode: number, output = ""): ShellProbeResult {
  return {
    command: [],
    exitCode,
    signal: null,
    timedOut: false,
    stdout: output,
    stderr: exitCode === 0 ? "" : output,
    artifacts: {
      stdout: "/tmp/stdout.txt",
      stderr: "/tmp/stderr.txt",
      result: "/tmp/result.json",
    },
  };
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

class FakeRunner implements CommandRunner {
  readonly calls: RunnerCall[] = [];
  private readonly responses: Array<ShellProbeResult | Error> = [];

  enqueue(response: ShellProbeResult | Error): void {
    this.responses.push(response);
  }

  async run(
    command: TrustedShellCommand,
    options?: ShellProbeRunOptions,
  ): Promise<ShellProbeResult> {
    this.calls.push({ command: command.command, args: [...command.args], options });
    const response = this.responses.shift() ?? shellResult(0);
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }
}

const cloudOpenClawEnvironment: TargetEnvironment = {
  platform: "ubuntu-local",
  install: "repo-current",
  runtime: "docker-running",
  onboarding: "cloud-openclaw",
};

afterEach(() => vi.unstubAllEnvs());

describe("environment phase fixture", () => {
  it("asserts the current repo CLI and required Docker runtime", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(0, "Docker is available\n"));
    const environment = new EnvironmentPhaseFixture(
      new HostCliClient(runner, { cliPath: "./bin/nemoclaw.js" }),
    );

    const ready = await environment.assertReady(cloudOpenClawEnvironment);

    expect(ready).toMatchObject({
      platform: "ubuntu-local",
      install: "repo-current",
      runtime: "docker-running",
      onboarding: "cloud-openclaw",
      cliPath: "./bin/nemoclaw.js",
      docker: {
        id: "docker-running",
        expectation: "required",
        available: true,
      } satisfies Partial<DockerRuntimeReady>,
    });
    expect(runner.calls).toEqual([
      {
        command: "./bin/nemoclaw.js",
        args: ["--version"],
        options: {
          artifactName: "nemoclaw-version",
          env: expect.objectContaining({
            PATH: expect.any(String),
          }),
        },
      },
      {
        command: "docker",
        args: ["info"],
        options: {
          artifactName: "runtime-docker-info-docker-running",
          env: expect.objectContaining({
            PATH: expect.any(String),
          }),
          timeoutMs: 30_000,
        },
      },
    ]);
  });

  it("fails when a required Docker runtime is unavailable", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(1, "Cannot connect to the Docker daemon"));
    const environment = new EnvironmentPhaseFixture(new HostCliClient(runner));

    await expect(environment.assertReady(cloudOpenClawEnvironment)).rejects.toThrow(
      /docker runtime docker-running failed: Cannot connect/,
    );
  });

  it("accepts an unavailable Docker runtime for no-Docker negative targets", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(1, "docker intentionally unavailable"));
    const environment = new EnvironmentPhaseFixture(new HostCliClient(runner));

    const ready = await environment.assertReady({
      ...cloudOpenClawEnvironment,
      runtime: "docker-missing",
      onboarding: "cloud-openclaw-no-docker",
    });

    expect(ready.docker).toMatchObject({
      id: "docker-missing",
      expectation: "missing",
      available: false,
    });
  });

  it("records Docker availability for no-Docker negative targets without blocking simulation", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(0, "Docker is available\n"));
    const environment = new EnvironmentPhaseFixture(new HostCliClient(runner));

    const ready = await environment.assertReady({
      ...cloudOpenClawEnvironment,
      runtime: "docker-missing",
      onboarding: "cloud-openclaw-no-docker",
    });

    expect(ready.docker).toMatchObject({
      id: "docker-missing",
      expectation: "missing",
      available: true,
    });
  });

  it("records optional Docker as unavailable without failing", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(new Error("spawn docker ENOENT"));
    const environment = new EnvironmentPhaseFixture(new HostCliClient(runner));

    const ready = await environment.assertReady({
      ...cloudOpenClawEnvironment,
      platform: "macos-local",
      runtime: "macos-docker-optional",
    });

    expect(ready.docker).toMatchObject({
      id: "macos-docker-optional",
      expectation: "optional",
      available: false,
      probeError: "spawn docker ENOENT",
    });
  });

  it("records optional Docker as available when present", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(0, "Docker is available\n"));
    const environment = new EnvironmentPhaseFixture(new HostCliClient(runner));

    const ready = await environment.assertReady({
      ...cloudOpenClawEnvironment,
      platform: "macos-local",
      runtime: "macos-docker-optional",
    });

    expect(ready.docker).toMatchObject({
      id: "macos-docker-optional",
      expectation: "optional",
      available: true,
    });
  });

  it("scopes availability probe env instead of inheriting unrelated secrets", async () => {
    vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus");
    vi.stubEnv("NVIDIA_INFERENCE_API_KEY", "must-not-leak");
    vi.stubEnv("DOCKER_HOST", "unix:///tmp/e2e-docker.sock");
    vi.stubEnv("HOME", "/tmp/e2e-home");
    vi.stubEnv("NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR", "/tmp/e2e-gateway-state");
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/tmp/e2e-gateway-tls");
    vi.stubEnv("PATH", "/usr/bin");

    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(0, "Docker is available\n"));
    const environment = new EnvironmentPhaseFixture(new HostCliClient(runner));

    await environment.assertReady(cloudOpenClawEnvironment);

    const cliEnv = runner.calls[0]?.options?.env;
    const dockerEnv = runner.calls[1]?.options?.env;
    expect(cliEnv).toMatchObject({
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      DOCKER_HOST: "unix:///tmp/e2e-docker.sock",
      NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: "/tmp/e2e-gateway-state",
      OPENSHELL_LOCAL_TLS_DIR: "/tmp/e2e-gateway-tls",
    });
    expect(dockerEnv).toMatchObject({
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      DOCKER_HOST: "unix:///tmp/e2e-docker.sock",
      NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: "/tmp/e2e-gateway-state",
      OPENSHELL_LOCAL_TLS_DIR: "/tmp/e2e-gateway-tls",
    });
    expect(cliEnv?.PATH).toBe("/tmp/e2e-home/.local/bin:/usr/bin");
    expect(dockerEnv?.PATH).toBe("/tmp/e2e-home/.local/bin:/usr/bin");
    expect(cliEnv).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");
    expect(dockerEnv).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");
  });

  it("treats launchable install as current first-layer CLI readiness", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(0, "Docker is available\n"));
    const environment = new EnvironmentPhaseFixture(new HostCliClient(runner));

    const ready = await environment.assertReady({
      ...cloudOpenClawEnvironment,
      install: "launchable",
    });

    expect(ready.install).toBe("launchable");
    expect(runner.calls.map((call) => [call.command, call.args])).toEqual([
      ["nemoclaw", ["--version"]],
      ["docker", ["info"]],
    ]);
  });

  it("treats gpu-docker-cdi as current first-layer Docker daemon readiness", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(0, "Docker is available\n"));
    const environment = new EnvironmentPhaseFixture(new HostCliClient(runner));

    const ready = await environment.assertReady({
      ...cloudOpenClawEnvironment,
      runtime: "gpu-docker-cdi",
    });

    expect(ready.docker).toMatchObject({
      id: "gpu-docker-cdi",
      expectation: "required",
      available: true,
    });
    expect(runner.calls[1]).toMatchObject({
      command: "docker",
      args: ["info"],
      options: {
        artifactName: "runtime-docker-info-gpu-docker-cdi",
        timeoutMs: 30_000,
      },
    });
  });

  it("rejects unsupported install and runtime IDs", async () => {
    const runner = new FakeRunner();
    const environment = new EnvironmentPhaseFixture(new HostCliClient(runner));

    await expect(
      environment.assertReady({ ...cloudOpenClawEnvironment, install: "tarball" }),
    ).rejects.toThrow(/Unsupported target install 'tarball'/);
    expect(runner.calls).toEqual([]);

    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    await expect(
      environment.assertReady({ ...cloudOpenClawEnvironment, runtime: "podman-running" }),
    ).rejects.toThrow(/Unsupported target runtime 'podman-running'/);
  });

  it("writes an environment phase result artifact on success", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-environment-artifacts-"));
    try {
      const runner = new FakeRunner();
      runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
      runner.enqueue(shellResult(0, "Docker is available\n"));
      const artifacts = new ArtifactSink(tmp);
      const environment = new EnvironmentPhaseFixture(new HostCliClient(runner), artifacts);

      await environment.assertReady(cloudOpenClawEnvironment);

      expect(readJson(path.join(tmp, "environment.result.json"))).toMatchObject({
        phase: "environment",
        status: "passed",
        environment: {
          platform: "ubuntu-local",
          install: "repo-current",
          runtime: "docker-running",
          onboarding: "cloud-openclaw",
          cliPath: "nemoclaw",
        },
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("writes an environment phase result artifact on failure", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-environment-artifacts-"));
    try {
      const artifacts = new ArtifactSink(tmp);
      const environment = new EnvironmentPhaseFixture(
        new HostCliClient(new FakeRunner()),
        artifacts,
      );

      await expect(
        environment.assertReady({ ...cloudOpenClawEnvironment, install: "tarball" }),
      ).rejects.toThrow(/Unsupported target install 'tarball'/);

      expect(readJson(path.join(tmp, "environment.result.json"))).toMatchObject({
        phase: "environment",
        status: "failed",
        environment: {
          install: "tarball",
        },
        error: "Unsupported target install 'tarball'.",
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("exposes the environment phase on the E2E target context", () => {
    expectTypeOf<E2ETargetFixtures["environment"]>().toEqualTypeOf<EnvironmentPhaseFixture>();
  });
});
