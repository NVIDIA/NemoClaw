// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { artifactLabel, assertExitZero } from "../clients/command.ts";
import type { HostCliClient } from "../clients/host.ts";
import type { ShellProbeResult } from "../shell-probe.ts";
import type { EnvironmentReady } from "./environment.ts";

const ONBOARD_ARGS = ["onboard", "--non-interactive", "--yes", "--yes-i-accept-third-party-software"];
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const OPENCLAW_GATEWAY_URL = "http://127.0.0.1:18789";

export interface OnboardingSecrets {
  required(name: string): string;
}

export interface OnboardingOptions {
  sandboxName?: string;
  timeoutMs?: number;
}

export interface OnboardingExpectedFailure {
  phase: "preflight";
  errorClass: "docker-missing";
}

export interface NemoClawInstance {
  onboarding: string;
  sandboxName: string;
  agent: "openclaw";
  provider: "nvidia";
  providerEnv: "cloud";
  gatewayUrl: string;
  result: ShellProbeResult;
  expectedFailure?: OnboardingExpectedFailure;
}

function defaultSandboxName(onboarding: string): string {
  return `e2e-${artifactLabel(onboarding)}`;
}

function commandEnv(sandboxName: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...extra,
    NEMOCLAW_AGENT: "openclaw",
    NEMOCLAW_PROVIDER: "cloud",
    NEMOCLAW_SANDBOX_NAME: sandboxName,
  };
}

function noDockerShim(): string {
  return `#!/usr/bin/env bash
printf 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\\n' >&2
exit 1
`;
}

export class OnboardingPhaseFixture {
  constructor(
    private readonly host: HostCliClient,
    private readonly secrets: OnboardingSecrets,
  ) {}

  async from(environment: EnvironmentReady, options: OnboardingOptions = {}): Promise<NemoClawInstance> {
    switch (environment.onboarding) {
      case "cloud-openclaw":
        return await this.cloudOpenClaw(environment, options);
      case "cloud-openclaw-no-docker":
        return await this.cloudOpenClawNoDocker(environment, options);
      default:
        throw new Error(`Unsupported onboarding profile '${environment.onboarding}'.`);
    }
  }

  async cloudOpenClaw(environment: EnvironmentReady, options: OnboardingOptions = {}): Promise<NemoClawInstance> {
    if (!environment.docker.available) {
      throw new Error("cloud-openclaw onboarding requires an available Docker runtime.");
    }
    const apiKey = this.secrets.required("NVIDIA_API_KEY");
    const sandboxName = options.sandboxName ?? defaultSandboxName(environment.onboarding);
    const result = await this.host.nemoclaw(ONBOARD_ARGS, {
      artifactName: "onboard-cloud-openclaw",
      env: commandEnv(sandboxName),
      inheritEnv: true,
      redactionValues: [apiKey],
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    assertExitZero(result, "cloud-openclaw onboarding");
    return {
      onboarding: environment.onboarding,
      sandboxName,
      agent: "openclaw",
      provider: "nvidia",
      providerEnv: "cloud",
      gatewayUrl: OPENCLAW_GATEWAY_URL,
      result,
    };
  }

  async cloudOpenClawNoDocker(environment: EnvironmentReady, options: OnboardingOptions = {}): Promise<NemoClawInstance> {
    if (environment.docker.available) {
      throw new Error("cloud-openclaw-no-docker onboarding requires Docker to be unavailable.");
    }
    const sandboxName = options.sandboxName ?? defaultSandboxName(environment.onboarding);
    const shimDir = await mkdtemp(join(tmpdir(), "e2e-no-docker-"));
    const shimPath = join(shimDir, "docker");
    try {
      await writeFile(shimPath, noDockerShim(), "utf8");
      await chmod(shimPath, 0o700);
      const result = await this.host.nemoclaw(ONBOARD_ARGS, {
        artifactName: "onboard-cloud-openclaw-no-docker",
        env: commandEnv(sandboxName, {
          PATH: `${shimDir}:${process.env.PATH ?? ""}`,
        }),
        inheritEnv: true,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      if (result.exitCode === 0) {
        throw new Error("cloud-openclaw-no-docker onboarding unexpectedly succeeded.");
      }
      return {
        onboarding: environment.onboarding,
        sandboxName,
        agent: "openclaw",
        provider: "nvidia",
        providerEnv: "cloud",
        gatewayUrl: OPENCLAW_GATEWAY_URL,
        result,
        expectedFailure: {
          phase: "preflight",
          errorClass: "docker-missing",
        },
      };
    } finally {
      await rm(shimDir, { force: true, recursive: true });
    }
  }
}
