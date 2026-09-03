// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { isTransientProviderValidationFailure } from "./network-policy-transient-provider.ts";

export type SkipFn = (reason: string) => never;

export function liveOnboardAttempts(): number {
  return process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true" ? 3 : 1;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureDockerAvailable(opts: {
  host: HostCliClient;
  artifactName: string;
  skip: SkipFn;
  scenarioLabel: string;
}): Promise<void> {
  const docker = await opts.host.command("docker", ["info"], {
    artifactName: opts.artifactName,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  if (docker.exitCode === 0) return;
  const text = [docker.stdout, docker.stderr].filter(Boolean).join("\n");
  if (process.env.GITHUB_ACTIONS === "true") {
    throw new Error(`Docker is required for ${opts.scenarioLabel} live E2E: ${text}`);
  }
  opts.skip(`Docker is required for ${opts.scenarioLabel} live E2E`);
}

export type RestrictedOnboardOptions = {
  host: HostCliClient;
  artifacts: ArtifactSink;
  skip: SkipFn;
  sandboxName: string;
  apiKey: string;
  scenarioLabel: string;
  scenarioSlug: string;
  preCleanupArtifactPrefix: string;
  onboardArtifactPrefix: string;
  extraOnboardEnv?: Record<string, string | undefined>;
  onboardTimeoutMs: number;
  preCleanupTimeoutMs: number;
  runNemoclaw: (
    host: HostCliClient,
    args: string[],
    options: {
      artifactName: string;
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
      redactionValues?: string[];
    },
  ) => Promise<ShellProbeResult>;
  baseEnv: (extra?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
};

async function transientSkipArtifact(opts: {
  artifacts: ArtifactSink;
  attempts: number;
}): Promise<void> {
  await opts.artifacts.writeJson("transient-provider-validation.skip.json", {
    reason: "transient NVIDIA Endpoints validation failure after retries",
    attempts: opts.attempts,
    sourceBoundary: "external NVIDIA Endpoints provider availability",
    removalCondition:
      "remove once CI endpoint validation is stable for a release cycle or covered by a hermetic provider-validation fixture",
  });
}

async function attemptRestrictedOnboardOnce(
  options: RestrictedOnboardOptions,
  attempt: number,
): Promise<ShellProbeResult> {
  if (attempt > 1) {
    await options.runNemoclaw(options.host, [options.sandboxName, "destroy", "--yes"], {
      artifactName: `${options.preCleanupArtifactPrefix}-attempt-${attempt}`,
      env: options.baseEnv(),
      timeoutMs: options.preCleanupTimeoutMs,
    });
  }
  const onboardEnv = options.baseEnv({
    NVIDIA_INFERENCE_API_KEY: options.apiKey,
    NEMOCLAW_SANDBOX_NAME: options.sandboxName,
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_POLICY_TIER: "restricted",
    ...(options.extraOnboardEnv ?? {}),
  });
  const artifactName =
    attempt === 1
      ? options.onboardArtifactPrefix
      : `${options.onboardArtifactPrefix}-attempt-${attempt}`;
  return options.runNemoclaw(
    options.host,
    ["onboard", "--non-interactive", "--yes-i-accept-third-party-software"],
    {
      artifactName,
      env: onboardEnv,
      redactionValues: [options.apiKey],
      timeoutMs: options.onboardTimeoutMs,
    },
  );
}

export async function runRestrictedOnboardWithRetry(
  options: RestrictedOnboardOptions,
): Promise<ShellProbeResult> {
  const attempts = liveOnboardAttempts();
  let lastResult: ShellProbeResult | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await attemptRestrictedOnboardOnce(options, attempt);
    lastResult = result;
    if (result.exitCode === 0) return result;
    const transient = isTransientProviderValidationFailure(result);
    if (transient && attempt < attempts) {
      await sleep(10_000 * attempt);
      continue;
    }
    if (transient && process.env.GITHUB_ACTIONS === "true") {
      await transientSkipArtifact({ artifacts: options.artifacts, attempts });
      options.skip(
        `NVIDIA Endpoints validation hit a transient upstream/rate-limit failure after ${attempts} attempts`,
      );
    }
    return result;
  }
  return lastResult as ShellProbeResult;
}
