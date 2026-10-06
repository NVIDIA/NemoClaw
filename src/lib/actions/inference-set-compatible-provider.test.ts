import type { NativeCompatibleProviderAttachment } from "../inference/native-compatible/contract";
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createCliOpenShellProviderAdapter } from "../adapters/openshell/provider-adapter-cli";
import {
  nativeCompatibleFixture,
  nativeCompatibleRotationFixture,
} from "../inference/native-compatible/switch.test-support";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureHttpsPinRuntimeAdapter as realEnsureHttpsPinRuntimeAdapter } from "../inference/https-pin-runtime-adapter";
import type { ConfigObject } from "../security/credential-filter";
import { runInferenceSet } from "./inference-set";
import {
  baseSession,
  createCompatibleProviderCapture,
  createDeps,
} from "./inference-set.test-support";

type ProbeSandboxRoute = NonNullable<Parameters<typeof createDeps>[0]["probeSandboxRoute"]>;

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
      "--no-verify",
      "--provider",
      target.provider,
      "--model",
      target.model,
    ],
    [
      "inference",
      "set",
      "-g",
      "nemoclaw",
      "--no-verify",
      "--provider",
      "nvidia-prod",
      "--model",
      "old-model",
    ],
  ]);
  expect(
    captureOpenshell.mock.calls
      .filter(([args]) => args[0] === "provider" && args[1] === "delete")
      .map(([args]) => args),
  ).toEqual([["provider", "delete", "-g", "nemoclaw", target.provider]]);
  expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
  expect(deps.getSession()).toMatchObject({ provider: "nvidia-prod", model: "old-model" });

  return { deps, probeSandboxRoute };
}

describe("runInferenceSet compatible providers", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reuses durable endpoint metadata and restarts same-provider model switches", async () => {
    const native = await nativeCompatibleFixture("https://inference-api.nvidia.com/v1");
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } },
      models: { providers: { inference: { api: "openai-completions", models: [] } } },
    };
    const deps = createDeps({
      config,
      providerAdapter: native.providerAdapter,
      resolveNativeCompatibleEndpointHost: native.lookup,
      entry: {
        nativeCompatibleProviderAttachment: native.receipt,
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
    const native = await nativeCompatibleFixture("https://inference-api.nvidia.com/v1");
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } },
      models: { providers: { inference: { api: "openai-completions", models: [] } } },
    };
    const deps = createDeps({
      config,
      providerAdapter: native.providerAdapter,
      resolveNativeCompatibleEndpointHost: native.lookup,
      entry: {
        nativeCompatibleProviderAttachment: native.receipt,
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
    ["openai-completions", "https://compatible.example/v1"],
    ["openai-responses", "https://compatible.example/v1"],
    ["anthropic-messages", "https://compatible.example/v1"],
    ["openai-completions", "https://compatible.example/v1"],
    ["openai-completions", "https://93.184.216.34/v1"],
  ] as const)(
    "creates a scoped hosted provider for %s at %s and preserves its native endpoint",
    async (api, endpointUrl) => {
      const native = await nativeCompatibleFixture(endpointUrl, api, false);
      const provider =
        api === "anthropic-messages" ? "compatible-anthropic-endpoint" : "compatible-endpoint";
      const config: ConfigObject = {
        agents: { defaults: { model: { primary: "inference/old" } } },
        models: { providers: { inference: { api: "openai-completions", models: [] } } },
      };
      const deps = createDeps({
        config,
        entry: { name: "alpha", agent: "openclaw", provider: "nvidia-prod", model: "old" },
        entries: [
          { name: "alpha", agent: "openclaw", provider: "nvidia-prod", model: "old" },
          { name: "beta", agent: "openclaw", provider: "openai-api", model: "peer-model" },
        ],
        providerAdapter: native.providerAdapter,
        resolveNativeCompatibleEndpointHost: native.lookup,
        resolveCredentialValue: () => "test-hosted-secret",
      });
      await runInferenceSet(
        {
          provider,
          sandboxName: "alpha",
          model: "new",
          endpointUrl: native.profile.endpoint,
          credentialEnv:
            api === "anthropic-messages" ? "COMPATIBLE_ANTHROPIC_API_KEY" : "COMPATIBLE_API_KEY",
          inferenceApi: api,
        },
        deps,
      );
      expect(native.adapter.createProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          name: native.profile.providerName,
          type: native.profile.profileId,
          credentials: [{ name: native.profile.credentialEnv, value: "test-hosted-secret" }],
          config: [],
        }),
      );
      expect(native.adapter.attachProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxName: "alpha",
          providerName: native.profile.providerName,
        }),
      );
      expect(native.adapter.attachProvider).toHaveBeenCalledOnce();
      expect(native.adapter.detachProvider).not.toHaveBeenCalled();
      expect(deps.calls.updateSandbox.mock.calls.every(([name]) => name === "alpha")).toBe(true);
      expect(deps.inferenceRouteObserver.observeInferenceRoute).not.toHaveBeenCalled();
      expect(deps.calls.ensureHttpsPinRuntimeAdapter).not.toHaveBeenCalled();
      expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
        "alpha",
        expect.objectContaining({
          endpointUrl: native.profile.endpoint,
          preferredInferenceApi: api,
          nativeCompatibleProviderAttachment: native.receipt,
        }),
      );
      expect(JSON.stringify(config)).toContain(native.profile.endpoint);
      expect(JSON.stringify(config)).not.toContain("test-hosted-secret");
      expect(JSON.stringify(config)).not.toContain("inference.local");
    },
  );

  it("retires the superseded provider only after successful commit", async () => {
    const f = await nativeCompatibleRotationFixture();
    f.attachments.delete("beta");
    const entry = {
      name: "alpha",
      agent: "openclaw",
      provider: "compatible-endpoint",
      model: "old-model",
      endpointUrl: f.previous.profile.endpoint,
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: f.previous.profile.api,
      nativeCompatibleProviderAttachment: f.previous.receipt,
    };
    const deps = createDeps({
      config: {
        agents: { defaults: { model: { primary: "inference/old-model" } } },
        models: { providers: { inference: { api: f.previous.profile.api, models: [] } } },
      },
      entry,
      providerAdapter: f.adapter,
      resolveNativeCompatibleEndpointHost: f.lookup,
    });
    deps.getNativeCompatibleProviderAuthority = (_gateway, profileId) =>
      f.authorities.get(profileId);
    deps.setNativeCompatibleProviderAuthority = (_gateway, receipt) => {
      f.authorities.set(receipt.profileId, receipt);
    };
    const clear = vi.fn((_gateway: string, receipt: NativeCompatibleProviderAttachment) => {
      f.authorities.delete(receipt.profileId);
    });
    deps.clearNativeCompatibleProviderAuthority = clear;
    const run = runInferenceSet(
      {
        sandboxName: "alpha",
        provider: "compatible-endpoint",
        model: "old-model",
        endpointUrl: entry.endpointUrl,
        credentialEnv: entry.credentialEnv,
        inferenceApi: entry.preferredInferenceApi,
      },
      deps,
    );
    await run;
    expect(clear).toHaveBeenCalledWith("nemoclaw", f.previous.receipt);
    expect(f.authorities.has(f.previous.profile.profileId)).toBe(false);
    expect([...f.attachments.get("alpha")!]).toEqual([f.next.providerName]);
    expect(deps.calls.updateSandbox.mock.invocationCallOrder[0]).toBeLessThan(
      f.adapter.deleteProvider.mock.invocationCallOrder[0]!,
    );
  });

  it("restores the old provider before retiring a failed new selection", async () => {
    const f = await nativeCompatibleRotationFixture();
    f.attachments.delete("beta");
    const entry = {
      name: "alpha",
      agent: "openclaw",
      provider: "compatible-endpoint",
      model: "old-model",
      endpointUrl: f.previous.profile.endpoint,
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: f.previous.profile.api,
      nativeCompatibleProviderAttachment: f.previous.receipt,
    };
    const deps = createDeps({
      config: {
        agents: { defaults: { model: { primary: "inference/old-model" } } },
        models: { providers: { inference: { api: f.previous.profile.api, models: [] } } },
      },
      entry,
      providerAdapter: f.adapter,
      resolveNativeCompatibleEndpointHost: f.lookup,
    });
    deps.getNativeCompatibleProviderAuthority = (_gateway, profileId) =>
      f.authorities.get(profileId);
    deps.setNativeCompatibleProviderAuthority = (_gateway, receipt) => {
      f.authorities.set(receipt.profileId, receipt);
    };
    const clear = vi.fn((_gateway: string, receipt: NativeCompatibleProviderAttachment) => {
      f.authorities.delete(receipt.profileId);
    });
    deps.clearNativeCompatibleProviderAuthority = clear;
    deps.updateSandbox = vi.fn(() => false);
    const run = runInferenceSet(
      {
        sandboxName: "alpha",
        provider: "compatible-endpoint",
        model: "old-model",
        endpointUrl: entry.endpointUrl,
        credentialEnv: entry.credentialEnv,
        inferenceApi: entry.preferredInferenceApi,
      },
      deps,
    );
    await expect(run).rejects.toThrow("Failed to update NemoClaw registry");
    expect([...f.attachments.get("alpha")!]).toEqual([f.previous.profile.providerName]);
    expect(clear).toHaveBeenCalledWith("nemoclaw", f.nextReceipt);
    expect(f.authorities.get(f.previous.profile.profileId)).toEqual(f.previous.receipt);
    expect(f.adapter.deleteProvider).not.toHaveBeenCalledWith(
      expect.objectContaining({ providerName: f.previous.profile.providerName }),
    );
  });

  it("refreshes changed DNS pins only for the selected sandbox and retains prior ownership", async () => {
    const { previous, lookup, next, nextReceipt, attachments, authorities, adapter } =
      await nativeCompatibleRotationFixture();
    const entry = {
      name: "alpha",
      agent: "openclaw",
      provider: "compatible-endpoint",
      model: "old-model",
      endpointUrl: previous.profile.endpoint,
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: previous.profile.api,
      nativeCompatibleProviderAttachment: previous.receipt,
    };
    const deps = createDeps({
      config: {
        agents: { defaults: { model: { primary: "inference/old-model" } } },
        models: { providers: { inference: { api: previous.profile.api, models: [] } } },
      },
      entry,
      entries: [entry, { ...entry, name: "beta" }],
      providerAdapter: adapter,
      resolveNativeCompatibleEndpointHost: lookup,
    });
    deps.getNativeCompatibleProviderAuthority = (_gateway, profileId) => authorities.get(profileId);
    deps.setNativeCompatibleProviderAuthority = (_gateway, receipt) => {
      authorities.set(receipt.profileId, receipt);
    };

    await runInferenceSet(
      {
        sandboxName: "alpha",
        provider: "compatible-endpoint",
        model: "old-model",
        endpointUrl: previous.profile.endpoint,
        credentialEnv: "COMPATIBLE_API_KEY",
        inferenceApi: previous.profile.api,
      },
      deps,
    );

    expect(next.profileId).not.toBe(previous.profile.profileId);
    expect(adapter.createProvider).toHaveBeenCalledOnce();
    expect(adapter.attachProvider).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sandboxName: "alpha", providerName: next.providerName }),
    );
    expect(adapter.detachProvider).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sandboxName: "alpha",
        providerName: previous.profile.providerName,
      }),
    );
    expect([...attachments.get("alpha")!]).toEqual([next.providerName]);
    expect([...attachments.get("beta")!]).toEqual([previous.profile.providerName]);
    expect(authorities.get(previous.profile.profileId)).toEqual(previous.receipt);
    expect(authorities.get(next.profileId)).toEqual(nextReceipt);
    expect(previous.adapter.deleteProvider).not.toHaveBeenCalled();
    expect(previous.adapter.updateProvider).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ nativeCompatibleProviderAttachment: nextReceipt }),
    );
    expect(deps.calls.updateSandbox.mock.calls.every(([name]) => name === "alpha")).toBe(true);
    expect(deps.inferenceRouteObserver.observeInferenceRoute).not.toHaveBeenCalled();
  });

  it("rejects an existing scoped provider without ownership before attachment or publication", async () => {
    const native = await nativeCompatibleFixture();
    const deps = createDeps({
      config: {},
      entry: { name: "alpha", agent: "openclaw", provider: "nvidia-prod", model: "old" },
      providerAdapter: native.providerAdapter,
    });
    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "new",
          endpointUrl: native.profile.endpoint,
          credentialEnv: "COMPATIBLE_API_KEY",
          inferenceApi: "openai-completions",
        },
        deps,
      ),
    ).rejects.toThrow("ownership receipt");
    expect(native.adapter.updateProvider).not.toHaveBeenCalled();
    expect(native.adapter.attachProvider).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
  });

  it("stops before attachment when a newly created provider changes identity (#9806)", async () => {
    const native = await nativeCompatibleFixture(undefined, undefined, false);
    native.adapter.importProviderProfile
      .mockResolvedValueOnce({ ok: true })
      .mockImplementationOnce(async () => {
        native.metadata.revision.id = "replacement";
        return { ok: true };
      });
    const deps = createDeps({
      config: {},
      entry: { name: "alpha", agent: "openclaw", provider: "nvidia-prod", model: "old" },
      providerAdapter: native.providerAdapter,
    });
    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "new",
          endpointUrl: native.profile.endpoint,
          credentialEnv: "COMPATIBLE_API_KEY",
          inferenceApi: "openai-completions",
        },
        deps,
      ),
    ).rejects.toThrow("changed identity");
    expect(native.adapter.createProvider).toHaveBeenCalledOnce();
    expect(native.adapter.attachProvider).not.toHaveBeenCalled();
    expect(native.adapter.deleteProvider).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
  });

  it("redacts provider inspection diagnostics before native publication (#9806)", async () => {
    const native = await nativeCompatibleFixture();
    const secret = "stored-provider-secret"; // gitleaks:allow
    const realAdapter = createCliOpenShellProviderAdapter({
      run: () => ({
        status: 1,
        output: `provider lookup failed with credential ${secret}`,
        stdout: "",
        stderr: `provider lookup failed with credential ${secret}`,
      }),
    });
    const deps = createDeps({
      config: {},
      entry: { name: "alpha", agent: "openclaw", provider: "nvidia-prod", model: "old" },
      providerAdapter: { ...native.providerAdapter, getProvider: realAdapter.getProvider },
    });
    const failure = await runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "new",
        endpointUrl: native.profile.endpoint,
        credentialEnv: "COMPATIBLE_API_KEY",
        inferenceApi: "openai-completions",
      },
      deps,
    ).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("OpenShell could not inspect the provider");
    expect((failure as Error).message).not.toContain(secret);
    expect(native.adapter.attachProvider).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
  });

  it("rejects profile collisions before credential or sandbox mutation", async () => {
    const native = await nativeCompatibleFixture(undefined, undefined, false);
    native.adapter.importProviderProfile.mockResolvedValue({
      ok: false,
      error: { kind: "command", reason: "profile_incompatible", exitCode: 1, message: "collision" },
    } as never);
    const deps = createDeps({
      config: {},
      entry: { name: "alpha", agent: "openclaw", provider: "nvidia-prod", model: "old" },
      providerAdapter: native.providerAdapter,
    });
    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "new",
          endpointUrl: native.profile.endpoint,
          credentialEnv: "COMPATIBLE_API_KEY",
          inferenceApi: "openai-completions",
        },
        deps,
      ),
    ).rejects.toThrow("security boundary");
    expect(native.adapter.createProvider).not.toHaveBeenCalled();
    expect(native.adapter.updateProvider).not.toHaveBeenCalled();
    expect(native.adapter.attachProvider).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it.each([
    ["endpoint", "https://93.184.216.35/v1", "openai-completions"],
    ["protocol", "https://93.184.216.34/v1", "openai-responses"],
  ] as const)(
    "rejects a receipt filed under another %s before mutation",
    async (_kind, endpointUrl, api) => {
      const native = await nativeCompatibleFixture();
      const deps = createDeps({
        config: {},
        entry: {
          name: "alpha",
          agent: "openclaw",
          provider: "compatible-endpoint",
          model: "old",
          endpointUrl,
          credentialEnv: "COMPATIBLE_API_KEY",
          preferredInferenceApi: api,
          nativeCompatibleProviderAttachment: native.receipt,
        },
        providerAdapter: native.providerAdapter,
      });
      await expect(
        runInferenceSet({ provider: "compatible-endpoint", model: "new" }, deps),
      ).rejects.toThrow(/receipt|attachment|selection/i);
      expect(native.adapter.importProviderProfile).not.toHaveBeenCalled();
      expect(native.adapter.updateProvider).not.toHaveBeenCalled();
      expect(native.adapter.attachProvider).not.toHaveBeenCalled();
      expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    },
  );

  it("refuses a replaced provider identity before attaching it", async () => {
    const native = await nativeCompatibleFixture();
    const deps = createDeps({
      config: {},
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-endpoint",
        model: "old",
        endpointUrl: native.profile.endpoint,
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: native.profile.api,
        nativeCompatibleProviderAttachment: native.receipt,
      },
      providerAdapter: native.providerAdapter,
    });
    native.metadata.revision.id = "replacement";
    await expect(
      runInferenceSet({ provider: "compatible-endpoint", model: "new" }, deps),
    ).rejects.toThrow("changed identity");
    expect(native.adapter.updateProvider).not.toHaveBeenCalled();
    expect(native.adapter.attachProvider).not.toHaveBeenCalled();
    expect(native.adapter.deleteProvider).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("removes a newly selected endpoint after failed verification and clears confirmed authority", async () => {
    const native = await nativeCompatibleFixture(undefined, undefined, false);
    const deps = createDeps({
      config: {},
      entry: { name: "alpha", agent: "openclaw", provider: "nvidia-prod", model: "old" },
      providerAdapter: native.providerAdapter,
      probeSandboxRoute: async () => ({ ok: false, detail: "rejected", httpStatus: 403 }),
    });
    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "new",
          endpointUrl: native.profile.endpoint,
          credentialEnv: "COMPATIBLE_API_KEY",
          inferenceApi: "openai-completions",
        },
        deps,
      ),
    ).rejects.toThrow("verification rejected");
    expect(native.adapter.detachProvider).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxName: "alpha", providerName: native.profile.providerName }),
    );
    expect(native.attached.size).toBe(0);
    expect(native.adapter.deleteProvider).toHaveBeenCalledOnce();
    expect(deps.clearNativeCompatibleProviderAuthority).toHaveBeenCalledWith(
      "nemoclaw",
      native.receipt,
    );
    expect(deps.setNativeCompatibleProviderAuthority).toHaveBeenCalledWith(
      "nemoclaw",
      native.receipt,
    );
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
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

    expect(
      deps.calls.updateSandbox.mock.calls
        .filter(([, fields]) => fields.provider !== undefined)
        .at(-1),
    ).toEqual([
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
    expect(deps.calls.probeSandboxRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxName: "alpha",
        provider: "compatible-anthropic-endpoint",
        model: "mock-anthropic-model",
        preferredInferenceApi: "anthropic-messages",
      }),
    );
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
      probeSandboxRoute: async () => ({
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
      probeSandboxRoute: async () => ({
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
      async () => ({
        ok: false,
        detail: "sandbox inference invocation probe exited with status 7",
        httpStatus: null,
      }),
      /Sandbox-side verification rejected.*previous OpenShell inference selection was restored/s,
    ],
    [
      "throws",
      async () => {
        throw new Error("sandbox dial failed");
      },
      /sandbox inference invocation probe was unavailable: sandbox dial failed.*previous OpenShell inference selection was restored/s,
    ],
  ])(
    "restores the prior route when sandbox-only provider verification %s",
    async (_failureMode, probeSandboxRoute, expectedError) => {
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
          "--no-verify",
          "--provider",
          "compatible-anthropic-endpoint",
          "--model",
          "mock-anthropic-model",
        ],
        [
          "inference",
          "set",
          "-g",
          "nemoclaw",
          "--no-verify",
          "--provider",
          "nvidia-prod",
          "--model",
          "old-model",
        ],
      ]);
      expect(
        captureOpenshell.mock.calls.some(
          ([args]) => args[0] === "provider" && args[1] === "delete",
        ),
      ).toBe(true);
      expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
      expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
    },
  );

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
        "--no-verify",
        "--provider",
        "compatible-anthropic-endpoint",
        "--model",
        "mock-anthropic-model",
      ],
      [
        "inference",
        "set",
        "-g",
        "nemoclaw",
        "--no-verify",
        "--provider",
        "nvidia-prod",
        "--model",
        "old-model",
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
        ["link-local", "https://169.254.169.254/latest", "93.184.216.34"],
        ["RFC1918", "https://10.0.0.1:8000/v1", "93.184.216.34"],
        [
          "non-allowlisted internal",
          "https://evil.host.openshell.internal:18767/v1",
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
        resolveNativeCompatibleEndpointHost: lookup,
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
      ).rejects.toThrow(
        /endpoint-url is not allowed:.*private\/internal address|hosted endpoint failed network validation/i,
      );

      expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
      expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    },
  );

  it("does not roll back a created direct provider after an ambiguous route result", async () => {
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
        provider: "nvidia-prod",
        model: "old-model",
      },
      session: baseSession({ provider: "nvidia-prod", model: "old-model" }),
      captureOpenshell,
      inferenceRouteMutator: { setInferenceRoute },
    });

    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "mock-model",
          noVerify: true,
          endpointUrl: "http://host.openshell.internal:18767/v1",
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

  it("fails before provider or route mutation when a provider-backed route has no rollback authority", async () => {
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
      entry: { name: "alpha", agent: "openclaw" },
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
          endpointUrl: "http://host.openshell.internal:18767/v1",
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

  it("retries exactly once only for definite provider-not-found after direct binding", async () => {
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
      entry: { name: "alpha", agent: "openclaw", provider: "nvidia-prod", model: "old" },
      captureOpenshell: directCapture,
      inferenceRouteMutator: { setInferenceRoute: directSet },
    });

    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "mock-model",
          noVerify: true,
          endpointUrl: "http://host.openshell.internal:18767/v1",
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
      entry: { name: "alpha", agent: "openclaw", provider: "nvidia-prod", model: "old" },
      inferenceRouteMutator: { setInferenceRoute: noBindingSet },
    });
    await expect(
      runInferenceSet({ provider: "openai-api", model: "gpt-test", noVerify: true }, noBindingDeps),
    ).rejects.toThrow("provider not found");
    expect(noBindingSet).toHaveBeenCalledOnce();
  });
});

describe("native compatible model selection", () => {
  async function scenario(requestOk: boolean) {
    const native = await nativeCompatibleFixture();
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/old-model" } } },
      models: { providers: { inference: { api: "openai-completions", models: [] } } },
    };
    const deps = createDeps({
      config,
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-endpoint",
        model: "old-model",
        endpointUrl: native.profile.endpoint,
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: native.profile.api,
        nativeCompatibleProviderAttachment: native.receipt,
      },
      providerAdapter: native.providerAdapter,
      probeSandboxRoute: async () =>
        requestOk ? { ok: true } : { ok: false, detail: "rejected", httpStatus: 403 },
    });
    return {
      native,
      config,
      deps,
      run: () =>
        runInferenceSet(
          { provider: "compatible-endpoint", model: "new-model", sandboxName: "alpha" },
          deps,
        ),
    };
  }

  it("publishes the scoped native model after a successful request", async () => {
    const { native, config, deps, run } = await scenario(true);
    await run();
    expect(deps.inferenceRouteObserver.observeInferenceRoute).not.toHaveBeenCalled();
    expect(deps.calls.ensureHttpsPinRuntimeAdapter).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ nativeCompatibleProviderAttachment: native.receipt }),
    );
    expect(JSON.stringify(config)).toContain(native.profile.endpoint);
    expect(JSON.stringify(config)).not.toContain("inference.local");
  });

  it("retains the previous model when the native request fails", async () => {
    const { deps, run } = await scenario(false);
    await expect(run()).rejects.toThrow("verification rejected");
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
  });
});
