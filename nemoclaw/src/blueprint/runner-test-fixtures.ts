// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function minimalBlueprint(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    version: "1.0",
    components: {
      inference: {
        profiles: {
          default: {
            provider_type: "openai",
            provider_name: "my-provider",
            endpoint: "https://api.example.com/v1",
            model: "gpt-4",
            credential_env: "MY_API_KEY",
          },
        },
      },
      sandbox: {
        image: "openclaw",
        name: "test-sandbox",
        forward_ports: [18789],
      },
      policy: { additions: {} },
    },
    ...overrides,
  };
}

export function routedBlueprint(): Record<string, unknown> {
  return {
    version: "1.0",
    components: {
      inference: {
        profiles: {
          routed: {
            provider_type: "openai",
            provider_name: "nvidia-router",
            endpoint: "http://localhost:4000/v1",
            model: "routed",
            credential_env: "NVIDIA_INFERENCE_API_KEY",
            credential_default: "router-local",
            timeout_secs: 180,
          },
        },
      },
      sandbox: {
        image: "openclaw",
        name: "test-sandbox",
        forward_ports: [18789],
      },
      router: {
        enabled: true,
        port: 4000,
        pool_config_path: "router/pool-config.yaml",
      },
      policy: { additions: {} },
    },
  };
}

export function blueprintWithPolicyAdditions(
  additions: Record<string, unknown>,
): Record<string, unknown> {
  const blueprint = minimalBlueprint();
  const components = blueprint.components as Record<string, unknown>;
  return {
    ...blueprint,
    components: {
      ...components,
      policy: { additions },
    },
  };
}

export function resultForCommandFailure(
  args: readonly string[],
  command: readonly [string, string],
  stderr: string,
): { exitCode: number; stdout: string; stderr: string } {
  return args[0] === command[0] && args[1] === command[1]
    ? { exitCode: 1, stdout: "", stderr }
    : { exitCode: 0, stdout: "", stderr: "" };
}
