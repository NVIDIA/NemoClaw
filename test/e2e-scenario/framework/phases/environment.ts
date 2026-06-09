// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../availability-env.ts";
import { artifactLabel, assertExitZero } from "../clients/command.ts";
import type { HostCliClient } from "../clients/host.ts";
import type { ShellProbeResult } from "../shell-probe.ts";
import type { ScenarioEnvironment } from "../../scenarios/types.ts";

const SUPPORTED_INSTALLS = new Set(["repo-current", "launchable"]);

const DOCKER_RUNTIME_EXPECTATIONS = {
  "docker-running": "required",
  "gpu-docker-cdi": "required",
  "docker-missing": "missing",
  "macos-docker-optional": "optional",
} as const;

export type DockerRuntimeExpectation =
  (typeof DOCKER_RUNTIME_EXPECTATIONS)[keyof typeof DOCKER_RUNTIME_EXPECTATIONS];

export interface DockerRuntimeReady {
  id: string;
  expectation: DockerRuntimeExpectation;
  available: boolean;
  result?: ShellProbeResult;
  probeError?: string;
}

export interface EnvironmentReady extends ScenarioEnvironment {
  cliPath: string;
  docker: DockerRuntimeReady;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function supportedRuntime(runtime: string): DockerRuntimeExpectation {
  const expectation = DOCKER_RUNTIME_EXPECTATIONS[runtime as keyof typeof DOCKER_RUNTIME_EXPECTATIONS];
  if (!expectation) {
    throw new Error(`Unsupported scenario runtime '${runtime}'.`);
  }
  return expectation;
}

export class EnvironmentPhaseFixture {
  constructor(private readonly host: HostCliClient) {}

  async assertReady(environment: ScenarioEnvironment): Promise<EnvironmentReady> {
    await this.assertInstallReady(environment.install);
    const docker = await this.assertRuntimeReady(environment.runtime);
    return {
      ...environment,
      cliPath: this.host.commandPath,
      docker,
    };
  }

  private async assertInstallReady(install: string): Promise<ShellProbeResult> {
    if (!SUPPORTED_INSTALLS.has(install)) {
      throw new Error(`Unsupported scenario install '${install}'.`);
    }
    return this.host.expectNemoclawAvailable();
  }

  private async assertRuntimeReady(runtime: string): Promise<DockerRuntimeReady> {
    const expectation = supportedRuntime(runtime);
    const result = await this.probeDocker(runtime, expectation);
    if (!result.result) {
      return result;
    }

    if (expectation === "required") {
      assertExitZero(result.result, `docker runtime ${runtime}`);
    }
    // Missing-runtime scenarios simulate Docker failure at the phase that
    // needs it; this probe records host reality without blocking composition.
    return result;
  }

  private async probeDocker(runtime: string, expectation: DockerRuntimeExpectation): Promise<DockerRuntimeReady> {
    try {
      const result = await this.host.command("docker", ["info"], {
        artifactName: `runtime-docker-info-${artifactLabel(runtime)}`,
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      });
      return {
        id: runtime,
        expectation,
        available: result.exitCode === 0,
        result,
      };
    } catch (error) {
      if (expectation === "required") {
        throw error;
      }
      return {
        id: runtime,
        expectation,
        available: false,
        probeError: errorMessage(error),
      };
    }
  }
}
