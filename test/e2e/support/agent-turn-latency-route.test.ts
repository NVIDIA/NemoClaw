// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { customNativeProvider } from "../../../src/lib/inference/native-provider/custom.ts";
import {
  NVIDIA_HOSTED_NATIVE_ENDPOINT,
  NVIDIA_HOSTED_NATIVE_PROFILE_ID,
  NVIDIA_HOSTED_NATIVE_PROVIDER,
} from "../../../src/lib/inference/native-nvidia/contract.ts";
import { getSandbox } from "../../../src/lib/state/registry.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { route, type AgentTurnInference } from "../live/agent-turn-latency-helpers.ts";

vi.mock("../../../src/lib/state/registry.ts", () => ({ getSandbox: vi.fn() }));

const custom = customNativeProvider({
  provider: "compatible-endpoint",
  endpointUrl: "https://inference-api.nvidia.com/v1",
  api: "openai-completions",
  credentialEnv: "SOURCE_KEY",
  allowedIps: ["8.8.8.8"],
});
const providers = [
  {
    name: "compatible-endpoint",
    endpoint: custom.endpoint,
    key: custom.credentialEnv,
    receipt: {
      schemaVersion: 1 as const,
      profileId: custom.profileId,
      providerName: custom.providerName,
      providerId: "owned-provider",
      endpointUrl: custom.endpointUrl,
      allowedIps: custom.allowedIps,
      custom: custom.custom,
    },
  },
  {
    name: "nvidia-prod",
    endpoint: NVIDIA_HOSTED_NATIVE_ENDPOINT,
    key: "NVIDIA_INFERENCE_API_KEY",
    receipt: {
      schemaVersion: 1 as const,
      profileId: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
      providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
      providerId: "owned-provider",
    },
  },
];

const cases = ["openclaw", "hermes"].flatMap((agent) =>
  providers.map((provider) => ({ agent: agent as "openclaw" | "hermes", provider })),
);

it.each(cases)("observes the live $agent route for $provider.name", async ({ agent, provider }) => {
  const fixture = harness(agent, provider);
  await expect(fixture.read()).resolves.toEqual({
    provider: provider.name,
    model: "selected-model",
  });
  expect(fixture.openshell.mock.calls.map(([args]) => args)).toEqual([
    ["provider", "get", "-g", "recorded-gateway", provider.receipt.providerName],
    ["sandbox", "provider", "list", "-g", "recorded-gateway", "latency-sandbox"],
  ]);
  const options = [...fixture.openshell.mock.calls, ...fixture.exec.mock.calls].map((call) =>
    call.at(-1),
  );
  expect(options).toEqual(
    Array(3).fill(
      expect.objectContaining({
        timeoutMs: 30_000,
        redactionValues: ["host-secret"],
        env: expect.objectContaining({ OPENSHELL_GATEWAY: "recorded-gateway" }),
      }),
    ),
  );
  expect(JSON.stringify(options)).not.toContain('"COMPATIBLE_API_KEY":"host-secret"');
  expect(fixture.inference.env).not.toHaveBeenCalled();
  expect(fixture.projection()).not.toContain("config-secret");
});

it.each(
  cases.flatMap((item) =>
    [
      "provider-id",
      "profile",
      "credential",
      "config-key",
      "attachment",
      "provider-failed",
      "attachment-failed",
      "config-failed",
      "endpoint",
      "api",
      "agent-provider",
      "receipt",
    ].map((drift) => ({ ...item, drift })),
  ),
)("rejects $drift drift for $agent with $provider.name", async ({ agent, provider, drift }) => {
  await expect(harness(agent, provider, drift).read()).resolves.toBeNull();
});

it.each(cases)(
  "returns the observed $agent model instead of the requested model",
  async ({ agent, provider }) => {
    await expect(harness(agent, provider, "model").read()).resolves.toEqual({
      provider: provider.name,
      model: "different-model",
    });
  },
);

function harness(agent: "openclaw" | "hermes", provider: (typeof providers)[number], drift = "") {
  vi.mocked(getSandbox).mockReturnValue({
    name: "latency-sandbox",
    agent: agent === "openclaw" ? null : agent,
    gatewayName: "recorded-gateway",
    provider: provider.name,
    ...(drift === "receipt"
      ? {}
      : provider.name === "nvidia-prod"
        ? { nativeNvidiaProviderAttachment: provider.receipt }
        : { nativeHostedProviderAttachment: provider.receipt }),
  } as NonNullable<ReturnType<typeof getSandbox>>);
  const inference: AgentTurnInference = {
    mode: provider.name === "nvidia-prod" ? "public-nvidia" : "internal-nvidia",
    provider: provider.name === "nvidia-prod" ? "nvidia" : "custom",
    model: "selected-model",
    expectedRouteProvider: provider.name,
    env: vi.fn(() => ({ COMPATIBLE_API_KEY: "host-secret" })),
    redactionValues: () => ["host-secret"],
  };
  const openshell = vi
    .fn()
    .mockResolvedValueOnce({
      exitCode: drift === "provider-failed" ? 1 : 0,
      stdout: [
        `Name: ${provider.receipt.providerName}`,
        `Id: ${drift === "provider-id" ? "foreign-provider" : "owned-provider"}`,
        `Type: ${drift === "profile" ? "foreign-profile" : provider.receipt.profileId}`,
        "Resource version: 1",
        `Credential keys: ${drift === "credential" ? "WRONG_KEY" : provider.key}`,
        `Config keys: ${drift === "config-key" ? "BASE_URL" : "<none>"}`,
      ].join("\n"),
    })
    .mockResolvedValueOnce({
      exitCode: drift === "attachment-failed" ? 1 : 0,
      stdout: drift === "attachment" ? "another-provider" : provider.receipt.providerName,
    });
  const model = drift === "model" ? "different-model" : "selected-model";
  const endpoint = drift === "endpoint" ? "https://wrong.example/v1" : provider.endpoint;
  const config =
    agent === "openclaw"
      ? {
          agents: {
            defaults: {
              model: {
                primary: `${drift === "agent-provider" ? "foreign" : "inference"}/${model}`,
              },
            },
          },
          models: {
            providers: {
              inference: {
                baseUrl: endpoint,
                api: drift === "api" ? "openai-responses" : "openai-completions",
                apiKey: "config-secret",
              },
            },
          },
        }
      : {
          model: {
            default: model,
            provider: drift === "agent-provider" ? "foreign" : "custom",
            base_url: endpoint,
            api_key: "config-secret",
            ...(drift === "api" ? { api_mode: "codex_responses" } : {}),
          },
        };
  let projection = "";
  const exec = vi.fn(async (_name, command) => {
    const project = {
      openclaw: () => {
        runInNewContext(command[2], {
          require: () => ({ readFileSync: () => JSON.stringify(config) }),
          process: {
            argv: ["node", command[3]],
            stdout: {
              write: (value: string) => {
                projection = value;
              },
            },
          },
        });
      },
      hermes: () => {
        expect(command[0]).toBe("/opt/hermes/.venv/bin/python3");
        const result = spawnSync(
          "python3",
          [
            "-c",
            [
              "import builtins,io,json,sys,types",
              "config=json.loads(sys.stdin.read())",
              "builtins.open=lambda filename: io.StringIO(json.dumps(config))",
              "sys.modules['yaml']=types.SimpleNamespace(safe_load=json.load)",
              "exec(sys.argv[1])",
            ].join("\n"),
            command[2],
          ],
          { input: JSON.stringify(config), encoding: "utf8" },
        );
        expect(result.status, result.stderr).toBe(0);
        projection = result.stdout;
      },
    };
    project[agent]();
    return { exitCode: drift === "config-failed" ? 1 : 0, stdout: projection };
  });
  return {
    inference,
    openshell,
    exec,
    projection: () => projection,
    read: () =>
      route(
        { openshell, exec } as unknown as SandboxClient,
        "latency-sandbox",
        agent,
        inference,
        "latency-route",
      ),
  };
}
