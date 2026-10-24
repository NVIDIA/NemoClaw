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
  it.each(["openclaw", "hermes"])(
    "rejects an unaccepted registered provider for %s before gateway mutation",
    async (agent) => {
      const f = fixture(agent);
      await expect(runInferenceSet(f.options, f.deps)).rejects.toThrow(
        "Unsupported provider 'native-extra'",
      );
      expect(f.adapter.listProviders).not.toHaveBeenCalled();
      expect(f.adapter.attachProvider).not.toHaveBeenCalled();
      expect(f.adapter.detachProvider).not.toHaveBeenCalled();
      expect(f.deps.calls.updateSandbox).not.toHaveBeenCalled();
      expect(f.deps.calls.captureOpenshell).not.toHaveBeenCalled();
    },
  );

  it("removes a failed owned selection before restoring a recorded registered attachment", async () => {
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

  it("does not restore a recorded attachment after uncertain owned cleanup", async () => {
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
