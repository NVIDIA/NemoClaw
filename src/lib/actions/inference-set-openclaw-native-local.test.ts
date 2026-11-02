// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  attachment,
  fixture,
  switchingFixture,
} from "../../../test/helpers/inference-set-openclaw-native-local";
import { createDeps, nativeLocalTestReceipt } from "../../../test/helpers/inference-set";
import { resolveOpenClawLocalSwitch } from "./inference-set/native-local";
import { patchOpenClawInferenceConfig, runInferenceSet } from "./inference-set";
import { nativeLocalIdentity } from "../inference/native-local/contract";
import * as routerBlueprint from "../core/model-router-port";
import * as routerProcess from "../onboard/model-router-process";
import * as onboardSession from "../state/onboard-session";
import type { ConfigObject } from "../security/credential-filter";
import { hashCredential } from "../security/credential-hash";

vi.mock("../adapters/openshell/provider-policy", () => ({
  requireNativeProviderPolicy: vi.fn(async () => {}),
}));

it.each([
  ["http://host.openshell.internal:11434/v1", "NEMOCLAW_LOCAL_INFERENCE_TOKEN"],
  ["http://host.docker.internal:11434/v1", "NEMOCLAW_LOCAL_INFERENCE_TOKEN"],
  ["https://fixture.example/v1", "COMPATIBLE_API_KEY"],
  ["http://10.1.1.225:8123/v1", "COMPATIBLE_API_KEY"],
])("restores compatible inference at %s with its selected credential family", (endpoint, key) => {
  const config: ConfigObject = {
    models: { providers: { inference: { apiKey: "openshell:resolve:env:v1_OTHER_API_KEY" } } },
  };
  patchOpenClawInferenceConfig(
    config,
    "compatible-endpoint",
    "changed-model",
    "openai-completions",
    undefined,
    "compatible-endpoint",
    { effort: null, explicit: false },
    false,
    endpoint,
    true,
  );
  expect(config).toMatchObject({
    agents: { defaults: { model: { primary: "inference/changed-model" } } },
    models: {
      providers: {
        inference: { baseUrl: endpoint, apiKey: `openshell:resolve:env:${key}` },
      },
    },
  });
});

describe("OpenClaw native local live selection", () => {
  it.each([
    { provider: "vllm-local", expected: {} },
    { provider: "ollama-local", expected: { prepare: true } },
  ])(
    "preserves legacy NIM until recreation when selecting $provider",
    async ({ provider, expected }) => {
      const deps = fixture();
      deps.resolveCredentialValue = () => "test-hosted-secret";
      await expect(
        resolveOpenClawLocalSwitch({
          agentName: "openclaw",
          provider,
          sandboxName: "alpha",
          gatewayName: "nemoclaw",
          deps,
          entry: {
            name: "alpha",
            agent: "openclaw",
            provider: "vllm-local",
            nimContainer: "owned-nim",
          },
        }),
      ).resolves.toEqual(expected);
    },
  );

  it("changes a configured router model with only its native instance registered", async () => {
    vi.spyOn(routerBlueprint, "loadBlueprintProfile").mockReturnValue({
      provider_name: "team-router",
      model: "nvidia-routed",
      endpoint: "http://localhost:4000/v1",
      credential_env: "NVIDIA_INFERENCE_API_KEY",
      router: { enabled: true, port: 4000 },
    });
    const credential = "test-router-key";
    vi.spyOn(routerProcess, "doesModelRouterProcessOwnPort").mockReturnValue(true);
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({
      routerPort: 4000,
      routerPid: 123,
      routerCredentialHash: hashCredential(credential),
    } as ReturnType<typeof onboardSession.loadSession>);
    const binding = {
      agent: "openclaw" as const,
      provider: "team-router",
      endpointUrl: "http://host.openshell.internal:4000/v1",
      credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
      authMode: "authenticated" as const,
      gatewayName: "nemoclaw",
      sandboxName: "alpha",
    };
    const receipt = {
      ...binding,
      ...nativeLocalIdentity(binding),
      schemaVersion: 1 as const,
      providerId: "owned-router",
    };
    const deps = createDeps({
      config: {
        agents: { defaults: { model: { primary: "inference/old-model" } } },
        models: {
          providers: {
            inference: {
              baseUrl: binding.endpointUrl,
              apiKey: "openshell:resolve:env:NEMOCLAW_LOCAL_INFERENCE_TOKEN",
              api: "openai-completions",
              models: [{ id: "old-model" }],
            },
          },
        },
      },
      entry: {
        name: "alpha",
        agent: "openclaw",
        gatewayName: "nemoclaw",
        provider: "team-router",
        model: "old-model",
        endpointUrl: binding.endpointUrl,
        preferredInferenceApi: "openai-completions",
        nativeLocalProviderAttachment: receipt,
      },
      resolveCredentialValue: () => credential,
    });
    deps.resolveLocalSwitchRuntime = () => ({
      endpointUrl: binding.endpointUrl,
      credentialValue: credential,
      authMode: "authenticated",
      ownedProxy: false,
    });
    const list = vi.spyOn(deps.providerAdapter, "listProviders").mockResolvedValue({
      ok: true,
      value: { names: [receipt.providerName] },
    });
    const result = await runInferenceSet(
      { provider: "team-router", model: "new-router-model", sandboxName: "alpha" },
      deps,
    );
    expect(result.provider).toBe("team-router");
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        provider: "team-router",
        model: "new-router-model",
        nativeLocalProviderAttachment: receipt,
      }),
    );
    expect(list).not.toHaveBeenCalled();
    await expect(
      runInferenceSet(
        { provider: "unconfigured-router", model: "new-router-model", sandboxName: "alpha" },
        deps,
      ),
    ).rejects.toThrow("Unsupported provider");
  });

  it("rejects Model Router endpoint overrides before touching provider state", async () => {
    const deps = fixture();
    const create = vi.spyOn(deps.providerAdapter, "createProvider");
    await expect(
      runInferenceSet(
        {
          provider: "nvidia-router",
          model: "nvidia-routed",
          sandboxName: "alpha",
          endpointUrl: "http://host.openshell.internal:8080/v1",
          credentialEnv: "OTHER_KEY",
          inferenceApi: "openai-completions",
        },
        deps,
      ),
    ).rejects.toThrow("Model Router uses its configured endpoint");
    expect(create).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("reuses the verified native NIM provider without preparing managed vLLM", async () => {
    const receipt = nativeLocalTestReceipt("vllm-local", "http://host.openshell.internal:8000/v1", {
      agent: "openclaw",
      authMode: "sentinel",
    });
    const entry = {
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      provider: "vllm-local",
      model: "served-nim-model",
      nimContainer: "owned-nim",
      endpointUrl: receipt.endpointUrl,
      nativeLocalProviderAttachment: receipt,
    };
    const deps = createDeps({ config: {}, entry });
    await expect(
      resolveOpenClawLocalSwitch({
        agentName: "openclaw",
        entry,
        provider: "vllm-local",
        sandboxName: "alpha",
        gatewayName: "nemoclaw",
        deps,
      }),
    ).resolves.toEqual({ selected: receipt, previous: receipt });
  });

  it("detaches and retires local authority before publishing a hosted selection", async () => {
    const deps = fixture();
    deps.resolveCredentialValue = () => "test-hosted-secret";
    const detach = vi.spyOn(deps.providerAdapter, "detachProvider");
    const deletion = vi.spyOn(deps.providerAdapter, "deleteProvider");
    await runInferenceSet(
      {
        provider: "openai-api",
        model: "routed-model",
        sandboxName: "alpha",
      },
      deps,
    );
    expect(detach).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxName: "alpha",
        providerName: attachment.providerName,
      }),
    );
    expect(deletion).toHaveBeenCalled();
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        provider: "openai-api",
        nativeLocalProviderAttachment: undefined,
      }),
    );
    expect(deps.calls.clearNativeLocalProviderAuthority).toHaveBeenCalledWith(attachment);
  });

  it("preserves the switch failure when restoring local access also fails", async () => {
    const deps = fixture();
    deps.resolveCredentialValue = () => "test-hosted-secret";
    deps.calls.updateSandbox.mockReturnValue(false);
    const attachProvider = deps.providerAdapter.attachProvider.bind(deps.providerAdapter);
    vi.spyOn(deps.providerAdapter, "attachProvider").mockImplementation((request) =>
      request.providerName === attachment.providerName
        ? Promise.resolve({
            ok: false,
            error: { kind: "command", reason: "failed", message: "reattach rejected" },
          })
        : attachProvider(request),
    );
    await expect(
      runInferenceSet(
        { provider: "openai-api", model: "routed-model", sandboxName: "alpha" },
        deps,
      ),
    ).rejects.toThrow(/Failed to update NemoClaw registry.*restoring.*reattach rejected/s);
    expect(deps.calls.clearNativeLocalProviderAuthority).not.toHaveBeenCalled();
  });

  it("reselects the same Ollama endpoint with the dual-stack profile (#13544)", async () => {
    const previous = { ...attachment, ...nativeLocalIdentity(attachment, 1) };
    const { deps, next, isAttached } = switchingFixture(
      { provider: "ollama-local", endpointUrl: previous.endpointUrl },
      [previous, undefined, undefined, previous],
    );
    await expect(
      runInferenceSet({ provider: "ollama-local", model: "old-model", sandboxName: "alpha" }, deps),
    ).resolves.toMatchObject({ provider: "ollama-local" });
    expect(isAttached()).toBe(true);
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ nativeLocalProviderAttachment: next }),
    );
    expect(deps.calls.clearNativeLocalProviderAuthority).toHaveBeenCalledWith(previous);
  });

  it("restores the IPv4 attachment when dual-stack selection cannot save the registry (#13544)", async () => {
    const previous = { ...attachment, ...nativeLocalIdentity(attachment, 1) };
    const { deps, isAttached } = switchingFixture(
      { provider: "ollama-local", endpointUrl: previous.endpointUrl },
      [previous, undefined, undefined, previous],
    );
    deps.calls.updateSandbox.mockReturnValue(false);
    await expect(
      runInferenceSet({ provider: "ollama-local", model: "old-model", sandboxName: "alpha" }, deps),
    ).rejects.toThrow(/Failed to update NemoClaw registry/);
    expect(isAttached()).toBe(false);
    expect(
      await deps.providerAdapter.listProviderAttachments({
        target: { kind: "named", gatewayName: "nemoclaw" },
        sandboxName: "alpha",
      }),
    ).toMatchObject({ ok: true, value: { names: [previous.providerName] } });
    expect(deps.calls.clearNativeLocalProviderAuthority).not.toHaveBeenCalledWith(previous);
  });

  it("switches from Ollama to another local provider without changing the shared route", async () => {
    const { deps } = switchingFixture();
    await expect(
      runInferenceSet(
        {
          provider: "vllm-local",
          model: "new-model",
          sandboxName: "alpha",
        },
        deps,
      ),
    ).resolves.toMatchObject({ provider: "vllm-local" });
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        provider: "vllm-local",
        nativeLocalProviderAttachment: expect.objectContaining({
          agent: "openclaw",
          provider: "vllm-local",
          sandboxName: "alpha",
          gatewayName: "nemoclaw",
        }),
      }),
    );
    expect(deps.calls.clearNativeLocalProviderAuthority).toHaveBeenCalledWith(attachment);
    expect(
      deps.calls.captureOpenshell.mock.calls.some(
        ([args]) => Array.isArray(args) && args[0] === "inference" && args[1] === "set",
      ),
    ).toBe(false);
  });

  it.each([
    {
      stage: "attachment",
      arrange: ({ deps, next }: ReturnType<typeof switchingFixture>) => {
        const attach = deps.providerAdapter.attachProvider;
        deps.providerAdapter.attachProvider = async (request) =>
          request.providerName === next.providerName
            ? {
                ok: false,
                error: { kind: "command", reason: "failed", message: "attachment rejected" },
              }
            : attach(request);
      },
    },
    {
      stage: "registry",
      arrange: ({ deps }: ReturnType<typeof switchingFixture>) => {
        deps.calls.updateSandbox.mockReturnValue(false);
      },
    },
  ])("restores the prior local route after $stage failure", async ({ stage, arrange }) => {
    const state = switchingFixture();
    const { deps, isPresent, isAttached } = state;
    arrange(state);
    await expect(
      runInferenceSet({ provider: "vllm-local", model: "new-model", sandboxName: "alpha" }, deps),
    ).rejects.toThrow(
      stage === "attachment" ? /attachment rejected/ : /Failed to update NemoClaw registry/,
    );
    expect(isPresent()).toBe(false);
    expect(isAttached()).toBe(false);
    const current = await deps.providerAdapter.listProviderAttachments({
      target: { kind: "named", gatewayName: "nemoclaw" },
      sandboxName: "alpha",
    });
    expect(current).toMatchObject({ ok: true, value: { names: [attachment.providerName] } });
    expect(deps.calls.clearNativeLocalProviderAuthority).not.toHaveBeenCalledWith(attachment);
  });

  it("restores prior access even when replacement retirement fails", async () => {
    const { deps, next } = switchingFixture();
    deps.calls.updateSandbox.mockReturnValue(false);
    vi.spyOn(deps.providerAdapter, "deleteProvider").mockResolvedValue({
      ok: false,
      error: { kind: "command", reason: "failed", message: "retirement rejected" },
    });
    await expect(
      runInferenceSet({ provider: "vllm-local", model: "new-model", sandboxName: "alpha" }, deps),
    ).rejects.toThrow(/Failed to update NemoClaw registry.*removal was not confirmed/s);
    expect(
      await deps.providerAdapter.listProviderAttachments({
        target: { kind: "named", gatewayName: "nemoclaw" },
        sandboxName: "alpha",
      }),
    ).toMatchObject({ ok: true, value: { names: [attachment.providerName] } });
    expect(deps.getNativeLocalProviderAuthority?.(next.providerName)).toEqual(next);
    expect(deps.calls.clearNativeLocalProviderAuthority).not.toHaveBeenCalled();
  });

  it("identifies both retained providers when cleanup and restoration fail", async () => {
    const { deps, next } = switchingFixture();
    deps.calls.updateSandbox.mockReturnValue(false);
    vi.spyOn(deps.providerAdapter, "deleteProvider").mockResolvedValue({
      ok: false,
      error: { kind: "command", reason: "failed", message: "retirement rejected" },
    });
    const attach = deps.providerAdapter.attachProvider;
    vi.spyOn(deps.providerAdapter, "attachProvider").mockImplementation(async (request) =>
      request.providerName === attachment.providerName
        ? {
            ok: false,
            error: { kind: "command", reason: "failed", message: "restoration rejected" },
          }
        : attach(request),
    );
    const result = runInferenceSet(
      { provider: "vllm-local", model: "new-model", sandboxName: "alpha" },
      deps,
    );
    await expect(result).rejects.toThrow(/removal was not confirmed.*restoration rejected/s);
    await expect(result).rejects.toThrow(attachment.providerName);
    await expect(result).rejects.toThrow(next.providerName);
    expect(deps.getNativeLocalProviderAuthority?.(next.providerName)).toEqual(next);
    expect(deps.calls.clearNativeLocalProviderAuthority).not.toHaveBeenCalled();
  });

  it("changes the selected model without touching the shared gateway route", async () => {
    const deps = fixture();
    deps.resolveCredentialValue = () => "test-hosted-secret";
    const result = await runInferenceSet(
      {
        provider: "ollama-local",
        model: "new-model",
        sandboxName: "alpha",
      },
      deps,
    );
    expect(result.provider).toBe("ollama-local");
    expect(deps.calls.probeSandboxRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        nativeProvider: true,
        nativeLocalProviderAttachment: attachment,
        agentName: "openclaw",
        model: "new-model",
      }),
    );
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        model: "new-model",
        nativeLocalProviderAttachment: attachment,
      }),
    );
    expect(deps.calls.setOpenClawConfigValues).toHaveBeenCalled();
    expect(deps.calls.restartSandboxGateway).toHaveBeenCalled();
    expect(
      deps.calls.captureOpenshell.mock.calls.some(
        ([args]) => Array.isArray(args) && args[0] === "inference" && args[1] === "set",
      ),
    ).toBe(false);
  });

  it("retries exact provider retirement after a committed route switch", async () => {
    const deps = fixture();
    deps.resolveCredentialValue = () => "test-hosted-secret";
    let pending = true;
    const originalDelete = deps.providerAdapter.deleteProvider.bind(deps.providerAdapter);
    vi.spyOn(deps.providerAdapter, "deleteProvider").mockImplementation(async (request) =>
      pending
        ? { ok: false, error: { kind: "command", reason: "attached", message: "attached" } }
        : originalDelete(request),
    );
    deps.listNativeLocalProviderAuthorities = () => [attachment];
    await expect(
      runInferenceSet(
        { provider: "openai-api", model: "routed-model", sandboxName: "alpha" },
        deps,
      ),
    ).rejects.toThrow(/retry inference set/);
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ nativeLocalProviderAttachment: undefined }),
    );
    expect(deps.calls.clearNativeLocalProviderAuthority).not.toHaveBeenCalled();

    pending = false;
    const committed = deps.calls.updateSandbox.mock.calls.at(-1)?.[1];
    deps.getSandbox = () => ({
      ...committed,
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      provider: "openai-api",
      model: "routed-model",
    });
    await runInferenceSet(
      { provider: "openai-api", model: "routed-model", sandboxName: "alpha" },
      deps,
    );
    expect(deps.calls.clearNativeLocalProviderAuthority).toHaveBeenCalledWith(attachment);
  });

  it("rejects a conflicting gateway identity before retiring pending local authority", async () => {
    const pendingBinding = { ...attachment, gatewayName: "nemoclaw-18080" };
    const pending = { ...pendingBinding, ...nativeLocalIdentity(pendingBinding) };
    const deps = fixture(pending);
    const entry = deps.getSandbox("alpha")!;
    entry.gatewayName = "nemoclaw-18081";
    entry.gatewayPort = 18080;
    entry.nativeLocalProviderAttachment = undefined;
    deps.listNativeLocalProviderAuthorities = () => [pending];
    const detach = vi.spyOn(deps.providerAdapter, "detachProvider");
    const deletion = vi.spyOn(deps.providerAdapter, "deleteProvider");

    await expect(
      runInferenceSet(
        { provider: "nvidia-router", model: "routed-model", sandboxName: "alpha" },
        deps,
      ),
    ).rejects.toThrow(/conflicting gateway identity/);
    expect(detach).not.toHaveBeenCalled();
    expect(deletion).not.toHaveBeenCalled();
    expect(deps.calls.clearNativeLocalProviderAuthority).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });
});

it.each([
  { api: "openai-completions" as const, port: 8000 },
  { api: "openai-responses" as const, port: 8000 },
  { api: "openai-completions" as const, port: 42103 },
  { api: "openai-responses" as const, port: 42103 },
])(
  "switches OpenClaw to a compatible native $api endpoint on port $port without shared route commands",
  async ({ api, port }) => {
    const { deps } = switchingFixture({
      provider: "compatible-endpoint",
      authMode: "authenticated",
      endpointUrl: `http://host.openshell.internal:${port}/v1`,
      ...(api === "openai-responses" ? { api } : {}),
    });
    deps.calls.resolveCredentialValue.mockReturnValue("fixture-only-host-key");
    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "served-alias",
          sandboxName: "alpha",
          endpointUrl: `http://host.openshell.internal:${port}/v1`,
          credentialEnv: "COMPATIBLE_API_KEY",
          inferenceApi: api,
        },
        deps,
      ),
    ).resolves.toMatchObject({ provider: "compatible-endpoint" });
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        preferredInferenceApi: api,
        nativeLocalProviderAttachment: expect.objectContaining({
          provider: "compatible-endpoint",
          agent: "openclaw",
          endpointUrl: `http://host.openshell.internal:${port}/v1`,
        }),
      }),
    );
    expect(deps.calls.resolveCredentialValue).toHaveBeenCalledWith("COMPATIBLE_API_KEY");
    expect(
      deps.calls.captureOpenshell.mock.calls.some(
        ([args]) => Array.isArray(args) && args[0] === "inference",
      ),
    ).toBe(false);
  },
);

it("restores the prior local attachment when a compatible Responses switch cannot publish its registry", async () => {
  const { deps, isPresent, isAttached } = switchingFixture({
    provider: "compatible-endpoint",
    authMode: "authenticated",
    api: "openai-responses",
  });
  deps.calls.resolveCredentialValue.mockReturnValue("fixture-only-host-key");
  deps.calls.updateSandbox.mockReturnValue(false);
  await expect(
    runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "served-alias",
        sandboxName: "alpha",
        endpointUrl: "http://host.openshell.internal:8000/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        inferenceApi: "openai-responses",
      },
      deps,
    ),
  ).rejects.toThrow(/Failed to update NemoClaw registry/);
  expect({ present: isPresent(), attached: isAttached() }).toEqual({
    present: false,
    attached: false,
  });
  expect(
    await deps.providerAdapter.listProviderAttachments({
      target: { kind: "named", gatewayName: "nemoclaw" },
      sandboxName: "alpha",
    }),
  ).toMatchObject({ ok: true, value: { names: [attachment.providerName] } });
});

it.each([
  { api: "openai-completions" as const, explicit: false },
  { api: "openai-responses" as const, explicit: true },
])(
  "reuses an owned no-auth compatible $api proxy when explicit endpoint is $explicit",
  async ({ api, explicit }) => {
    const deps = fixture(
      {
        provider: "compatible-endpoint",
        authMode: "authenticated",
        ...(api === "openai-responses" ? { api } : {}),
      },
      "NEMOCLAW_OLLAMA_PROXY_TOKEN",
      "http://127.0.0.1:8000/v1",
    );
    const prior = deps.getSandbox("alpha")!.nativeLocalProviderAttachment;
    const create = vi.spyOn(deps.providerAdapter, "createProvider");
    await runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "new-model",
        sandboxName: "alpha",
        ...(explicit ? { endpointUrl: "http://127.0.0.1:8000/v1/" } : {}),
      },
      deps,
    );
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        nativeLocalProviderAttachment: prior,
        preferredInferenceApi: api,
        credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
      }),
    );
    expect(deps.calls.probeSandboxRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        nativeEndpointUrl: "http://host.openshell.internal:11435/v1",
        nativeProvider: true,
      }),
    );
    expect(create).not.toHaveBeenCalled();
    expect(
      deps.calls.captureOpenshell.mock.calls.some(
        ([args]) => Array.isArray(args) && args[0] === "inference",
      ),
    ).toBe(false);
  },
);

it("changes a no-auth compatible API through the existing owned proxy", async () => {
  const { deps, next } = switchingFixture(
    {
      provider: "compatible-endpoint",
      endpointUrl: "http://host.openshell.internal:11435/v1",
      authMode: "authenticated",
      api: "openai-responses",
    },
    [
      { provider: "compatible-endpoint", authMode: "authenticated" },
      "NEMOCLAW_OLLAMA_PROXY_TOKEN",
      "http://127.0.0.1:8000/v1",
    ],
  );
  deps.calls.resolveCredentialValue.mockReturnValue("fixture-only-proxy-token");
  await runInferenceSet(
    {
      provider: "compatible-endpoint",
      model: "new-model",
      sandboxName: "alpha",
      endpointUrl: "http://127.0.0.1:8000/v1",
      inferenceApi: "openai-responses",
    },
    deps,
  );
  expect(deps.calls.resolveCredentialValue).toHaveBeenCalledWith("NEMOCLAW_OLLAMA_PROXY_TOKEN");
  expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
    "alpha",
    expect.objectContaining({
      nativeLocalProviderAttachment: next,
      endpointUrl: "http://127.0.0.1:8000/v1",
      credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
      preferredInferenceApi: "openai-responses",
    }),
  );
});

it("rejects a recorded compatible API mismatch before changing sandbox state", async () => {
  const deps = fixture(
    {
      provider: "compatible-endpoint",
      endpointUrl: "http://host.openshell.internal:8000/v1",
      authMode: "authenticated",
      api: "openai-responses",
    },
    "COMPATIBLE_API_KEY",
  );
  const entry = deps.getSandbox("alpha")!;
  deps.getSandbox = () => ({ ...entry, preferredInferenceApi: "openai-completions" });
  await expect(
    runInferenceSet(
      { provider: "compatible-endpoint", model: "new-model", sandboxName: "alpha" },
      deps,
    ),
  ).rejects.toThrow(/API or endpoint does not match/);
  expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  expect(deps.calls.setOpenClawConfigValues).not.toHaveBeenCalled();
});

it.each(["http://127.0.0.1:11434/v1", "http://127.0.0.1:8000/other", "http://localhost:8000/v1"])(
  "rejects a different no-auth backend %s before native mutation",
  async (endpointUrl) => {
    const deps = fixture(
      { provider: "compatible-endpoint", authMode: "authenticated" },
      "NEMOCLAW_OLLAMA_PROXY_TOKEN",
      "http://127.0.0.1:8000/v1",
    );
    const create = vi.spyOn(deps.providerAdapter, "createProvider");
    const detach = vi.spyOn(deps.providerAdapter, "detachProvider");
    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "new-model",
          sandboxName: "alpha",
          endpointUrl,
          inferenceApi: "openai-responses",
        },
        deps,
      ),
    ).rejects.toThrow(/no-auth proxy is bound to the recorded backend/);
    expect(create).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.setOpenClawConfigValues).not.toHaveBeenCalled();
    expect(deps.calls.probeSandboxRoute).not.toHaveBeenCalled();
  },
);

it.each([8080, 4000])(
  "rejects a compatible switch to reserved control port %s before mutation",
  async (port) => {
    const { deps } = switchingFixture({
      provider: "compatible-endpoint",
      authMode: "authenticated",
      endpointUrl: `http://host.openshell.internal:${port}/v1`,
    });
    const create = vi.spyOn(deps.providerAdapter, "createProvider");
    const detach = vi.spyOn(deps.providerAdapter, "detachProvider");
    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "served-alias",
          sandboxName: "alpha",
          endpointUrl: `http://host.openshell.internal:${port}/v1`,
          credentialEnv: "COMPATIBLE_API_KEY",
          inferenceApi: "openai-completions",
        },
        deps,
      ),
    ).rejects.toThrow(/protected host port/);
    expect(create).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "migrates a retained compatible profile with owned proxy=%s",
  async (ownedProxy) => {
    const selected = {
      ...attachment,
      provider: "compatible-endpoint" as const,
      endpointUrl: ownedProxy
        ? "http://host.openshell.internal:11435/v1"
        : "http://host.openshell.internal:42103/v1",
      authMode: "authenticated" as const,
      api: "openai-responses" as const,
    };
    const previous = { ...selected, ...nativeLocalIdentity(selected, 1) };
    const credentialEnv = ownedProxy ? "NEMOCLAW_OLLAMA_PROXY_TOKEN" : "COMPATIBLE_API_KEY";
    const endpointUrl = ownedProxy ? "http://127.0.0.1:8000/v1" : selected.endpointUrl;
    const { deps, next } = switchingFixture(selected, [
      selected,
      credentialEnv,
      endpointUrl,
      previous,
    ]);
    deps.calls.resolveCredentialValue.mockReturnValue("fixture-only-secret");
    await runInferenceSet(
      { provider: selected.provider, model: "old-model", sandboxName: "alpha" },
      deps,
    );
    expect(deps.calls.resolveCredentialValue).toHaveBeenCalledWith(credentialEnv);
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ nativeLocalProviderAttachment: next, endpointUrl }),
    );
  },
);
