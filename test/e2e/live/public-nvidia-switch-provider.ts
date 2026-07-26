// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

export const PUBLIC_NVIDIA_SWITCH_PROVIDER = "nvidia-prod";
export const PUBLIC_NVIDIA_SWITCH_MODEL = "nvidia/nemotron-3-super-120b-a12b";

export function requirePublicNvidiaSwitchKey(value: string): string {
  if (!/^nvapi-[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("NVIDIA_API_KEY must be a public NVIDIA Endpoints nvapi-* key");
  }
  return value;
}

export async function registerPublicNvidiaSwitchProvider(
  host: HostCliClient,
  apiKey: string,
  env: NodeJS.ProcessEnv,
): Promise<ShellProbeResult> {
  const {
    NVIDIA_API_KEY: _publicApiKey,
    NVIDIA_INFERENCE_API_KEY: _inferenceApiKey,
    ...providerEnv
  } = env;
  const script = [
    "set -euo pipefail",
    `if openshell provider get -g nemoclaw ${PUBLIC_NVIDIA_SWITCH_PROVIDER} >/dev/null 2>&1; then`,
    `  openshell provider update -g nemoclaw ${PUBLIC_NVIDIA_SWITCH_PROVIDER} --credential NVIDIA_INFERENCE_API_KEY`,
    "else",
    `  openshell provider create -g nemoclaw --name ${PUBLIC_NVIDIA_SWITCH_PROVIDER} --type nvidia --credential NVIDIA_INFERENCE_API_KEY`,
    "fi",
  ].join("\n");
  return host.command("bash", ["-lc", script], {
    artifactName: "register-public-nvidia-switch-provider",
    env: { ...providerEnv, NVIDIA_INFERENCE_API_KEY: apiKey },
    redactionValues: [apiKey],
    timeoutMs: 120_000,
  });
}
