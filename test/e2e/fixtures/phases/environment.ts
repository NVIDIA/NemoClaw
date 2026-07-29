// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isAbsolute } from "node:path";
import type { TargetEnvironment } from "../../registry/types.ts";
import type { ArtifactSink } from "../artifacts.ts";
import { buildAvailabilityProbeEnv } from "../availability-env.ts";
import { artifactLabel, assertExitZero } from "../clients/command.ts";
import type { HostCliClient } from "../clients/host.ts";
import type { ShellProbeResult } from "../shell-probe.ts";

const SUPPORTED_INSTALLS = new Set(["repo-current", "launchable"]);

const DOCKER_ENV_KEYS = [
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "DOCKER_API_VERSION",
] as const;

export type ContainerRuntimeExpectation = "required" | "missing" | "optional";

export interface ContainerRuntimeReady {
  id: string;
  driverName: string;
  expectation: ContainerRuntimeExpectation;
  available: boolean;
  result?: ShellProbeResult;
  probeError?: string;
}

export interface EnvironmentReady extends TargetEnvironment {
  cliPath: string;
  containerRuntime: ContainerRuntimeReady;
}

interface ContainerRuntimeProbe {
  driverName: string;
  expectation: ContainerRuntimeExpectation;
  command: string;
  args: () => string[];
  env: () => NodeJS.ProcessEnv;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withoutDockerEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...environment };
  for (const key of DOCKER_ENV_KEYS) {
    delete sanitized[key];
  }
  return sanitized;
}

function podmanSocketPath(): string {
  const socketPath = process.env.OPENSHELL_PODMAN_SOCKET?.trim();
  if (!socketPath) {
    throw new Error("podman-running requires OPENSHELL_PODMAN_SOCKET.");
  }
  if (!isAbsolute(socketPath)) {
    throw new Error("OPENSHELL_PODMAN_SOCKET must be an absolute path.");
  }
  return socketPath;
}

function dockerProbe(expectation: ContainerRuntimeExpectation): ContainerRuntimeProbe {
  return {
    driverName: "docker",
    expectation,
    command: "docker",
    args: () => ["info"],
    env: () => buildAvailabilityProbeEnv(),
  };
}

const CONTAINER_RUNTIME_PROBES: Readonly<Record<string, ContainerRuntimeProbe>> = {
  "docker-running": dockerProbe("required"),
  "gpu-docker-cdi": dockerProbe("required"),
  "docker-missing": dockerProbe("missing"),
  "macos-docker-optional": dockerProbe("optional"),
  "podman-running": {
    driverName: "podman",
    expectation: "required",
    command: "podman",
    args: () => ["--url", `unix://${podmanSocketPath()}`, "info", "--format", "json"],
    env: () => withoutDockerEnvironment(buildAvailabilityProbeEnv()),
  },
};

function supportedRuntime(runtime: string): ContainerRuntimeProbe {
  const probe = CONTAINER_RUNTIME_PROBES[runtime];
  if (!probe) {
    throw new Error(`Unsupported target runtime '${runtime}'.`);
  }
  return probe;
}

export class EnvironmentPhaseFixture {
  constructor(
    private readonly host: HostCliClient,
    private readonly artifacts?: ArtifactSink,
  ) {}

  async assertReady(environment: TargetEnvironment): Promise<EnvironmentReady> {
    try {
      await this.assertInstallReady(environment.install);
      const containerRuntime = await this.assertRuntimeReady(environment.runtime);
      const result = {
        ...environment,
        cliPath: this.host.commandPath,
        containerRuntime,
      };
      await this.writeResult("passed", result);
      return result;
    } catch (error) {
      await this.writeResult("failed", environment, error);
      throw error;
    }
  }

  private async writeResult(
    status: "passed" | "failed",
    environment: TargetEnvironment | EnvironmentReady,
    error?: unknown,
  ): Promise<void> {
    await this.artifacts?.writeJson("environment.result.json", {
      phase: "environment",
      status,
      environment,
      ...(error ? { error: errorMessage(error) } : {}),
    });
  }

  private async assertInstallReady(install: string): Promise<ShellProbeResult> {
    if (!SUPPORTED_INSTALLS.has(install)) {
      throw new Error(`Unsupported target install '${install}'.`);
    }
    return this.host.expectNemoclawAvailable();
  }

  private async assertRuntimeReady(runtime: string): Promise<ContainerRuntimeReady> {
    const probe = supportedRuntime(runtime);
    const result = await this.probeContainerRuntime(runtime, probe);
    if (!result.result) {
      return result;
    }

    if (probe.expectation === "required") {
      assertExitZero(result.result, `${probe.driverName} runtime ${runtime}`);
    }
    // Missing-runtime targets simulate runtime failure at the phase that
    // needs it; this probe records host reality without blocking composition.
    return result;
  }

  private async probeContainerRuntime(
    runtime: string,
    probe: ContainerRuntimeProbe,
  ): Promise<ContainerRuntimeReady> {
    try {
      const result = await this.host.command(probe.command, probe.args(), {
        artifactName: `runtime-${artifactLabel(probe.driverName)}-info-${artifactLabel(runtime)}`,
        env: probe.env(),
        timeoutMs: 30_000,
      });
      return {
        id: runtime,
        driverName: probe.driverName,
        expectation: probe.expectation,
        available: result.exitCode === 0,
        result,
      };
    } catch (error) {
      if (probe.expectation === "required") {
        throw error;
      }
      return {
        id: runtime,
        driverName: probe.driverName,
        expectation: probe.expectation,
        available: false,
        probeError: errorMessage(error),
      };
    }
  }
}
