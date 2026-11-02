// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { registeredInferenceFixture } from "../../../test/helpers/registered-inference";
import { createDeps, HERMES_TARGET, OPENCLAW_TARGET } from "../../../test/helpers/inference-set";
import { inspectInferenceProviderProfile } from "../adapters/openshell/provider-profile";
import type { ConfigObject } from "../security/credential-filter";
import type { SandboxEntry } from "../state/registry";
import { runInferenceSet, patchOpenClawInferenceConfig } from "./inference-set";

function fixture(agent = "openclaw", attached = false) {
  const f = registeredInferenceFixture(attached);
  const config: ConfigObject =
    agent === "hermes"
      ? { model: { default: "old-model", provider: "custom" } }
      : {
          agents: { defaults: { model: { primary: "inference/old-model" } } },
          models: { providers: {} },
        };
  const entry: SandboxEntry = {
    name: "alpha",
    agent,
    gatewayName: f.binding.gatewayName,
    provider: "nvidia-prod",
    model: "old-model",
  };
  const deps = createDeps({
    config,
    entry,
    providerAdapter: f.adapter,
    target: agent === "hermes" ? HERMES_TARGET : OPENCLAW_TARGET,
    updateSandbox: (_name, fields) => {
      Object.assign(entry, fields);
      return true;
    },
  });
  deps.readRegisteredInferenceCredentialHandle = vi.fn(async () => f.handle);
  const options = {
    provider: "native-extra",
    model: "vendor/model-b",
    endpointUrl: f.binding.endpointUrl,
    credentialEnv: f.binding.credentialEnv,
    inferenceApi: f.binding.inferenceApi,
  };
  return { ...f, deps, options, config, entry };
}

function collisionFixture() {
  const f = fixture("openclaw", true);
  f.profile.credentials[0].env_vars = ["NVIDIA_API_KEY"];
  const binding = {
    ...f.binding,
    credentialEnv: "NVIDIA_API_KEY",
    profileDigest: inspectInferenceProviderProfile(JSON.stringify(f.profile))!.digest,
    attachedBySelection: true,
  };
  Object.assign(f.entry, {
    provider: binding.providerName,
    endpointUrl: binding.endpointUrl,
    preferredInferenceApi: binding.inferenceApi,
    credentialEnv: binding.credentialEnv,
    registeredInferenceProviderAttachment: binding,
  });
  f.adapter.getProvider.mockImplementation(async () => ({
    ok: true,
    value: {
      name: binding.providerName,
      type: binding.profileId,
      credentialKeys: [binding.credentialEnv],
      configKeys: [],
      revision: { id: binding.providerId, resourceVersion: f.state.revision },
    },
  }));
  f.adapter.inspectProviderProfile.mockImplementation(async () => ({
    ok: true,
    value: {
      credentialKeys: [binding.credentialEnv],
      inference: inspectInferenceProviderProfile(JSON.stringify(f.profile))!,
    },
  }));
  const native = createDeps({ entry: f.entry, config: f.config });
  const adapter = native.providerAdapter;
  const events: string[] = [];
  f.deps.providerAdapter = {
    ...adapter,
    listProviders: f.adapter.listProviders,
    getProvider: async (request) =>
      request.providerName === binding.providerName
        ? f.adapter.getProvider()
        : adapter.getProvider(request),
    inspectProviderProfile: async (request) =>
      request.profileType === binding.profileId
        ? f.adapter.inspectProviderProfile()
        : adapter.inspectProviderProfile(request),
    listProviderAttachments: async (request) => {
      const owned = await adapter.listProviderAttachments(request);
      return owned.ok
        ? {
            ok: true,
            value: {
              names: [...owned.value.names, ...(f.state.attached ? [binding.providerName] : [])],
            },
          }
        : owned;
    },
    attachProvider: async (request) => {
      events.push(`attach:${request.providerName}`);
      const current = await f.deps.providerAdapter.listProviderAttachments(request);
      return current.ok && current.value.names.length > 0
        ? {
            ok: false,
            error: {
              kind: "command",
              reason: "conflict",
              message: "credential environment collision",
            },
          }
        : request.providerName === binding.providerName
          ? f.adapter.attachProvider()
          : adapter.attachProvider(request);
    },
    detachProvider: async (request) => {
      events.push(`detach:${request.providerName}`);
      return request.providerName === binding.providerName
        ? f.adapter.detachProvider()
        : adapter.detachProvider(request);
    },
  };
  f.deps.calls.probeSandboxRoute.mockResolvedValue({
    ok: false,
    httpStatus: 401,
    detail: "rejected",
  });
  return { ...f, binding, events };
}

describe("registered inference selection transaction", () => {
  it.each([
    {
      inventory: "missing",
      provider: "native-extra",
      list: async () => ({ ok: true as const, value: { names: [] } }),
    },
    {
      inventory: "messaging",
      provider: "alpha-telegram-bridge",
      list: async () => ({ ok: true as const, value: { names: ["alpha-telegram-bridge"] } }),
    },
    {
      inventory: "unavailable",
      provider: "native-extra",
      list: async () => {
        throw new Error("gateway unavailable");
      },
    },
  ])(
    "rejects a $inventory provider inventory before reading credentials or changing state",
    async ({ provider, list }) => {
      const f = fixture();
      f.adapter.listProviders.mockImplementation(list);
      await expect(runInferenceSet({ ...f.options, provider }, f.deps)).rejects.toThrow(
        `Unsupported provider '${provider}'`,
      );
      expect(f.adapter.listProviders).toHaveBeenCalledExactlyOnceWith({
        target: { kind: "named", gatewayName: f.binding.gatewayName },
        timeoutMs: 5_000,
      });
      expect(f.deps.readRegisteredInferenceCredentialHandle).not.toHaveBeenCalled();
      expect(f.adapter.attachProvider).not.toHaveBeenCalled();
      expect(f.adapter.detachProvider).not.toHaveBeenCalled();
      expect(f.deps.calls.updateSandbox).not.toHaveBeenCalled();
    },
  );

  it("preserves the recorded route and configuration when the operator provider was replaced", async () => {
    const f = fixture();
    await runInferenceSet(f.options, f.deps);
    const before = structuredClone({ entry: f.entry, config: f.config });
    f.state.id = "replacement-provider";
    vi.clearAllMocks();
    await expect(runInferenceSet(f.options, f.deps)).rejects.toThrow(
      "Recorded registered inference provider identity or profile changed",
    );
    expect({ entry: f.entry, config: f.config }).toEqual(before);
    expect(f.adapter.attachProvider).not.toHaveBeenCalled();
    expect(f.adapter.detachProvider).not.toHaveBeenCalled();
    expect(f.deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(f.deps.calls.setOpenClawConfigValues).not.toHaveBeenCalled();
    expect(f.deps.calls.probeSandboxRoute).not.toHaveBeenCalled();
    expect(f.deps.calls.restartSandboxGateway).not.toHaveBeenCalled();
  });

  it.each(["openclaw", "hermes"])(
    "attaches an explicit operator route for %s without shared inference mutation",
    async (agent) => {
      const f = fixture(agent);
      await expect(runInferenceSet(f.options, f.deps)).resolves.toMatchObject({
        provider: "native-extra",
        providerKey: "native-extra",
      });
      expect(f.entry.registeredInferenceProviderAttachment).toMatchObject({
        providerId: f.binding.providerId,
        attachedBySelection: true,
      });
      expect(f.deps.calls.captureOpenshell).not.toHaveBeenCalled();
      expect(f.adapter.attachProvider).toHaveBeenCalledOnce();
      expect(f.adapter.updateProvider).not.toHaveBeenCalled();
      expect(f.adapter.createProvider).not.toHaveBeenCalled();
      expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
      expect(f.deps.calls.restartSandboxGateway).toHaveBeenCalled();
    },
  );

  it("removes a failed owned selection before restoring a registered attachment with the same credential environment", async () => {
    const f = collisionFixture();
    await expect(
      runInferenceSet({ provider: "nvidia-prod", model: "vendor/model-b" }, f.deps),
    ).rejects.toThrow("rejected");
    expect(f.events).toEqual([
      "detach:native-extra",
      "attach:nemoclaw-nvidia-prod-v1",
      "detach:nemoclaw-nvidia-prod-v1",
      "attach:native-extra",
    ]);
    expect(f.state.attached).toBe(true);
    expect(f.deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("does not restore the registered attachment after uncertain owned cleanup", async () => {
    const f = collisionFixture();
    const detach = f.deps.providerAdapter.detachProvider;
    f.deps.providerAdapter.detachProvider = async (request) =>
      request.providerName === f.binding.providerName
        ? detach(request)
        : {
            ok: false,
            error: { kind: "command", reason: "uncertain", message: "detach response lost" },
          };
    await expect(
      runInferenceSet({ provider: "nvidia-prod", model: "vendor/model-b" }, f.deps),
    ).rejects.toThrow("did not confirm removal of native NVIDIA access");
    expect(f.events).toEqual(["detach:native-extra", "attach:nemoclaw-nvidia-prod-v1"]);
    expect(f.state.attached).toBe(false);
    expect(f.entry.registeredInferenceProviderAttachment).toEqual(f.binding);
    expect(f.deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("does not restore an owned provider when removing a new registered attachment is uncertain", async () => {
    const f = collisionFixture();
    f.deps.calls.probeSandboxRoute.mockResolvedValueOnce({
      ok: true,
      httpStatus: 200,
      detail: "ok",
    });
    await runInferenceSet({ provider: "nvidia-prod", model: "vendor/model-b" }, f.deps);
    const committed = f.entry.nativeNvidiaProviderAttachment;
    f.events.length = 0;
    f.deps.readRegisteredInferenceCredentialHandle = async () =>
      f.handle.replace("VENDOR_API_KEY", "NVIDIA_API_KEY");
    const detach = f.deps.providerAdapter.detachProvider;
    f.deps.providerAdapter.detachProvider = async (request) =>
      request.providerName === f.binding.providerName
        ? {
            ok: false,
            error: { kind: "command", reason: "uncertain", message: "detach response lost" },
          }
        : detach(request);
    await expect(
      runInferenceSet({ ...f.options, credentialEnv: "NVIDIA_API_KEY" }, f.deps),
    ).rejects.toThrow("attachment removal was not confirmed");
    expect(f.events).toEqual(["detach:nemoclaw-nvidia-prod-v1", "attach:native-extra"]);
    expect(f.state.attached).toBe(true);
    expect(f.entry.nativeNvidiaProviderAttachment).toEqual(committed);
    expect(f.entry.registeredInferenceProviderAttachment).toBeUndefined();
  });

  it("writes the selected Hermes native endpoint and scoped credential", async () => {
    const f = fixture("hermes");
    await runInferenceSet(f.options, f.deps);
    expect(f.config.model).toMatchObject({
      base_url: f.binding.endpointUrl,
      api_key: f.handle,
      default: f.options.model,
    });
  });

  it.each([
    ["endpoint", { endpointUrl: undefined }],
    ["API", { inferenceApi: undefined }],
    ["credential", { credentialEnv: undefined }],
  ])("refuses incomplete %s metadata before attachment", async (_label, change) => {
    const f = fixture();
    await expect(runInferenceSet({ ...f.options, ...change }, f.deps)).rejects.toThrow(
      "requires explicit",
    );
    expect(f.adapter.attachProvider).not.toHaveBeenCalled();
    expect(f.deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "preserves external provider and prior attachment after failed verification (already attached: %s)",
    async (attached) => {
      const f = fixture("openclaw", attached);
      f.deps.calls.probeSandboxRoute.mockResolvedValue({
        ok: false,
        httpStatus: 401,
        detail: "rejected",
      });
      await expect(runInferenceSet(f.options, f.deps)).rejects.toThrow();
      expect(f.state.attached).toBe(attached);
      expect(f.adapter.detachProvider).toHaveBeenCalledTimes(attached ? 0 : 1);
      expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
      expect(f.deps.calls.updateSandbox).not.toHaveBeenCalled();
      expect(f.deps.calls.setOpenClawConfigValues).not.toHaveBeenCalled();
    },
  );

  it("rejects provider changes during handle reading before publication", async () => {
    const f = fixture();
    f.deps.readRegisteredInferenceCredentialHandle = async () => {
      f.state.revision++;
      return f.handle;
    };
    await expect(runInferenceSet(f.options, f.deps)).rejects.toThrow("changed while reading");
    expect(f.state.attached).toBe(false);
    expect(f.deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("removes its new attachment when registry publication fails", async () => {
    const f = fixture();
    f.deps.calls.updateSandbox.mockReturnValue(false);
    await expect(runInferenceSet(f.options, f.deps)).rejects.toThrow("Failed to update");
    expect(f.state.attached).toBe(false);
    expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
  });

  it("retries a committed Hermes selection after its native configuration write fails", async () => {
    const f = fixture("hermes");
    const before = structuredClone(f.config);
    f.deps.calls.readSandboxConfig
      .mockReturnValueOnce(structuredClone(before))
      .mockReturnValueOnce(structuredClone(before));
    f.deps.calls.writeSandboxConfig.mockImplementationOnce(() => {
      throw new Error("config write unavailable");
    });
    await expect(runInferenceSet(f.options, f.deps)).rejects.toThrow(
      "Retry the same inference set command",
    );
    expect(f.entry.registeredInferenceProviderAttachment).toMatchObject({
      providerId: f.binding.providerId,
      attachedBySelection: true,
    });
    expect(f.deps.calls.log.mock.calls.flat().join("\n")).not.toContain("rebuild");
    await expect(
      runInferenceSet({ provider: f.options.provider, model: f.options.model }, f.deps),
    ).resolves.toMatchObject({ inSandboxConfigSynced: true });
    expect(f.adapter.attachProvider).toHaveBeenCalledOnce();
    expect(f.adapter.detachProvider).not.toHaveBeenCalled();
    expect(f.deps.calls.writeSandboxConfig).toHaveBeenCalledTimes(2);
    expect(f.deps.calls.restartSandboxGateway).toHaveBeenCalledOnce();
  });

  it("retries config publication from the immutable recorded binding without attaching again", async () => {
    const f = fixture();
    f.deps.calls.setOpenClawConfigValues.mockImplementationOnce(() => {
      throw new Error("config unavailable");
    });
    await expect(runInferenceSet(f.options, f.deps)).rejects.toThrow(
      "synchronization did not complete",
    );
    expect(f.state.attached).toBe(true);
    expect(f.entry.openClawConfigSyncPending).toBe(true);
    await expect(
      runInferenceSet({ provider: f.options.provider, model: f.options.model }, f.deps),
    ).resolves.toMatchObject({ inSandboxConfigSynced: true });
    expect(f.adapter.attachProvider).toHaveBeenCalledOnce();
    expect(f.adapter.detachProvider).not.toHaveBeenCalled();
    expect(f.entry.openClawConfigSyncPending).toBeUndefined();
  });
});

describe("registered OpenClaw native model configuration", () => {
  it("preserves the selected operator model's compatibility, params, and limits", () => {
    const f = fixture();
    const model = {
      id: "vendor/model-b",
      compat: { supportsStore: true },
      params: { extra_body: { reasoning_effort: "high", vendor_option: true } },
      contextWindow: 8192,
      maxTokens: 2048,
    };
    const config: ConfigObject = { models: { providers: { "native-extra": { models: [model] } } } };
    patchOpenClawInferenceConfig(
      config,
      "native-extra",
      model.id,
      f.binding.inferenceApi,
      null,
      undefined,
      undefined,
      false,
      f.binding.endpointUrl,
      true,
      f.binding,
      f.handle,
    );
    expect(config.models).toMatchObject({
      providers: {
        "native-extra": {
          apiKey: f.handle,
          baseUrl: f.binding.endpointUrl,
          models: [{ ...model, name: "native-extra/vendor/model-b" }],
        },
      },
    });
  });
});
