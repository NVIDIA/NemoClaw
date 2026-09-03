// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../availability-env.ts";
import type { ArtifactSink } from "../artifacts.ts";
import { artifactLabel, assertExitZero } from "../clients/command.ts";
import type { HostCliClient } from "../clients/host.ts";
import { RuntimeProviderPrerequisite } from "../runtime-provider.ts";
import type { ShellProbeResult } from "../shell-probe.ts";
import type { TargetEnvironment } from "../../registry/types.ts";

const SUPPORTED_INSTALLS = new Set(["repo-current", "launchable"]);

const RUNTIME_EXPECTATIONS = {
  "managed-runtime-running": "required",
  "docker-running": "required",
  "gpu-docker-cdi": "required",
  "docker-missing": "missing",
  "macos-docker-optional": "optional",
} as const;

export type RuntimeExpectation = (typeof RUNTIME_EXPECTATIONS)[keyof typeof RUNTIME_EXPECTATIONS];

export interface RuntimeReady {
  id: string;
  expectation: RuntimeExpectation;
  providerId: "docker" | "podman";
  available: boolean;
  result?: ShellProbeResult;
  probeError?: string;
}

export interface EnvironmentReady extends TargetEnvironment {
  cliPath: string;
  runtimeProvider: RuntimeReady;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function supportedRuntime(runtime: string): RuntimeExpectation {
  const expectation = RUNTIME_EXPECTATIONS[runtime as keyof typeof RUNTIME_EXPECTATIONS];
  if (!expectation) {
    throw new Error(`Unsupported target runtime '${runtime}'.`);
  }
  return expectation;
}

export class EnvironmentPhaseFixture {
  constructor(
    private readonly host: HostCliClient,
    private readonly artifacts?: ArtifactSink,
    private readonly runtimeProvider = new RuntimeProviderPrerequisite(host, (reason) => {
      throw new Error(reason);
    }),
  ) {}

  async assertReady(environment: TargetEnvironment): Promise<EnvironmentReady> {
    try {
      await this.assertInstallReady(environment.install);
      const runtimeProvider = await this.assertRuntimeReady(environment.runtime);
      const result = {
        ...environment,
        cliPath: this.host.commandPath,
        runtimeProvider,
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

  private async assertRuntimeReady(runtime: string): Promise<RuntimeReady> {
    const expectation = supportedRuntime(runtime);
    const result = await this.probeRuntime(runtime, expectation);
    if (!result.result) {
      return result;
    }

    if (expectation === "required") {
      assertExitZero(result.result, `${result.providerId} runtime ${runtime}`);
    }
    // Missing-runtime targets simulate Docker failure at the phase that
    // needs it; this probe records host reality without blocking composition.
    return result;
  }

  private async probeRuntime(
    runtime: string,
    expectation: RuntimeExpectation,
  ): Promise<RuntimeReady> {
    try {
      const selectedProvider = runtime === "managed-runtime-running";
      const providerId = selectedProvider ? this.runtimeProvider.id : "docker";
      const result = selectedProvider
        ? await this.runtimeProvider.command(["info"], {
            artifactName: `runtime-${providerId}-info-${artifactLabel(runtime)}`,
            timeoutMs: 30_000,
          })
        : await this.host.command("docker", ["info"], {
        artifactName: `runtime-docker-info-${artifactLabel(runtime)}`,
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      });
      return {
        id: runtime,
        expectation,
        providerId,
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
        providerId: runtime === "managed-runtime-running" ? this.runtimeProvider.id : "docker",
        available: false,
        probeError: errorMessage(error),
      };
    }
  }
}
