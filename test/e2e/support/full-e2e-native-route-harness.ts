// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { customNativeProvider } from "../../../src/lib/inference/native-provider/custom.ts";
import { applyHermesManagedRoute } from "../../../src/lib/hermes-managed-route.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import type { readFullE2eInferenceRoute } from "../live/full-e2e-inference-probe.ts";

export function nativeRouteHarness(
  agent: "openclaw" | "hermes",
  observedId = "owned-id",
  drift = "none",
) {
  const definition = customNativeProvider({
    provider: "compatible-endpoint",
    endpointUrl: "https://custom.example/v1",
    api: "openai-completions",
    credentialEnv: "SOURCE_KEY",
    allowedIps: ["8.8.8.8"],
  });
  const openshell = vi
    .fn()
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: [
        `Name: ${definition.providerName}`,
        `Id: ${observedId}`,
        `Type: ${definition.profileId}`,
        "Resource version: 1",
        "Credential keys: COMPATIBLE_API_KEY",
        "Config keys: <none>",
      ].join("\n"),
    })
    .mockResolvedValueOnce({ exitCode: 0, stdout: definition.providerName });
  const handle = "openshell:resolve:env:v3_COMPATIBLE_API_KEY";
  const config = {
    agents: {
      defaults: {
        model: { primary: drift === "model" ? "inference/other" : "inference/selected-model" },
      },
    },
    models: {
      providers: {
        inference: {
          baseUrl: drift === "endpoint" ? "https://wrong.example/v1" : definition.endpoint,
          api: drift === "api" ? "openai-responses" : definition.api,
          apiKey: drift === "credential" ? "raw-secret" : handle,
          models: [{ id: "selected-model" }],
        },
      },
    },
  };
  const hermesConfig: Record<string, unknown> = {};
  applyHermesManagedRoute(hermesConfig, {
    model: drift === "model" ? "other-model" : "selected-model",
    upstreamProvider: definition.logicalProvider,
    baseUrl: drift === "endpoint" ? "https://wrong.example/v1" : definition.endpoint,
    inferenceApi: drift === "api" ? "openai-responses" : definition.api,
  });
  if (drift === "credential") {
    (hermesConfig.model as Record<string, unknown>).api_key = "raw-secret";
  }
  const exec = vi.fn(async (_name, command) => {
    if (agent === "hermes") {
      // Exercise the sandbox Python predicate with synthetic file and loader boundaries.
      // The image build separately tests the pinned Hermes environment expansion loader.
      const harness = `
import builtins, io, json, os, sys, types
fixture = json.loads(sys.argv[1])
builtins.open = lambda *args, **kwargs: io.StringIO(json.dumps(fixture))
sys.modules['yaml'] = types.SimpleNamespace(safe_load=lambda stream: json.load(stream))
def expand(value):
    if isinstance(value, dict): return {key: expand(item) for key, item in value.items()}
    if isinstance(value, list): return [expand(item) for item in value]
    if isinstance(value, str): return os.path.expandvars(value)
    return value
sys.modules['hermes_cli'] = types.ModuleType('hermes_cli')
sys.modules['hermes_cli.config'] = types.SimpleNamespace(_expand_env_vars=expand)
script, expected = sys.argv[2:4]
sys.argv = ['-c', expected]
exec(script)
`;
      const result = spawnSync(
        "python3",
        ["-I", "-c", harness, JSON.stringify(hermesConfig), command[3], command[4]],
        {
          env: { PATH: process.env.PATH, COMPATIBLE_API_KEY: handle },
          encoding: "utf8",
        },
      );
      return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
    }
    let stdout = "";
    try {
      runInNewContext(command[2], {
        require: (name: string) =>
          name === "node:fs" ? { readFileSync: () => JSON.stringify(config) } : assert,
        process: {
          argv: ["node", command[3]],
          env: { COMPATIBLE_API_KEY: handle },
          stdout: {
            write: (value: string) => {
              stdout += value;
            },
          },
        },
      });
      return { exitCode: 0, stdout };
    } catch {
      return { exitCode: 1, stdout };
    }
  });

  const input: Parameters<typeof readFullE2eInferenceRoute>[0] = {
    sandbox: { openshell, exec } as unknown as SandboxClient,
    sandboxName: "alpha",
    agent,
    preferredApi: "openai-completions",
    logicalProvider: definition.logicalProvider,
    endpointUrl: definition.endpointUrl,
    model: "selected-model",
    env: {},
    redactionValues: ["synthetic-key"],
    entry: {
      name: "alpha",
      gatewayName: "recorded-gateway",
      nativeHostedProviderAttachment: {
        schemaVersion: 1,
        profileId: definition.profileId,
        providerName: definition.providerName,
        providerId: "owned-id",
        endpointUrl: definition.endpointUrl,
        allowedIps: definition.allowedIps,
        custom: definition.custom,
      },
    },
  };
  return { definition, openshell, exec, input };
}
