// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureHttpsPinRuntimeAdapter as realEnsureHttpsPinRuntimeAdapter } from "../inference/https-pin-runtime-adapter";
import type { ConfigObject } from "../security/credential-filter";
import { runInferenceSet } from "./inference-set";
import {
  baseSession,
  createCompatibleProviderCapture,
  createDeps,
} from "./inference-set.test-support";

type ProbeSandboxRoute = NonNullable<
  Parameters<typeof createDeps>[0]["probeSandboxRoute"]
>;

const OPENAI_PROFILE_OUTPUT = JSON.stringify({
  id: "openai",
  credentials: [],
  endpoints: [],
  binaries: [],
  inference_capable: true,
});
const OPENAI_PROFILE_RESULT = {
  status: 0,
  output: OPENAI_PROFILE_OUTPUT,
  stdout: OPENAI_PROFILE_OUTPUT,
  stderr: "",
};

async function runRejectedCompatibleSwitchScenario(options: {
  targetFamily: "openai" | "anthropic";
  probeSandboxRoute: ProbeSandboxRoute;
  expectedError: RegExp;
}) {
  const target =
    options.targetFamily === "anthropic"
      ? {
          provider: "compatible-anthropic-endpoint",
          model: "mock-anthropic-model",
          credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
          inferenceApi: "anthropic-messages" as const,
          captureType: "anthropic" as const,
          configKey: "ANTHROPIC_BASE_URL" as const,
        }
      : {
          provider: "compatible-endpoint",
          model: "mock-model",
          credentialEnv: "COMPATIBLE_API_KEY",
          inferenceApi: "openai-completions" as const,
          captureType: "openai" as const,
          configKey: "OPENAI_BASE_URL" as const,
        };
  const captureOpenshell = createCompatibleProviderCapture({
    name: target.provider,
    type: target.captureType,
    credentialEnv: target.credentialEnv,
    configKey: target.configKey,
    initiallyPresent: false,
  });
  const probeSandboxRoute = vi.fn(options.probeSandboxRoute);
  const deps = createDeps({
    config: {
      agents: { defaults: { model: { primary: "inference/old-model" } } },
      models: { providers: { inference: { api: "openai-completions", models: [] } } },
    },
    entry: {
      name: "alpha",
      agent: "openclaw",
      provider: "nvidia-prod",
      model: "old-model",
    },
    session: baseSession({ provider: "nvidia-prod", model: "old-model" }),
    captureOpenshell,
    probeSandboxRoute,
  });

  await expect(
    runInferenceSet(
      {
        provider: target.provider,
        model: target.model,
        endpointUrl: "http://host.openshell.internal:18767/",
        credentialEnv: target.credentialEnv,
        inferenceApi: target.inferenceApi,
      },
      deps,
    ),
  ).rejects.toThrow(options.expectedError);

  expect(
    captureOpenshell.mock.calls
      .filter(([args]) => args[0] === "inference" && args[1] === "set")
      .map(([args]) => args),
  ).toEqual([
    [
      "inference",
      "set",
      "-g",
      "nemoclaw",
      "--provider",
      target.provider,
      "--model",
      target.model,
      "--no-verify",
    ],
    [
      "inference",
      "set",
      "-g",
      "nemoclaw",
      "--provider",
      "nvidia-prod",
      "--model",
      "old-model",
      "--no-verify",
    ],
  ]);
  expect(
    captureOpenshell.mock.calls
      .filter(([args]) => args[0] === "provider" && args[1] === "delete")
      .map(([args]) => args),
  ).toEqual([["provider", "delete", "-g", "nemoclaw", target.provider]]);
  expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
  expect(deps.calls.updateSession).not.toHaveBeenCalled();
  expect(deps.getSession()).toMatchObject({ provider: "nvidia-prod", model: "old-model" });

  return { deps, probeSandboxRoute };
}

describe("runInferenceSet compatible providers", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reuses durable endpoint metadata for same-provider model switches", async () => {
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } },
      models: { providers: { inference: { api: "openai-completions", models: [] } } },
    };
    const deps = createDeps({
      config,
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-endpoint",
        model: "nvidia/model-a",
        endpointUrl: "https://inference-api.nvidia.com/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
      },
      session: baseSession({
        provider: "compatible-endpoint",
        model: "nvidia/model-a",
        endpointUrl: "https://inference-api.nvidia.com/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
      }),
    });

    await runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "nvidia/model-b",
        noVerify: true,
      },
      deps,
    );

    expect(deps.calls.rewriteConfigUrlsWithDnsPinning).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox.mock.calls.at(-1)).toEqual([
      "alpha",
      expect.objectContaining({
        provider: "compatible-endpoint",
        model: "nvidia/model-b",
        endpointUrl: "https://inference-api.nvidia.com/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
      }),
    ]);
  });

  it("rejects custom-compatible provider switches without trusted endpoint metadata", async () => {
    const deps = createDeps({
      config: { agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } } },
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "nvidia-prod",
        model: "nvidia/model-a",
      },
      session: baseSession({
        provider: "nvidia-prod",
        model: "nvidia/model-a",
        endpointUrl: "https://integrate.api.nvidia.com/v1",
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      }),
    });

    await expect(
      runInferenceSet(
        { provider: "compatible-endpoint", model: "openai/gpt-5.4-mini", noVerify: true },
        deps,
      ),
    ).rejects.toThrow(/without trusted durable endpoint metadata/);

    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("reuses registered compatible endpoint metadata when only the model changes", async () => {
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } },
      models: { providers: { inference: { api: "openai-completions", models: [] } } },
    };
    const deps = createDeps({
      config,
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-endpoint",
        model: "nvidia/model-a",
        endpointUrl: "https://inference-api.nvidia.com/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
      },
      session: baseSession({
        provider: "compatible-endpoint",
        model: "nvidia/model-a",
        endpointUrl: "https://inference-api.nvidia.com/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
      }),
      rewriteConfigUrlsWithDnsPinning: async () => {
        throw new Error("registered compatible endpoint metadata should not be revalidated");
      },
    });

    await runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "nvidia/nvidia/nemotron-3-super-v3",
        noVerify: true,
      },
      deps,
    );

    expect(deps.calls.rewriteConfigUrlsWithDnsPinning).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox.mock.calls.at(-1)).toEqual([
      "alpha",
      expect.objectContaining({
        provider: "compatible-endpoint",
        model: "nvidia/nvidia/nemotron-3-super-v3",
        endpointUrl: "https://inference-api.nvidia.com/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
      }),
    ]);
    expect(deps.getSession()).toMatchObject({
      provider: "compatible-endpoint",
      model: "nvidia/nvidia/nemotron-3-super-v3",
      endpointUrl: "https://inference-api.nvidia.com/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-completions",
    });
  });

  it("rejects Anthropic Messages metadata for OpenAI-compatible endpoint switches", async () => {
    const deps = createDeps({
      config: { agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } } },
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "nvidia-prod",
        model: "nvidia/model-a",
      },
      session: baseSession({
        provider: "nvidia-prod",
        model: "nvidia/model-a",
        endpointUrl: "https://integrate.api.nvidia.com/v1",
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      }),
    });

    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "mock-openai-model",
          noVerify: true,
          endpointUrl: "https://compatible.example/v1",
          credentialEnv: "COMPATIBLE_API_KEY",
          inferenceApi: "anthropic-messages",
        },
        deps,
      ),
    ).rejects.toThrow(
      /inference-api for 'compatible-endpoint' must be one of: openai-completions, openai-responses/,
    );

    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it.each([
    ["an HTTPS IP-literal", "https://198.51.100.10/v1", "https://198.51.100.10/v1"],
    ["a DNS-pinned HTTP", "http://compatible.example/v1", "http://198.51.100.10/v1"],
  ])("creates an absent direct compatible provider for %s endpoint (#7725)", async (_kind, endpointUrl, validatedEndpointUrl) => {
    let providerCreated = false;
    const captureOpenshell = vi.fn((args: string[]) => {
      switch (`${args[0]}:${args[1]}`) {
        case "provider:profile":
          return OPENAI_PROFILE_RESULT;
        case "inference:set":
          return providerCreated
            ? { status: 0, output: "", stdout: "", stderr: "" }
            : {
                status: 1,
                output: "Error: provider 'compatible-endpoint' not found",
                stdout: "",
                stderr: "Error: provider 'compatible-endpoint' not found",
              };
        case "provider:get": {
          const output = [
            "Name: compatible-endpoint",
            "Id: 11111111-2222-4333-8444-555555555555",
            "Type: openai",
            "Resource version: 1",
            "Credential keys: COMPATIBLE_API_KEY",
            "Config keys: OPENAI_BASE_URL",
          ].join("\n");
          return providerCreated
            ? { status: 0, output, stdout: output, stderr: "" }
            : {
                status: 1,
                output:
                  "Error: code: 'Some requested entity was not found', message: \"provider not found\"",
                stdout: "",
                stderr:
                  "Error: code: 'Some requested entity was not found', message: \"provider not found\"",
              };
        }
        case "provider:create":
          providerCreated = true;
          return { status: 0, output: "", stdout: "", stderr: "" };
        default:
          return { status: 0, output: "", stdout: "", stderr: "" };
      }
    });
    const deps = createDeps({
      config: { agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } } },
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "nvidia-prod",
        model: "nvidia/model-a",
      },
      session: baseSession({
        provider: "nvidia-prod",
        model: "nvidia/model-a",
      }),
      captureOpenshell,
      rewriteConfigUrlsWithDnsPinning: async () => validatedEndpointUrl,
      resolveCredentialValue: () => "real-upstream-secret",
    });

    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "mock-model",
          endpointUrl,
          credentialEnv: "COMPATIBLE_API_KEY",
          inferenceApi: "openai-completions",
        },
        deps,
      ),
    ).resolves.toMatchObject({
      sandboxName: "alpha",
      provider: "compatible-endpoint",
      model: "mock-model",
    });

    const providerCreateIndex = captureOpenshell.mock.calls.findIndex(
      ([args]) => args[0] === "provider" && args[1] === "create",
    );
    const successfulSetIndex = captureOpenshell.mock.calls.findIndex(
      ([args], index) =>
        index > providerCreateIndex && args[0] === "inference" && args[1] === "set",
    );
    expect(providerCreateIndex).toBeGreaterThanOrEqual(0);
    expect(successfulSetIndex).toBeGreaterThan(providerCreateIndex);
    expect(captureOpenshell.mock.calls[successfulSetIndex][0]).not.toContain("--no-verify");
    expect(captureOpenshell.mock.calls[providerCreateIndex]).toEqual([
      [
        "provider",
        "create",
        "-g",
        "nemoclaw",
        "--name",
        "compatible-endpoint",
        "--type",
        "openai",
        "--credential",
        "COMPATIBLE_API_KEY",
        "--config",
        `OPENAI_BASE_URL=${validatedEndpointUrl}`,
      ],
      expect.objectContaining({
        env: { COMPATIBLE_API_KEY: "real-upstream-secret" },
      }),
    ]);
    expect(deps.calls.updateSandbox.mock.calls.at(-1)).toEqual([
      "alpha",
      expect.objectContaining({
        provider: "compatible-endpoint",
        endpointUrl: validatedEndpointUrl,
      }),
    ]);
  });

  it("removes an absent direct provider when verified route selection fails (#7725)", async () => {
    let providerPresent = false;
    const captureOpenshell = vi.fn((args: string[]) => {
      switch (`${args[0]}:${args[1]}`) {
        case "provider:profile":
          return OPENAI_PROFILE_RESULT;
        case "provider:get": {
          const missingOutput =
            "Error: code: 'Some requested entity was not found', message: \"provider not found\"";
          const presentOutput = [
            "Name: compatible-endpoint",
            "Id: 11111111-2222-4333-8444-555555555555",
            "Type: openai",
            "Resource version: 1",
            "Credential keys: COMPATIBLE_API_KEY",
            "Config keys: OPENAI_BASE_URL",
          ].join("\n");
          return providerPresent
            ? { status: 0, output: presentOutput, stdout: presentOutput, stderr: "" }
            : { status: 1, output: missingOutput, stdout: "", stderr: missingOutput };
        }
        case "provider:create":
          providerPresent = true;
          return { status: 0, output: "", stdout: "", stderr: "" };
        case "provider:delete":
          providerPresent = false;
          return { status: 0, output: "", stdout: "", stderr: "" };
        case "inference:set":
          return {
            status: 1,
            output: "requested endpoint is unreachable",
            stdout: "",
            stderr: "requested endpoint is unreachable",
          };
        default:
          return { status: 0, output: "", stdout: "", stderr: "" };
      }
    });
    const deps = createDeps({
      config: { agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } } },
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "nvidia-prod",
        model: "nvidia/model-a",
      },
      session: baseSession({
        provider: "nvidia-prod",
        model: "nvidia/model-a",
      }),
      captureOpenshell,
      rewriteConfigUrlsWithDnsPinning: async () => "http://198.51.100.10/v1",
      resolveCredentialValue: () => "real-upstream-secret",
    });

    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "mock-model",
          endpointUrl: "http://compatible.example/v1",
          credentialEnv: "COMPATIBLE_API_KEY",
          inferenceApi: "openai-completions",
        },
        deps,
      ),
    ).rejects.toThrow(/newly created OpenShell provider was removed/);
    expect(providerPresent).toBe(false);
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
  });

  it.each([
    {
      bindingPart: "endpoint URL",
      recordedEndpointUrl: "http://198.51.100.9/v1",
      recordedCredentialEnv: "COMPATIBLE_API_KEY",
    },
    {
      bindingPart: "credential environment variable",
      recordedEndpointUrl: "http://198.51.100.10/v1",
      recordedCredentialEnv: "LEGACY_COMPATIBLE_API_KEY",
    },
  ])("rejects $bindingPart replacement for an existing direct provider (#7725)", async ({
    bindingPart,
    recordedEndpointUrl,
    recordedCredentialEnv,
  }) => {
    const captureOpenshell = createCompatibleProviderCapture({
      name: "compatible-endpoint",
      type: "openai",
      credentialEnv: "COMPATIBLE_API_KEY",
      configKey: "OPENAI_BASE_URL",
    });
    const deps = createDeps({
      config: { agents: { defaults: { model: { primary: "inference/old-model" } } } },
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-endpoint",
        model: "old-model",
        endpointUrl: recordedEndpointUrl,
        endpointSource: "inference-set",
        credentialEnv: recordedCredentialEnv,
        preferredInferenceApi: "openai-completions",
      },
      session: baseSession({
        provider: "compatible-endpoint",
        model: "old-model",
        endpointUrl: recordedEndpointUrl,
        credentialEnv: recordedCredentialEnv,
        preferredInferenceApi: "openai-completions",
      }),
      captureOpenshell,
      rewriteConfigUrlsWithDnsPinning: async () => "http://198.51.100.10/v1",
      resolveCredentialValue: () => "replacement-upstream-secret",
    });

    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "new-model",
          endpointUrl: "http://compatible.example/v1",
          credentialEnv: "COMPATIBLE_API_KEY",
          inferenceApi: "openai-completions",
        },
        deps,
      ),
    ).rejects.toThrow(
      new RegExp(`Cannot replace existing provider.*binding differs in: ${bindingPart}`),
    );
    expect(
      captureOpenshell.mock.calls.some(
        ([args]) =>
          (args[0] === "inference" && args[1] === "set") ||
          (args[0] === "provider" && args[1] === "update"),
      ),
    ).toBe(false);
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
  });

  it("reuses an existing direct provider when its recorded endpoint matches", async () => {
    const captureOpenshell = createCompatibleProviderCapture({
      name: "compatible-endpoint",
      type: "openai",
      credentialEnv: "COMPATIBLE_API_KEY",
      configKey: "OPENAI_BASE_URL",
    });
    const deps = createDeps({
      config: { agents: { defaults: { model: { primary: "inference/old-model" } } } },
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-endpoint",
        model: "old-model",
        endpointUrl: "http://198.51.100.10/v1",
        endpointSource: "inference-set",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
      },
      session: baseSession({
        provider: "compatible-endpoint",
        model: "old-model",
        endpointUrl: "http://198.51.100.10/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
      }),
      captureOpenshell,
      rewriteConfigUrlsWithDnsPinning: async () => "http://198.51.100.10/v1",
      resolveCredentialValue: () => "replacement-upstream-secret",
    });

    await runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "new-model",
        endpointUrl: "http://compatible.example/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        inferenceApi: "openai-completions",
      },
      deps,
    );

    const inferenceSetCall = captureOpenshell.mock.calls.find(
      ([args]) => args[0] === "inference" && args[1] === "set",
    );
    expect(inferenceSetCall?.[0]).not.toContain("--no-verify");
    expect(
      captureOpenshell.mock.calls.some(([args]) => args[0] === "provider" && args[1] === "update"),
    ).toBe(false);
  });

  it("preserves explicit inference API through the final registry and session sync", async () => {
    let providerVersion = 1;
    const captureOpenshell = vi.fn((args: string[]) => {
      switch (`${args[0]}:${args[1]}`) {
        case "provider:profile":
          return OPENAI_PROFILE_RESULT;
        case "provider:get": {
          const output = [
            "Name: compatible-endpoint",
            "Id: 11111111-2222-4333-8444-555555555555",
            "Type: openai",
            `Resource version: ${providerVersion}`,
            "Credential keys: COMPATIBLE_API_KEY",
            "Config keys: OPENAI_BASE_URL",
          ].join("\n");
          return { status: 0, output, stdout: output, stderr: "" };
        }
        case "provider:update":
          providerVersion += 1;
          return { status: 0, output: "", stdout: "", stderr: "" };
        default:
          return { status: 0, output: "", stdout: "", stderr: "" };
      }
    });
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } },
      models: { providers: { inference: { api: "openai-completions", models: [] } } },
    };
    const deps = createDeps({
      config,
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "nvidia-prod",
        model: "nvidia/model-a",
      },
      session: baseSession({
        provider: "nvidia-prod",
        model: "nvidia/model-a",
        endpointUrl: "https://integrate.api.nvidia.com/v1",
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
        preferredInferenceApi: "openai-completions",
      }),
      captureOpenshell,
    });

    await runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "mock-responses-model",
        noVerify: true,
        endpointUrl: "https://compatible.example/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        inferenceApi: "openai-responses",
      },
      deps,
    );

    expect(config.models).toMatchObject({
      providers: {
        inference: {
          api: "openai-responses",
          headers: {
            "X-NemoClaw-Upstream-Provider": "compatible-endpoint",
          },
          models: [{ id: "mock-responses-model", name: "inference/mock-responses-model" }],
        },
      },
    });
    // The DNS-backed HTTPS endpoint is pinned via the HTTPS-pin runtime
    // adapter, so the persisted endpointUrl is the adapter's local route base
    // URL, not the raw operator-supplied hostname — mirroring the existing
    // HTTP precedent of persisting the validated/pinned address. The
    // The canonical provider key stays stable while its invocation-local
    // value is replaced by the route-scoped adapter token.
    expect(deps.calls.updateSandbox.mock.calls.at(-1)).toEqual([
      "alpha",
      expect.objectContaining({
        provider: "compatible-endpoint",
        model: "mock-responses-model",
        endpointUrl: "http://host.openshell.internal:11438/route/test-route",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-responses",
      }),
    ]);
    expect(deps.getSession()).toMatchObject({
      provider: "compatible-endpoint",
      model: "mock-responses-model",
      endpointUrl: "http://host.openshell.internal:11438/route/test-route",
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-responses",
    });
    expect(deps.calls.restartSandboxGateway).toHaveBeenCalledWith("alpha");
  });

  it("accepts explicit compatible Anthropic endpoint metadata for provider-family switches", async () => {
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } },
      models: { providers: { inference: { api: "openai-completions", models: [] } } },
    };
    const captureOpenshell = createCompatibleProviderCapture({
      name: "compatible-anthropic-endpoint",
      type: "anthropic",
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      configKey: "ANTHROPIC_BASE_URL",
      initiallyPresent: false,
    });
    const deps = createDeps({
      config,
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "nvidia-prod",
        model: "nvidia/model-a",
      },
      session: baseSession({
        provider: "nvidia-prod",
        model: "nvidia/model-a",
        endpointUrl: "https://integrate.api.nvidia.com/v1",
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      }),
      captureOpenshell,
    });

    await runInferenceSet(
      {
        provider: "compatible-anthropic-endpoint",
        model: "mock-anthropic-model",
        endpointUrl: "http://host.openshell.internal:18767/",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        inferenceApi: "anthropic-messages",
      },
      deps,
    );

    expect(deps.calls.updateSandbox.mock.calls.at(-1)).toEqual([
      "alpha",
      expect.objectContaining({
        provider: "compatible-anthropic-endpoint",
        model: "mock-anthropic-model",
        endpointUrl: "http://host.openshell.internal:18767",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        preferredInferenceApi: "anthropic-messages",
        nimContainer: null,
      }),
    ]);
    expect(deps.getSession()).toMatchObject({
      provider: "compatible-anthropic-endpoint",
      model: "mock-anthropic-model",
      endpointUrl: "http://host.openshell.internal:18767",
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      preferredInferenceApi: "anthropic-messages",
      nimContainer: null,
    });
    expect(deps.calls.rewriteConfigUrlsWithDnsPinning).not.toHaveBeenCalled();
    expect(captureOpenshell).toHaveBeenCalledWith(
      [
        "inference",
        "set",
        "-g",
        "nemoclaw",
        "--provider",
        "compatible-anthropic-endpoint",
        "--model",
        "mock-anthropic-model",
        "--no-verify",
      ],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(deps.calls.probeSandboxRoute).toHaveBeenCalledWith({
      sandboxName: "alpha",
      provider: "compatible-anthropic-endpoint",
      model: "mock-anthropic-model",
      preferredInferenceApi: "anthropic-messages",
    });
    expect(deps.calls.probeSandboxRoute.mock.invocationCallOrder[0]).toBeLessThan(
      deps.calls.updateSandbox.mock.invocationCallOrder[0],
    );
    expect(deps.calls.sleep).toHaveBeenCalledWith(6_000);
  });

  it("waits for a changed API family to replace the previous sandbox route (#9467)", async () => {
    const captureOpenshell = createCompatibleProviderCapture({
      name: "compatible-anthropic-endpoint",
      type: "anthropic",
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      configKey: "ANTHROPIC_BASE_URL",
      initiallyPresent: false,
    });
    const probeSandboxRoute = vi
      .fn()
      .mockReturnValueOnce({
        ok: false,
        detail: "sandbox inference invocation probe returned HTTP 400",
        httpStatus: 400,
      })
      .mockReturnValueOnce({ ok: true });
    const deps = createDeps({
      config: {
        agents: { defaults: { model: { primary: "inference/old-model" } } },
        models: { providers: { inference: { api: "openai-completions", models: [] } } },
      },
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-endpoint",
        model: "old-model",
      },
      session: baseSession({
        provider: "compatible-endpoint",
        model: "old-model",
        preferredInferenceApi: "openai-completions",
      }),
      captureOpenshell,
      probeSandboxRoute,
    });

    await runInferenceSet(
      {
        provider: "compatible-anthropic-endpoint",
        model: "mock-anthropic-model",
        endpointUrl: "http://host.openshell.internal:18767/",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        inferenceApi: "anthropic-messages",
      },
      deps,
    );

    expect(probeSandboxRoute).toHaveBeenCalledTimes(2);
    expect(deps.calls.sleep.mock.calls).toEqual([[6_000], [2_000]]);
    expect(deps.calls.log).toHaveBeenCalledWith(
      "  Waiting 2s for OpenShell route convergence after HTTP 400 (probe 1/3)...",
    );
    expect(deps.calls.updateSandbox).toHaveBeenCalled();
  });

  it("restores the prior route after changed-family convergence retries are exhausted (#9467)", async () => {
    const { deps, probeSandboxRoute } = await runRejectedCompatibleSwitchScenario({
      targetFamily: "anthropic",
      probeSandboxRoute: vi
        .fn()
        .mockReturnValueOnce({
          ok: false,
          detail: "sandbox inference invocation probe returned HTTP 400",
          httpStatus: 400,
        })
        .mockReturnValueOnce({
          ok: false,
          detail: "sandbox inference invocation probe returned HTTP 404",
          httpStatus: 404,
        })
        .mockReturnValueOnce({
          ok: false,
          detail: "sandbox inference invocation probe returned HTTP 400",
          httpStatus: 400,
        }),
      expectedError:
        /Sandbox-side verification rejected.*previous OpenShell inference selection was restored/s,
    });

    expect(probeSandboxRoute).toHaveBeenCalledTimes(3);
    expect(deps.calls.sleep.mock.calls).toEqual([[6_000], [2_000], [4_000]]);
    expect(deps.calls.log.mock.calls).toEqual(
      expect.arrayContaining([
        ["  Waiting 2s for OpenShell route convergence after HTTP 400 (probe 1/3)..."],
        ["  Waiting 4s for OpenShell route convergence after HTTP 404 (probe 2/3)..."],
      ]),
    );
  });

  it.each([
    ["authentication", 401],
    ["server", 500],
  ])("does not retry a changed-family %s failure (#9467)", async (_failureClass, httpStatus) => {
    const { deps, probeSandboxRoute } = await runRejectedCompatibleSwitchScenario({
      targetFamily: "anthropic",
      probeSandboxRoute: () => ({
        ok: false as const,
        detail: `sandbox inference invocation probe returned HTTP ${httpStatus}`,
        httpStatus,
      }),
      expectedError:
        /Sandbox-side verification rejected.*previous OpenShell inference selection was restored/s,
    });

    expect(probeSandboxRoute).toHaveBeenCalledOnce();
    expect(deps.calls.sleep.mock.calls).toEqual([[6_000]]);
    expect(deps.calls.log).not.toHaveBeenCalledWith(expect.stringContaining("route convergence"));
  });

  it("does not retry a target rejection when the API family did not change", async () => {
    const { deps, probeSandboxRoute } = await runRejectedCompatibleSwitchScenario({
      targetFamily: "openai",
      probeSandboxRoute: () => ({
        ok: false as const,
        detail: "sandbox inference invocation probe returned HTTP 400",
        httpStatus: 400,
      }),
      expectedError: /Sandbox-side verification rejected/,
    });

    expect(probeSandboxRoute).toHaveBeenCalledOnce();
    expect(deps.calls.sleep.mock.calls).toEqual([[6_000]]);
  });

  it.each([
    [
      "returns a rejection",
      () => ({
        ok: false,
        detail: "sandbox inference invocation probe exited with status 7",
        httpStatus: null,
      }),
      /Sandbox-side verification rejected.*previous OpenShell inference selection was restored/s,
    ],
    [
      "throws",
      () => {
        throw new Error("sandbox dial failed");
      },
      /sandbox inference invocation probe was unavailable: sandbox dial failed.*previous OpenShell inference selection was restored/s,
    ],
  ])("restores the prior route when sandbox-only provider verification %s", async (_failureMode, probeSandboxRoute, expectedError) => {
    const captureOpenshell = createCompatibleProviderCapture({
      name: "compatible-anthropic-endpoint",
      type: "anthropic",
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      configKey: "ANTHROPIC_BASE_URL",
      initiallyPresent: false,
    });
    const deps = createDeps({
      config: { agents: { defaults: { model: { primary: "inference/old-model" } } } },
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "nvidia-prod",
        model: "old-model",
      },
      session: baseSession({ provider: "nvidia-prod", model: "old-model" }),
      captureOpenshell,
      probeSandboxRoute,
    });

    await expect(
      runInferenceSet(
        {
          provider: "compatible-anthropic-endpoint",
          model: "mock-anthropic-model",
          endpointUrl: "http://host.openshell.internal:18767/",
          credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
          inferenceApi: "anthropic-messages",
        },
        deps,
      ),
    ).rejects.toThrow(expectedError);

    expect(
      captureOpenshell.mock.calls
        .filter(([args]) => args[0] === "inference" && args[1] === "set")
        .map(([args]) => args),
    ).toEqual([
      [
        "inference",
        "set",
        "-g",
        "nemoclaw",
        "--provider",
        "compatible-anthropic-endpoint",
        "--model",
        "mock-anthropic-model",
        "--no-verify",
      ],
      [
        "inference",
        "set",
        "-g",
        "nemoclaw",
        "--provider",
        "nvidia-prod",
        "--model",
        "old-model",
        "--no-verify",
      ],
    ]);
    expect(
      captureOpenshell.mock.calls.some(
        ([args]) => args[0] === "provider" && args[1] === "delete",
      ),
    ).toBe(true);
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
  });

  it("preserves redacted probe diagnostics when restoring the prior route fails", async () => {
    const providerCapture = createCompatibleProviderCapture({
      name: "compatible-anthropic-endpoint",
      type: "anthropic",
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      configKey: "ANTHROPIC_BASE_URL",
      initiallyPresent: false,
    });
    const inferenceSetResults = [
      null,
      {
        status: 19,
        output: "restore rejected",
        stdout: "",
        stderr: "restore rejected",
      },
    ];
    let inferenceSetCalls = 0;
    const captureOpenshell = vi.fn((args: string[]) => {
      switch (`${args[0]}:${args[1]}`) {
        case "inference:set":
          return inferenceSetResults[inferenceSetCalls++] ?? providerCapture(args);
        default:
          return providerCapture(args);
      }
    });
    const deps = createDeps({
      config: { agents: { defaults: { model: { primary: "inference/old-model" } } } },
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "nvidia-prod",
        model: "old-model",
      },
      session: baseSession({ provider: "nvidia-prod", model: "old-model" }),
      captureOpenshell,
      probeSandboxRoute: () => {
        throw new Error("sandbox dial failed; NVIDIA_API_KEY=nvapi-secret-value");
      },
    });

    let failure: unknown;
    try {
      await runInferenceSet(
        {
          provider: "compatible-anthropic-endpoint",
          model: "mock-anthropic-model",
          endpointUrl: "http://host.openshell.internal:18767/",
          credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
          inferenceApi: "anthropic-messages",
        },
        deps,
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const failureMessage = (failure as Error).message;
    expect(failureMessage).toContain(
      "sandbox inference invocation probe was unavailable: sandbox dial failed",
    );
    expect(failureMessage).toContain("NVIDIA_API_KEY=<REDACTED>");
    expect(failureMessage).not.toContain("nvapi-secret-value");
    expect(failureMessage).toMatch(
      /Failed to restore the previous OpenShell inference selection.*status 19.*Re-run onboarding/s,
    );
    expect(
      deps.calls.captureOpenshell.mock.calls
        .filter(([args]) => args[0] === "inference" && args[1] === "set")
        .map(([args]) => args),
    ).toEqual([
      [
        "inference",
        "set",
        "-g",
        "nemoclaw",
        "--provider",
        "compatible-anthropic-endpoint",
        "--model",
        "mock-anthropic-model",
        "--no-verify",
      ],
      [
        "inference",
        "set",
        "-g",
        "nemoclaw",
        "--provider",
        "nvidia-prod",
        "--model",
        "old-model",
        "--no-verify",
      ],
    ]);
    expect(
      deps.calls.captureOpenshell.mock.calls.some(
        ([args]) => args[0] === "provider" && args[1] === "delete",
      ),
    ).toBe(false);
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
  });

  it.each(
    (["compatible-endpoint", "compatible-anthropic-endpoint"] as const).flatMap((provider) =>
      [
        ["loopback", "http://127.0.0.1:8000/v1", "93.184.216.34"],
        ["localhost", "http://localhost:8000/v1", "93.184.216.34"],
        ["link-local", "http://169.254.169.254/latest", "93.184.216.34"],
        ["RFC1918", "http://10.0.0.1:8000/v1", "93.184.216.34"],
        [
          "non-allowlisted internal",
          "http://evil.host.openshell.internal:18767/v1",
          "93.184.216.34",
        ],
        ["HTTPS bridge", "https://host.openshell.internal:18767/v1", "93.184.216.34"],
        ["privileged-port bridge", "http://host.openshell.internal:80/v1", "93.184.216.34"],
        ["DNS-private", "https://private-resolution.example/v1", "10.0.0.8"],
      ].map(
        ([kind, endpointUrl, resolvedAddress]) =>
          [kind, provider, endpointUrl, resolvedAddress] as const,
      ),
    ),
  )(
    "rejects %s endpoint metadata for %s",
    async (_kind, provider, endpointUrl, resolvedAddress) => {
      const actualConfig =
        await vi.importActual<typeof import("../sandbox/config")>("../sandbox/config");
      const lookup = vi.fn(async () => [{ address: resolvedAddress, family: 4 }]);
      const deps = createDeps({
        config: { agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } } },
        entry: {
          name: "alpha",
          agent: "openclaw",
          provider: "nvidia-prod",
          model: "nvidia/model-a",
        },
        rewriteConfigUrlsWithDnsPinning: (value) =>
          actualConfig.rewriteConfigUrlsWithDnsPinning(value, lookup),
        // DNS-backed HTTPS endpoints (the "DNS-private" case below) route
        // through the HTTPS-pin runtime adapter instead of
        // rewriteConfigUrlsWithDnsPinning, so its real SSRF preflight is
        // exercised here too, with the same injected DNS lookup.
        ensureHttpsPinRuntimeAdapter: (adapterOptions) =>
          realEnsureHttpsPinRuntimeAdapter({
            ...adapterOptions,
            lookup,
            discoverAllowedSourceCidrs:
              adapterOptions.discoverAllowedSourceCidrs ?? (() => ["172.18.0.0/16"]),
          }),
      });

      await expect(
        runInferenceSet(
          {
            provider,
            model: "mock-model",
            noVerify: true,
            endpointUrl,
            credentialEnv:
              provider === "compatible-endpoint"
                ? "COMPATIBLE_API_KEY"
                : "COMPATIBLE_ANTHROPIC_API_KEY",
            inferenceApi:
              provider === "compatible-endpoint" ? "openai-completions" : "anthropic-messages",
          },
          deps,
        ),
      ).rejects.toThrow(/endpoint-url is not allowed:.*private\/internal address/i);

      expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
      expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    },
  );
});
