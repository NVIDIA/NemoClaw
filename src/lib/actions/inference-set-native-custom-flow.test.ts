// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import YAML from "yaml";
import { buildNativeCustomSandboxPolicy } from "../inference/native-custom/network-policy";
import type {
  OpenShellProviderAdapter,
  OpenShellProviderMetadata,
} from "../adapters/openshell/provider-adapter";
import {
  prepareNativeCustomProfile,
  customAttachmentFromPrepared,
  type NativeCustomProviderAttachment,
} from "../inference/native-custom";
import { runInferenceSet } from "./inference-set";
import { createDeps, HERMES_TARGET } from "./inference-set.test-support";

async function fixture(agent = "openclaw") {
  const prepared = await prepareNativeCustomProfile({
    sandboxName: "alpha",
    provider: "compatible-endpoint",
    endpointUrl: "http://8.8.8.8/v1",
    api: "openai-completions",
  });
  const receipt = customAttachmentFromPrepared(prepared, {
    schemaVersion: 1,
    profileId: prepared.profile.id,
    providerName: prepared.providerName,
    providerId: "old-provider",
  });
  const metadata = new Map<string, OpenShellProviderMetadata>([
    [
      receipt.providerName,
      {
        name: receipt.providerName,
        type: receipt.profileId,
        credentialKeys: [receipt.credentialEnv],
        configKeys: [],
        revision: { id: receipt.providerId, resourceVersion: 1 },
      },
    ],
  ]);
  const attachments = new Set([receipt.providerName]);
  const authority = new Map<string, NativeCustomProviderAttachment>([
    [receipt.providerName, receipt],
  ]);
  const events: string[] = [];
  const adapter = {
    importProviderProfile: vi.fn(async () => ({ ok: true })),
    ensureProviderPolicyComposition: vi.fn(async () => ({ ok: true })),
    getProvider: vi.fn(
      async ({ providerName }: Parameters<OpenShellProviderAdapter["getProvider"]>[0]) =>
        metadata.has(providerName)
          ? { ok: true, value: metadata.get(providerName)! }
          : { ok: false, error: { kind: "command", reason: "not_found", message: "missing" } },
    ),
    createProvider: vi.fn(
      async (request: Parameters<OpenShellProviderAdapter["createProvider"]>[0]) => {
        metadata.set(request.name, {
          name: request.name,
          type: request.type,
          credentialKeys: request.credentials.map((key) => key.name),
          configKeys: [],
          revision: { id: `id-${request.name}`, resourceVersion: 1 },
        });
        return { ok: true };
      },
    ),
    updateProvider: vi.fn(async () => ({ ok: true })),
    listProviderAttachments: vi.fn(async () => ({ ok: true, value: { names: [...attachments] } })),
    attachProvider: vi.fn(
      async (request: Parameters<OpenShellProviderAdapter["attachProvider"]>[0]) => {
        events.push(`attach:${request.providerName}`);
        attachments.add(request.providerName);
        return { ok: true };
      },
    ),
    detachProvider: vi.fn(
      async (request: Parameters<OpenShellProviderAdapter["detachProvider"]>[0]) => {
        events.push(`detach:${request.providerName}`);
        attachments.delete(request.providerName);
        return { ok: true, value: { changed: true } };
      },
    ),
  } as unknown as OpenShellProviderAdapter;
  const entry = {
    name: "alpha",
    agent,
    provider: "compatible-endpoint",
    model: "old-model",
    endpointUrl: prepared.endpointUrl,
    credentialEnv: receipt.credentialEnv,
    preferredInferenceApi: prepared.api,
    nativeCustomProviderAttachment: receipt,
    gatewayName: "nemoclaw",
    openshellDriver: "docker",
  };
  const config = {
    agents: { defaults: { model: { primary: "inference/old-model" } } },
    models: {
      providers: {
        inference: {
          baseUrl: prepared.endpointUrl,
          api: "openai-completions",
          apiKey: "openshell:resolve:env:v1_COMPATIBLE_API_KEY",
          models: [],
        },
      },
    },
    unrelated: { preserve: true },
  };
  const deps = createDeps({
    config,
    entry,
    providerAdapter: adapter,
    target: agent === "hermes" ? HERMES_TARGET : undefined,
    resolveCredentialValue: () => "host-secret",
    updateSandbox: (_name, patch) => {
      Object.assign(entry, patch);
      return true;
    },
  });
  deps.getNativeCustomProviderAuthority = (_gateway, name) => authority.get(name);
  deps.setNativeCustomProviderAuthority = (_gateway, value) => {
    events.push("persist");
    authority.set(value.providerName, value);
  };
  deps.resolveNativeCustomCredentialReference = vi.fn(
    async () => "openshell:resolve:env:v12_COMPATIBLE_API_KEY",
  );
  let policy = buildNativeCustomSandboxPolicy("version: 1\nnetwork_policies: {}\n", receipt);
  const reconcileNativeCustomSandboxPolicy = vi.fn(
    async (input: {
      previous?: NativeCustomProviderAttachment;
      next?: NativeCustomProviderAttachment;
    }) => {
      const before = policy;
      const parsed = YAML.parse(policy);
      delete parsed.network_policies.native_custom_inference;
      policy = input.next
        ? buildNativeCustomSandboxPolicy(YAML.stringify(parsed), input.next)
        : YAML.stringify(parsed);
      return async () => {
        policy = before;
      };
    },
  );
  Object.assign(deps, { reconcileNativeCustomSandboxPolicy });
  vi.spyOn(deps.inferenceRouteMutator, "setInferenceRoute");
  return {
    deps,
    receipt,
    entry,
    events,
    attachments,
    adapter,
    config,
    get policy() {
      return YAML.parse(policy);
    },
  };
}

it("switches a native custom model without rotating credentials or consulting shared inference (#12636)", async () => {
  const f = await fixture();
  const result = await runInferenceSet(
    { provider: "compatible-endpoint", model: "new-model" },
    f.deps,
  );
  expect(result.inSandboxConfigSynced).toBe(true);
  expect(f.adapter.updateProvider).not.toHaveBeenCalled();
  expect(f.adapter.createProvider).not.toHaveBeenCalled();
  expect(f.deps.inferenceRouteObserver.observeInferenceRoute).not.toHaveBeenCalled();
  expect(f.deps.inferenceRouteMutator.setInferenceRoute).not.toHaveBeenCalled();
  expect(f.deps.calls.probeSandboxRoute).toHaveBeenCalledWith(
    expect.objectContaining({ model: "new-model", nativeCustomProviderAttachment: f.receipt }),
  );
  expect(f.config.models.providers.inference).toMatchObject({
    baseUrl: "http://8.8.8.8/v1",
    apiKey: "openshell:resolve:env:v12_COMPATIBLE_API_KEY",
  });
  expect(f.config.unrelated).toEqual({ preserve: true });
});

it("detaches the prior native credential binding before attaching a different endpoint (#12636)", async () => {
  const f = await fixture();
  await runInferenceSet(
    {
      provider: "compatible-endpoint",
      model: "new-model",
      endpointUrl: "http://12.12.12.12/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      inferenceApi: "openai-completions",
    },
    f.deps,
  );
  const next = f.entry.nativeCustomProviderAttachment;
  expect(f.events.indexOf(`detach:${f.receipt.providerName}`)).toBeLessThan(
    f.events.indexOf(`attach:${next.providerName}`),
  );
  expect([...f.attachments]).toEqual([next.providerName]);
  expect(f.entry.endpointUrl).toBe("http://12.12.12.12/v1");
  expect(f.policy.network_policies.native_custom_inference.endpoints).toEqual(
    expect.arrayContaining([expect.objectContaining({ host: "12.12.12.12" })]),
  );
  expect(JSON.stringify(f.policy)).not.toContain("8.8.8.8");
  expect(JSON.stringify(f.entry)).not.toContain("host-secret");
});

it("restores the previous attachment when a native selected-model probe fails (#12636)", async () => {
  const f = await fixture();
  f.deps.calls.probeSandboxRoute.mockResolvedValue({
    ok: false,
    detail: "private upstream diagnostic",
    httpStatus: 401,
    endpoint: "selected",
  });
  await expect(
    runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "new-model",
        endpointUrl: "http://12.12.12.12/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        inferenceApi: "openai-completions",
      },
      f.deps,
    ),
  ).rejects.toThrow(/selected native custom model request/);
  expect([...f.attachments]).toEqual([f.receipt.providerName]);
  expect(f.entry.model).toBe("old-model");
  expect(f.deps.calls.setOpenClawConfigValues).not.toHaveBeenCalled();
});

it("writes matching issued Hermes references rather than the shared-route sentinel (#12636)", async () => {
  const f = await fixture("hermes");
  await runInferenceSet({ provider: "compatible-endpoint", model: "new-model" }, f.deps);
  const written = f.deps.calls.writeSandboxConfig.mock.calls[0][2];
  expect(written.model).toMatchObject({
    base_url: f.receipt.endpointUrl,
    api_key: "sk-OPENSHELL-RESOLVE-ENV-v12_COMPATIBLE_API_KEY",
  });
  expect(written.unrelated).toEqual({ preserve: true });
  expect(JSON.stringify(written)).not.toContain("host-secret");
});

it("observes an unchanged registry after a rejected write and restores only the prior attachment (#12636)", async () => {
  const f = await fixture();
  f.deps.calls.updateSandbox.mockReturnValueOnce(false);
  await expect(
    runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "new-model",
        endpointUrl: "http://12.12.12.12/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        inferenceApi: "openai-completions",
      },
      f.deps,
    ),
  ).rejects.toThrow(/could not be persisted/);
  expect([...f.attachments]).toEqual([f.receipt.providerName]);
  expect(f.entry.nativeCustomProviderAttachment).toEqual(f.receipt);
  expect(f.entry.model).toBe("old-model");
});

it("retains an observed registry commit after an uncertain write and lets the same command converge (#12636)", async () => {
  const f = await fixture();
  f.deps.calls.updateSandbox.mockImplementationOnce((_name, patch) => {
    Object.assign(f.entry, patch);
    throw new Error("private state diagnostic");
  });
  const options = {
    provider: "compatible-endpoint",
    model: "new-model",
    endpointUrl: "http://12.12.12.12/v1",
    credentialEnv: "COMPATIBLE_API_KEY",
    inferenceApi: "openai-completions",
  };
  await expect(runInferenceSet(options, f.deps)).rejects.toThrow(/synchronization is incomplete/);
  expect([...f.attachments]).toEqual([f.entry.nativeCustomProviderAttachment.providerName]);
  expect(f.entry.model).toBe("new-model");
  expect(
    await runInferenceSet({ provider: "compatible-endpoint", model: "new-model" }, f.deps),
  ).toMatchObject({ inSandboxConfigSynced: true });
});

it("removes native custom access before publishing a built-in provider (#12636)", async () => {
  const f = await fixture();
  await runInferenceSet({ provider: "openai", model: "gpt-4o" }, f.deps);
  expect(f.attachments.size).toBe(0);
  expect(f.entry.provider).toBe("openai-api");
  expect(f.entry.nativeCustomProviderAttachment).toBeUndefined();
  expect(f.policy.network_policies.native_custom_inference).toBeUndefined();
  expect(f.events).toContain(`detach:${f.receipt.providerName}`);
});

it("restores native custom access when departure publication is rejected (#12636)", async () => {
  const f = await fixture();
  f.deps.calls.updateSandbox.mockImplementation(() => false);
  await expect(runInferenceSet({ provider: "openai", model: "gpt-4o" }, f.deps)).rejects.toThrow();
  expect([...f.attachments]).toEqual([f.receipt.providerName]);
  expect(f.entry.nativeCustomProviderAttachment).toEqual(f.receipt);
  expect(f.events).toContain(`detach:${f.receipt.providerName}`);
  expect(f.events).toContain(`attach:${f.receipt.providerName}`);
});

it("selects the native OpenAI frontend for a new Hermes custom Anthropic switch (#12636)", async () => {
  const f = await fixture("hermes");
  Object.assign(f.entry, {
    provider: "hermes-provider",
    nativeCustomProviderAttachment: undefined,
  });
  f.attachments.clear();
  vi.mocked(f.deps.resolveNativeCustomCredentialReference!).mockResolvedValue(
    "openshell:resolve:env:v12_COMPATIBLE_ANTHROPIC_API_KEY",
  );
  await runInferenceSet(
    {
      provider: "compatible-anthropic-endpoint",
      model: "claude-model",
      endpointUrl: "http://12.12.12.12/v1",
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
    },
    f.deps,
  );
  expect(f.entry.preferredInferenceApi).toBe("openai-completions");
  expect(f.entry.nativeCustomProviderAttachment.api).toBe("openai-completions");
  expect(f.config).toMatchObject({
    model: {
      base_url: "http://12.12.12.12/v1",
      api_key: "sk-OPENSHELL-RESOLVE-ENV-v12_COMPATIBLE_ANTHROPIC_API_KEY",
    },
  });
  expect(f.deps.inferenceRouteObserver.observeInferenceRoute).not.toHaveBeenCalled();
  expect(f.deps.inferenceRouteMutator.setInferenceRoute).not.toHaveBeenCalled();
});

it("rejects an unverified custom policy update before attachment or publication (#12636)", async () => {
  const f = await fixture();
  f.deps.reconcileNativeCustomSandboxPolicy = vi.fn(async () => {
    throw new Error("policy update unconfirmed");
  });
  await expect(
    runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "new-model",
        endpointUrl: "http://12.12.12.12/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        inferenceApi: "openai-completions",
      },
      f.deps,
    ),
  ).rejects.toThrow(/policy update unconfirmed/);
  expect([...f.attachments]).toEqual([f.receipt.providerName]);
  expect(f.deps.calls.updateSandbox).not.toHaveBeenCalled();
  expect(f.deps.calls.probeSandboxRoute).not.toHaveBeenCalled();
});

it("keeps the previous custom policy when departure publication is rejected (#12636)", async () => {
  const f = await fixture();
  f.deps.calls.updateSandbox.mockReturnValueOnce(false);
  await expect(runInferenceSet({ provider: "openai", model: "gpt-4o" }, f.deps)).rejects.toThrow();
  expect(f.policy.network_policies.native_custom_inference.endpoints).toEqual(
    expect.arrayContaining([expect.objectContaining({ host: "8.8.8.8" })]),
  );
  expect([...f.attachments]).toEqual([f.receipt.providerName]);
});
