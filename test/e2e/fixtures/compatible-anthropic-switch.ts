// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HostCliClient } from "./clients/host.ts";
import { resultText } from "./clients/index.ts";

export const COMPATIBLE_ANTHROPIC_PROVIDER = "compatible-anthropic-endpoint";
export const COMPATIBLE_ANTHROPIC_CREDENTIAL_ENV = "COMPATIBLE_ANTHROPIC_API_KEY";
const DEFAULT_COMPATIBLE_ANTHROPIC_CREDENTIAL = "test-compatible-anthropic-key";

export interface CompatibleAnthropicSwitchBinding {
  endpointUrl: string;
  credentialValue: string;
}

export function compatibleAnthropicSwitchBinding(
  endpointUrl: string,
  runtimeEnv: NodeJS.ProcessEnv = process.env,
): CompatibleAnthropicSwitchBinding {
  const normalizedEndpointUrl = endpointUrl.trim();
  if (!normalizedEndpointUrl) {
    throw new Error(
      "NEMOCLAW_SWITCH_ENDPOINT_URL is required for compatible Anthropic inference switches",
    );
  }
  const credentialValue =
    runtimeEnv[COMPATIBLE_ANTHROPIC_CREDENTIAL_ENV] ?? DEFAULT_COMPATIBLE_ANTHROPIC_CREDENTIAL;
  if (!credentialValue.trim()) {
    throw new Error(
      "COMPATIBLE_ANTHROPIC_API_KEY is required for compatible Anthropic inference switches",
    );
  }
  return { endpointUrl: normalizedEndpointUrl, credentialValue };
}

export function compatibleAnthropicSwitchEnv(
  binding: CompatibleAnthropicSwitchBinding | null,
): NodeJS.ProcessEnv {
  return binding ? { [COMPATIBLE_ANTHROPIC_CREDENTIAL_ENV]: binding.credentialValue } : {};
}

export async function requireCompatibleAnthropicProviderAbsent(
  host: HostCliClient,
  options: {
    artifactName: string;
    env: NodeJS.ProcessEnv;
    gatewayName?: string;
  },
): Promise<void> {
  const gatewayName = options.gatewayName ?? "nemoclaw";
  const result = await host.command(
    "openshell",
    ["provider", "get", "-g", gatewayName, COMPATIBLE_ANTHROPIC_PROVIDER],
    {
      artifactName: options.artifactName,
      env: options.env,
      timeoutMs: 30_000,
    },
  );
  const output = resultText(result);
  if (result.exitCode === 0) {
    throw new Error(
      `Provider '${COMPATIBLE_ANTHROPIC_PROVIDER}' must be absent before this inference switch so NemoClaw can create and verify its rollback-safe binding.`,
    );
  }
  if (!/provider not found|requested entity was not found/iu.test(output)) {
    throw new Error(
      `Could not prove provider '${COMPATIBLE_ANTHROPIC_PROVIDER}' is absent: ${output}`,
    );
  }
}
