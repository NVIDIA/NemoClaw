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
  HERMES_TARGET,
  OPENCLAW_TARGET,
} from "../../../test/helpers/inference-set";

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

describe("runInferenceSet compatible providers", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reuses durable endpoint metadata and restarts same-provider model switches", async () => {
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
    expect(
      deps.calls.updateSandbox.mock.calls
        .filter(([, fields]) => fields.provider !== undefined)
        .at(-1),
    ).toEqual([
      "alpha",
      expect.objectContaining({
        provider: "compatible-endpoint",
        model: "nvidia/model-b",
        endpointUrl: "https://inference-api.nvidia.com/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
      }),
    ]);
    expect(deps.calls.restartSandboxGateway).toHaveBeenCalledOnce();
    expect(deps.calls.restartSandboxGateway).toHaveBeenCalledWith("alpha", "nemoclaw");
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
    expect(
      deps.calls.updateSandbox.mock.calls
        .filter(([, fields]) => fields.provider !== undefined)
        .at(-1),
    ).toEqual([
      "alpha",
      expect.objectContaining({
        provider: "compatible-endpoint",
        model: "nvidia/nvidia/nemotron-3-super-v3",
        endpointUrl: "https://inference-api.nvidia.com/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
      }),
    ]);
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
  ])(
    "creates an absent direct compatible provider for %s endpoint (#7725)",
    async (_kind, endpointUrl, validatedEndpointUrl) => {
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
      expect(
        deps.calls.updateSandbox.mock.calls
          .filter(([, fields]) => fields.provider !== undefined)
          .at(-1),
      ).toEqual([
        "alpha",
        expect.objectContaining({
          provider: "compatible-endpoint",
          endpointUrl: validatedEndpointUrl,
        }),
      ]);
    },
  );

  it("stops before route mutation when a newly created provider revision changes (#9806)", async () => {
    let providerCreated = false;
    let presentInspectionCount = 0;
    const captureOpenshell = vi.fn((args: string[]) => {
      switch (`${args[0]}:${args[1]}`) {
        case "provider:profile":
          return OPENAI_PROFILE_RESULT;
        case "provider:get": {
          const missingOutput = "Error: provider 'compatible-endpoint' not found";
          presentInspectionCount += providerCreated ? 1 : 0;
          const presentOutput = [
            "Name: compatible-endpoint",
            "Id: 11111111-2222-4333-8444-555555555555",
            "Type: openai",
            `Resource version: ${presentInspectionCount === 1 ? 1 : 2}`,
            "Credential keys: COMPATIBLE_API_KEY",
            "Config keys: OPENAI_BASE_URL",
          ].join("\n");
          return providerCreated
            ? { status: 0, output: presentOutput, stdout: presentOutput, stderr: "" }
            : { status: 1, output: missingOutput, stdout: "", stderr: missingOutput };
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
      session: baseSession({ provider: "nvidia-prod", model: "nvidia/model-a" }),
      captureOpenshell,
      rewriteConfigUrlsWithDnsPinning: async () => "http://198.51.100.10/v1",
      resolveCredentialValue: () => "real-upstream-secret",
    });

    const failure = await runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "mock-model",
        endpointUrl: "http://compatible.example/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        inferenceApi: "openai-completions",
      },
      deps,
    ).catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "Could not verify newly created provider 'compatible-endpoint' immediately before inference route mutation",
    );
    expect((failure as Error).message).toContain(
      "Could not verify newly created provider 'compatible-endpoint' before rollback; no provider deletion was attempted",
    );
    expect(
      captureOpenshell.mock.calls.filter(([args]) => args[0] === "inference" && args[1] === "set"),
    ).toHaveLength(0);
    expect(
      captureOpenshell.mock.calls.filter(
        ([args]) => args[0] === "provider" && args[1] === "delete",
      ),
    ).toHaveLength(0);
    expect(
      captureOpenshell.mock.calls.filter(([args]) => args[0] === "provider" && args[1] === "get"),
    ).toHaveLength(4);
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
  });

  it("redacts provider inspection diagnostics before inference handling (#9806)", async () => {
    const storedCredential = "stored-provider-secret"; // gitleaks:allow
    const captureOpenshell = vi.fn((args: string[]) => {
      switch (`${args[0]}:${args[1]}`) {
        case "provider:get": {
          const output = `provider lookup failed with credential ${storedCredential}`;
          return { status: 1, output, stdout: "", stderr: output };
        }
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
      session: baseSession({ provider: "nvidia-prod", model: "nvidia/model-a" }),
      captureOpenshell,
      rewriteConfigUrlsWithDnsPinning: async () => "http://198.51.100.10/v1",
      resolveCredentialValue: () => "real-upstream-secret",
    });

    const failure = await runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "mock-model",
        endpointUrl: "http://compatible.example/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        inferenceApi: "openai-completions",
      },
      deps,
    ).catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("OpenShell could not inspect the provider.");
    expect((failure as Error).message).not.toContain(storedCredential);
    expect(
      captureOpenshell.mock.calls.filter(([args]) => args[0] === "inference" && args[1] === "set"),
    ).toHaveLength(0);
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
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
            output:
              "failed to verify inference endpoint for provider 'compatible-endpoint' and model 'mock-model' at http://198.51.100.10/v1: requested endpoint is unreachable",
            stdout: "",
            stderr:
              "failed to verify inference endpoint for provider 'compatible-endpoint' and model 'mock-model' at http://198.51.100.10/v1: requested endpoint is unreachable",
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
    expect(
      captureOpenshell.mock.calls.filter(([args]) => args[0] === "inference" && args[1] === "set"),
    ).toHaveLength(1);
    expect(
      captureOpenshell.mock.calls.filter(
        ([args]) => args[0] === "provider" && args[1] === "delete",
      ),
    ).toHaveLength(1);
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
  ])(
    "rejects $bindingPart replacement for an existing direct provider (#7725)",
    async ({ bindingPart, recordedEndpointUrl, recordedCredentialEnv }) => {
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
    },
  );

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

  it("preserves explicit inference API through the final registry sync", async () => {
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
    expect(
      deps.calls.updateSandbox.mock.calls
        .filter(([, fields]) => fields.provider !== undefined)
        .at(-1),
    ).toEqual([
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
    expect(deps.calls.restartSandboxGateway).toHaveBeenCalledWith("alpha", "nemoclaw");
  });

  it.each([OPENCLAW_TARGET, HERMES_TARGET])(
    "persists admitted Anthropic API metadata for $agentName provider switches",
    async (target) => {
      const inferenceApi =
        target.agentName === "hermes" ? "openai-completions" : "anthropic-messages";
      const config: ConfigObject = {
        agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } },
        models: { providers: { inference: { api: "openai-completions", models: [] } } },
      };
      const captureOpenshell = createCompatibleProviderCapture({
        name: "compatible-anthropic-endpoint",
        type: target.agentName === "hermes" ? "openai" : "anthropic",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        configKey: target.agentName === "hermes" ? "OPENAI_BASE_URL" : "ANTHROPIC_BASE_URL",
        initiallyPresent: false,
      });
      const deps = createDeps({
        config,
        target,
        entry: {
          name: "alpha",
          agent: target.agentName,
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
          endpointUrl: "https://anthropic.example/v1",
          credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
          inferenceApi,
        },
        deps,
      );

      expect(
        deps.calls.updateSandbox.mock.calls
          .filter(([, fields]) => fields.provider !== undefined)
          .at(-1),
      ).toEqual([
        "alpha",
        expect.objectContaining({
          provider: "compatible-anthropic-endpoint",
          model: "mock-anthropic-model",
          endpointUrl: "http://host.openshell.internal:11438/route/test-route",
          credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
          preferredInferenceApi: inferenceApi,
          nimContainer: null,
        }),
      ]);
      expect(deps.calls.rewriteConfigUrlsWithDnsPinning).not.toHaveBeenCalled();
      expect(captureOpenshell).toHaveBeenCalledWith(
        [
          "inference",
          "set",
          "-g",
          "nemoclaw",
          "--no-verify",
          "--provider",
          "compatible-anthropic-endpoint",
          "--model",
          "mock-anthropic-model",
        ],
        expect.objectContaining({ ignoreError: true }),
      );
    },
  );

  it("rejects an unverified host bridge before provider or route mutation", async () => {
    const captureOpenshell = vi.fn();
    const deps = createDeps({
      config: { agents: { defaults: { model: { primary: "inference/old-model" } } } },
      entry: { name: "alpha", agent: "openclaw", provider: "nvidia-prod", model: "old-model" },
      session: baseSession({ provider: "nvidia-prod", model: "old-model" }),
      captureOpenshell,
    });

    await expect(
      runInferenceSet(
        {
          provider: "compatible-anthropic-endpoint",
          model: "mock-anthropic-model",
          endpointUrl: "http://host.openshell.internal:49152",
          credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
          inferenceApi: "anthropic-messages",
        },
        deps,
      ),
    ).rejects.toThrow("cannot use an unverified OpenShell host bridge endpoint");

    expect(captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
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

  it("retains a legacy shared provider after an ambiguous route result", async () => {
    const captureOpenshell = createCompatibleProviderCapture({
      name: "compatible-endpoint",
      type: "openai",
      credentialEnv: "COMPATIBLE_API_KEY",
      configKey: "OPENAI_BASE_URL",
      initiallyPresent: false,
    });
    const setInferenceRoute = vi.fn(async () => ({
      ok: false as const,
      ambiguous: true,
      error: {
        kind: "command" as const,
        reason: "indeterminate" as const,
        exitCode: null,
        message: "route result unknown",
      },
    }));
    const deps = createDeps({
      config: { agents: { defaults: { model: { primary: "inference/old-model" } } } },
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-endpoint",
        model: "old-model",
      },
      session: baseSession({ provider: "compatible-endpoint", model: "old-model" }),
      captureOpenshell,
      inferenceRouteMutator: { setInferenceRoute },
    });

    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "mock-model",
          noVerify: true,
          endpointUrl: "http://8.8.8.8:18767/v1",
          credentialEnv: "COMPATIBLE_API_KEY",
          inferenceApi: "openai-completions",
        },
        deps,
      ),
    ).rejects.toThrow("route result unknown");

    expect(setInferenceRoute).toHaveBeenCalledOnce();
    expect(
      captureOpenshell.mock.calls.some(([args]) => args[0] === "provider" && args[1] === "create"),
    ).toBe(true);
    expect(
      captureOpenshell.mock.calls.some(([args]) => args[0] === "provider" && args[1] === "delete"),
    ).toBe(false);
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
    expect(deps.calls.setOpenClawConfigValues).not.toHaveBeenCalled();
  });

  it("rejects a retained shared route without rollback authority before mutation", async () => {
    const captureOpenshell = createCompatibleProviderCapture({
      name: "compatible-endpoint",
      type: "openai",
      credentialEnv: "COMPATIBLE_API_KEY",
      configKey: "OPENAI_BASE_URL",
      initiallyPresent: false,
    });
    const setInferenceRoute = vi.fn();
    const deps = createDeps({
      config: {},
      entry: { name: "alpha", agent: "openclaw", provider: "compatible-endpoint" },
      captureOpenshell,
      inferenceRouteObserver: {
        observeInferenceRoute: vi.fn(async () => ({
          ok: true as const,
          value: { state: "unconfigured" as const },
        })),
      },
      inferenceRouteMutator: { setInferenceRoute },
    });

    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "mock-model",
          endpointUrl: "http://8.8.8.8:18767/v1",
          credentialEnv: "COMPATIBLE_API_KEY",
          inferenceApi: "openai-completions",
        },
        deps,
      ),
    ).rejects.toThrow(/no configured inference selection to restore/u);

    expect(setInferenceRoute).not.toHaveBeenCalled();
    expect(
      captureOpenshell.mock.calls.some(
        ([args]) => args[0] === "provider" && ["create", "update", "delete"].includes(args[1]),
      ),
    ).toBe(false);
  });

  it("retries a retained shared binding only after definite provider-not-found", async () => {
    const directCapture = createCompatibleProviderCapture({
      name: "compatible-endpoint",
      type: "openai",
      credentialEnv: "COMPATIBLE_API_KEY",
      configKey: "OPENAI_BASE_URL",
      initiallyPresent: false,
    });
    const directSet = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        ambiguous: false,
        error: {
          kind: "command" as const,
          reason: "provider_not_found" as const,
          exitCode: 1,
          message: "provider not found",
        },
      })
      .mockResolvedValueOnce({ ok: true as const });
    const directDeps = createDeps({
      config: {},
      entry: { name: "alpha", agent: "openclaw", provider: "compatible-endpoint", model: "old" },
      captureOpenshell: directCapture,
      inferenceRouteMutator: { setInferenceRoute: directSet },
    });

    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "mock-model",
          noVerify: true,
          endpointUrl: "http://8.8.8.8:18767/v1",
          credentialEnv: "COMPATIBLE_API_KEY",
          inferenceApi: "openai-completions",
        },
        directDeps,
      ),
    ).resolves.toMatchObject({ provider: "compatible-endpoint" });
    expect(directSet).toHaveBeenCalledTimes(2);

    const noBindingSet = vi.fn(async () => ({
      ok: false as const,
      ambiguous: false,
      error: {
        kind: "command" as const,
        reason: "provider_not_found" as const,
        exitCode: 1,
        message: "provider not found",
      },
    }));
    const noBindingDeps = createDeps({
      config: {},
      entry: { name: "alpha", agent: "openclaw", provider: "vllm-local", model: "old" },
      inferenceRouteMutator: { setInferenceRoute: noBindingSet },
    });
    await expect(
      runInferenceSet({ provider: "vllm-local", model: "gpt-test", noVerify: true }, noBindingDeps),
    ).rejects.toThrow("provider not found");
    expect(noBindingSet).toHaveBeenCalledOnce();
  });
});
