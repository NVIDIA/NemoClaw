// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildAvailabilityProbeEnv } from "../availability-env.ts";
import { artifactLabel, assertExitZero } from "../clients/command.ts";
import type { HostCliClient } from "../clients/host.ts";
import { validateSandboxName } from "../clients/sandbox.ts";
import type { ShellProbeResult } from "../shell-probe.ts";
import { redactString } from "../../scenarios/orchestrators/redaction.ts";
import type { EnvironmentReady } from "./environment.ts";

const ONBOARD_ARGS = ["onboard", "--non-interactive", "--yes", "--yes-i-accept-third-party-software"];
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const OPENCLAW_GATEWAY_URL = "http://127.0.0.1:18789";
const NEGATIVE_PREFLIGHT_LOG = "negative-preflight.log";
const DOCKER_MISSING_PATTERNS = [
  /Cannot connect to the Docker daemon/i,
  /Is the docker daemon running\??/i,
  /docker daemon is not running/i,
  /docker[- ]missing/i,
  /Docker is required before onboarding/i,
  /Docker is not reachable/i,
  /could not talk to the Docker daemon/i,
];
const MISSING_SANDBOX_DELETE_PATTERNS = [
  /\bNotFound\b/i,
  /\bNot Found\b/i,
  /sandbox not found/i,
  /sandbox .* not found/i,
  /sandbox .* not present/i,
  /sandbox does not exist/i,
  /no such sandbox/i,
];

export interface OnboardingSecrets {
  required(name: string): string;
  redact?(text: string, extraValues?: string[]): string;
}

export interface OnboardingCleanup {
  add(name: string, run: () => Promise<void> | void): void;
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

function sandboxNameFromOptions(onboarding: string, options: OnboardingOptions): string {
  const sandboxName = options.sandboxName ?? defaultSandboxName(onboarding);
  validateSandboxName(sandboxName);
  return sandboxName;
}

function commandEnv(sandboxName: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    ...extra,
    NEMOCLAW_AGENT: "openclaw",
    NEMOCLAW_PROVIDER: "cloud",
    NEMOCLAW_SANDBOX_NAME: sandboxName,
  };
}

function noDockerShim(): string {
  // Migration source of truth for the typed fixture path: simulate the invalid
  // state where the Docker client exists but the daemon is unreachable. The
  // legacy shell worker keeps a matching shim until live no-Docker onboarding
  // dispatch moves fully into Vitest; remove both shims once the scenario can
  // inject a Docker client boundary directly instead of shadowing command lookup.
  return `#!/usr/bin/env bash
printf 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\\n' >&2
exit 1
`;
}

function prependPath(pathEntry: string, currentPath?: string): string {
  return currentPath ? `${pathEntry}:${currentPath}` : pathEntry;
}

function resultText(result: ShellProbeResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function redactExplicitValues(text: string, values: string[]): string {
  return values.reduce((redacted, value) => (value ? redacted.split(value).join("[REDACTED]") : redacted), text);
}

function legacyNegativePreflightLogPath(): string | undefined {
  const contextDir = process.env.E2E_CONTEXT_DIR;
  return contextDir ? join(contextDir, NEGATIVE_PREFLIGHT_LOG) : undefined;
}

function hasDockerMissingSignature(result: ShellProbeResult): boolean {
  const text = resultText(result);
  return DOCKER_MISSING_PATTERNS.some((pattern) => pattern.test(text));
}

function hasMissingSandboxDeleteSignature(result: ShellProbeResult): boolean {
  const text = resultText(result);
  return MISSING_SANDBOX_DELETE_PATTERNS.some((pattern) => pattern.test(text));
}

export class OnboardingPhaseFixture {
  constructor(
    private readonly host: HostCliClient,
    private readonly secrets: OnboardingSecrets,
    private readonly cleanup?: OnboardingCleanup,
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
    const sandboxName = sandboxNameFromOptions(environment.onboarding, options);
    const apiKey = this.secrets.required("NVIDIA_API_KEY");
    this.registerSandboxCleanup(sandboxName);
    const result = await this.host.nemoclaw(ONBOARD_ARGS, {
      artifactName: "onboard-cloud-openclaw",
      env: commandEnv(sandboxName, { NVIDIA_API_KEY: apiKey }),
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
    if (environment.docker.expectation !== "missing") {
      throw new Error("cloud-openclaw-no-docker onboarding requires the docker-missing runtime expectation.");
    }
    const sandboxName = sandboxNameFromOptions(environment.onboarding, options);
    const apiKey = this.secrets.required("NVIDIA_API_KEY");
    this.registerSandboxCleanup(sandboxName);
    const shimDir = await mkdtemp(join(tmpdir(), "e2e-no-docker-"));
    const shimPath = join(shimDir, "docker");
    try {
      await writeFile(shimPath, noDockerShim(), "utf8");
      await chmod(shimPath, 0o700);
      const env = commandEnv(sandboxName, { NVIDIA_API_KEY: apiKey });
      env.PATH = prependPath(shimDir, env.PATH);
      const result = await this.host.nemoclaw(ONBOARD_ARGS, {
        artifactName: "onboard-cloud-openclaw-no-docker",
        env,
        redactionValues: [apiKey],
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      await this.writeNegativePreflightEvidence(result, [apiKey]);
      if (result.exitCode === 0) {
        throw new Error("cloud-openclaw-no-docker onboarding unexpectedly succeeded.");
      }
      if (!hasDockerMissingSignature(result)) {
        throw new Error(
          `cloud-openclaw-no-docker onboarding failed without Docker-missing preflight signature: ${resultText(result)}`,
        );
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

  private registerSandboxCleanup(sandboxName: string): void {
    if (!this.cleanup) return;
    this.cleanup.add(`destroy NemoClaw sandbox ${sandboxName}`, async () => {
      const result = await this.host.nemoclaw([sandboxName, "destroy", "--yes"], {
        artifactName: `cleanup-destroy-${artifactLabel(sandboxName)}`,
        env: buildAvailabilityProbeEnv(),
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      if (result.exitCode !== 0 && !hasMissingSandboxDeleteSignature(result)) {
        assertExitZero(result, `cleanup destroy sandbox ${sandboxName}`);
      }
    });
  }

  private redact(text: string, extraValues: string[] = []): string {
    return this.secrets.redact?.(text, extraValues) ?? redactString(redactExplicitValues(text, extraValues));
  }

  private async writeNegativePreflightEvidence(result: ShellProbeResult, redactionValues: string[]): Promise<void> {
    const logPath = legacyNegativePreflightLogPath();
    if (!logPath) return;
    await mkdir(dirname(logPath), { recursive: true });
    await writeFile(logPath, this.redact(resultText(result), redactionValues), "utf8");
  }
}
