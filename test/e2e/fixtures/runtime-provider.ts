// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { buildAvailabilityProbeEnv } from "./availability-env.ts";
import type { HostCliClient } from "./clients/host.ts";

export type RuntimeProviderSkip = (reason: string) => never;

export async function ensureConfiguredRuntimeProviderAvailable(options: {
  artifactName: string;
  environment?: NodeJS.ProcessEnv;
  host: HostCliClient;
  scenarioLabel: string;
  skip: RuntimeProviderSkip;
}): Promise<void> {
  const environment = options.environment ?? process.env;
  const portable = environment.NEMOCLAW_EXPERIMENTAL_PROFILE === "portable";
  const configured = environment.NEMOCLAW_GATEWAY_RUNTIME?.trim() || "docker";
  if (configured !== "docker" && configured !== "podman") {
    throw new Error(`unsupported E2E gateway runtime: ${configured}`);
  }

  const providerId = portable ? "docker" : configured;
  const providerDisplayName = providerId === "podman" ? "Podman" : "Docker";
  let command = "docker";
  let args = ["info"];
  if (providerId === "podman") {
    const socketPath = environment.OPENSHELL_PODMAN_SOCKET?.trim();
    if (
      !socketPath ||
      !path.isAbsolute(socketPath) ||
      path.normalize(socketPath) !== socketPath ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(socketPath)
    ) {
      throw new Error("native Podman E2E requires one absolute provider-owned socket path");
    }
    command = "podman";
    args = ["--url", `unix://${socketPath}`, "info"];
  }
  const result = await options.host.command(command, args, {
    artifactName: options.artifactName,
    env: buildAvailabilityProbeEnv(environment),
    timeoutMs: 30_000,
  });
  if (result.exitCode === 0) return;

  const detail = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const reason = `${providerDisplayName} is required for ${options.scenarioLabel} live E2E: ${detail}`;
  if (process.env.GITHUB_ACTIONS === "true") throw new Error(reason);
  options.skip(reason);
}
