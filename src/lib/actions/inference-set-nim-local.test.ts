// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  createDeps,
  baseSession,
  nativeLocalTestReceipt,
  HERMES_TARGET,
  OPENCLAW_TARGET,
} from "../../../test/helpers/inference-set";
import * as local from "../inference/local";
import * as nim from "../inference/nim";
import { fixedNativeProvider } from "../inference/native-provider/fixed";
import type { NativeLocalProviderAttachment } from "../inference/native-local/contract";
import type { SandboxEntry } from "../state/registry";
import type { ConfigObject } from "../security/credential-filter";
import { applyHermesManagedRoute } from "../hermes-managed-route";
import { runInferenceSet } from "./inference-set";
import { resolveLocalSwitchRuntime } from "./inference-set/local-runtime";
import { prepareNativeLocalSwitch } from "./inference/native-local";

vi.mock("../adapters/openshell/provider-policy", () => ({
  requireNativeProviderPolicy: vi.fn(async () => {}),
}));

const MODEL = "local/nim-model";
const hosted = fixedNativeProvider("nvidia-prod")!;
const selected = { provider: "vllm-local", model: MODEL, sandboxName: "alpha" };

function fixture(
  agent: "openclaw" | "hermes",
  managedState: "conflicting" | "unreadable" = "conflicting",
) {
  const receipt = nativeLocalTestReceipt("vllm-local", nim.getNimInferenceEndpoints().baseUrl, {
    agent,
    authMode: "sentinel",
  });
  const entry: SandboxEntry = {
    name: "alpha",
    agent,
    gatewayName: "nemoclaw",
    provider: "vllm-local",
    model: MODEL,
    endpointUrl: receipt.endpointUrl,
    preferredInferenceApi: "openai-completions",
    credentialEnv: null,
    nimContainer: "nemoclaw-nim-alpha",
    nativeLocalProviderAttachment: receipt,
  };
  const config: ConfigObject =
    agent === "openclaw"
      ? {
          agents: { defaults: { model: { primary: `inference/${MODEL}` } } },
          models: {
            providers: {
              inference: {
                baseUrl: receipt.endpointUrl,
                apiKey: "openshell:resolve:env:NEMOCLAW_LOCAL_INFERENCE_TOKEN",
                api: "openai-completions",
                models: [{ id: MODEL }],
              },
            },
          },
        }
      : {};
  const configure = {
    openclaw: () => {},
    hermes: () =>
      applyHermesManagedRoute(config, {
        upstreamProvider: "vllm-local",
        baseUrl: receipt.endpointUrl,
        model: MODEL,
        inferenceApi: "openai-completions",
        nativeCredentialHandle: "openshell:resolve:env:v1_NEMOCLAW_LOCAL_INFERENCE_TOKEN",
      }),
  };
  configure[agent]();
  const session = baseSession({ ...entry, agent, credentialEnv: null });
  const deps = createDeps({
    config,
    entry,
    session: structuredClone(session),
    target: agent === "openclaw" ? OPENCLAW_TARGET : HERMES_TARGET,
    updateSandbox: (_name, updates) => {
      Object.assign(entry, updates);
      return true;
    },
  });
  const managed = vi.spyOn(local, "getManagedVllmProviderBinding");
  const arrange = {
    conflicting: () =>
      managed.mockReturnValue({
        baseUrl: "http://host.openshell.internal:18000/v1",
        apiKey: "unrelated-managed-secret",
      }),
    unreadable: () =>
      managed.mockImplementation(() => {
        throw new Error("unreadable unrelated managed state");
      }),
  };
  arrange[managedState]();
  const servedModel = vi.spyOn(nim, "getServedModelId").mockReturnValue(MODEL);
  vi.spyOn(nim, "getNimContextWindow").mockReturnValue(65536);
  vi.stubEnv("NGC_API_KEY", "host-ngc-secret");
  deps.calls.validateLocalProvider.mockImplementation(() => {
    throw new Error("generic vLLM validation must not inspect NIM");
  });
  deps.calls.ensureLocalProviderReachable.mockImplementation(() => {
    throw new Error("generic vLLM health must not inspect NIM");
  });
  const authorities = new Map<string, NativeLocalProviderAttachment>([
    [receipt.providerName, receipt],
  ]);
  deps.getNativeLocalProviderAuthority = (name) => authorities.get(name);
  deps.setNativeLocalProviderAuthority = (value) => {
    authorities.set(value.providerName, value);
  };
  deps.clearNativeLocalProviderAuthority = (value) => {
    authorities.delete(value.providerName);
  };
  deps.resolveLocalSwitchRuntime = resolveLocalSwitchRuntime;
  deps.prepareNativeLocalSwitch = prepareNativeLocalSwitch;
  const inspect = deps.providerAdapter.inspectProviderProfile;
  deps.providerAdapter.inspectProviderProfile = async (request) =>
    request.profileType === hosted.profileId
      ? { ok: true, value: { credentialKeys: [hosted.credentialEnv] } }
      : inspect(request);
  vi.spyOn(deps.providerAdapter, "importProviderProfile").mockResolvedValue({ ok: true });
  const create = vi.spyOn(deps.providerAdapter, "createProvider");
  const update = vi.spyOn(deps.providerAdapter, "updateProvider");
  return { deps, entry, receipt, session, config, managed, servedModel, create, update };
}

describe.each(["openclaw", "hermes"] as const)("%s NIM inference set", (agent) => {
  it.each(["nim", "nim-local", "nim_local"])(
    "selects the recorded native NIM route through alias %s",
    async (provider) => {
      const f = fixture(agent, "unreadable");
      await expect(runInferenceSet({ ...selected, provider }, f.deps)).resolves.toMatchObject({
        provider: "vllm-local",
      });
      expect(f.entry.nativeLocalProviderAttachment).toEqual(f.receipt);
      expect(f.deps.calls.probeSandboxRoute).toHaveBeenCalledWith(
        expect.objectContaining({ nativeEndpointUrl: f.receipt.endpointUrl }),
      );
      expect(f.managed).not.toHaveBeenCalled();
      expect(
        f.deps.calls.captureOpenshell.mock.calls.filter(([args]) => args[0] === "inference"),
      ).toEqual([]);
    },
  );

  it.each(["nvidia-nim", "nvidia_nim"])(
    "selects native NVIDIA Endpoints through legacy hosted alias %s",
    async (provider) => {
      const f = fixture(agent);
      await expect(
        runInferenceSet({ ...selected, provider, model: "hosted-model" }, f.deps),
      ).resolves.toMatchObject({ provider: "nvidia-prod" });
      expect(f.entry).toMatchObject({
        provider: "nvidia-prod",
        nativeNvidiaProviderAttachment: { providerName: hosted.providerName },
      });
      expect(f.deps.calls.probeSandboxRoute).toHaveBeenCalledWith(
        expect.objectContaining({ nativeProvider: true, provider: "nvidia-prod" }),
      );
      expect(
        f.deps.calls.captureOpenshell.mock.calls.filter(([args]) => args[0] === "inference"),
      ).toEqual([]);
    },
  );

  it.each(["nim", "nim-local", "nim_local"])(
    "refuses local alias %s without its NIM record before shared route access or mutation",
    async (provider) => {
      const f = fixture(agent);
      f.entry.nimContainer = null;
      f.deps.loadSession = () => null;
      await expect(runInferenceSet({ ...selected, provider }, f.deps)).rejects.toThrow(
        "Local NVIDIA NIM requires its recorded container and endpoint",
      );
      expect(f.create).not.toHaveBeenCalled();
      expect(f.update).not.toHaveBeenCalled();
      expect(f.deps.calls.updateSandbox).not.toHaveBeenCalled();
      expect(f.deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
      expect(
        f.deps.calls.captureOpenshell.mock.calls.filter(([args]) => args[0] === "inference"),
      ).toEqual([]);
      expect(f.managed).not.toHaveBeenCalled();
    },
  );

  it.each(["conflicting", "unreadable"] as const)(
    "reuses NIM with %s managed vLLM state",
    async (managedState) => {
      const f = fixture(agent, managedState);
      await expect(runInferenceSet(selected, f.deps)).resolves.toMatchObject({
        provider: "vllm-local",
      });
      expect(f.entry).toMatchObject({
        nimContainer: "nemoclaw-nim-alpha",
        endpointUrl: f.receipt.endpointUrl,
        nativeLocalProviderAttachment: f.receipt,
      });
      expect(f.servedModel).toHaveBeenCalledOnce();
      expect(f.managed).not.toHaveBeenCalled();
      expect(f.deps.calls.resolveContextWindowForModel).not.toHaveBeenCalledWith(
        "vllm-local",
        MODEL,
      );
      expect(f.deps.calls.log).toHaveBeenCalledWith(
        `  Context window for '${MODEL}': 65536 tokens`,
      );
      expect(f.deps.calls.validateLocalProvider).not.toHaveBeenCalled();
      expect(f.deps.calls.ensureLocalProviderReachable).not.toHaveBeenCalled();
      expect(f.create).not.toHaveBeenCalled();
      expect(f.deps.calls.probeSandboxRoute).toHaveBeenCalledWith(
        expect.objectContaining({ nativeEndpointUrl: f.receipt.endpointUrl }),
      );
    },
  );

  it.each([
    { managedState: "conflicting", provider: "vllm-local" },
    { managedState: "unreadable", provider: "vllm-local" },
    { managedState: "conflicting", provider: "nim" },
    { managedState: "unreadable", provider: "nim-local" },
    { managedState: "unreadable", provider: "nim_local" },
  ] as const)(
    "restores NIM through $provider from its matching session with $managedState vLLM state",
    async ({ managedState, provider }) => {
      const f = fixture(agent, managedState);
      await runInferenceSet(
        { provider: "nvidia-prod", model: "hosted-model", sandboxName: "alpha" },
        f.deps,
      );
      expect(f.entry.nativeLocalProviderAttachment).toBeUndefined();
      expect(f.entry.nimContainer).toBeNull();
      // Restore the matching onboarding record, the existing authority for a provider switch back.
      f.deps.loadSession = () => f.session;
      await expect(runInferenceSet({ ...selected, provider }, f.deps)).resolves.toMatchObject({
        provider: "vllm-local",
      });
      expect(f.entry).toMatchObject({
        nimContainer: "nemoclaw-nim-alpha",
        endpointUrl: f.receipt.endpointUrl,
        nativeLocalProviderAttachment: expect.objectContaining({
          authMode: "sentinel",
          endpointUrl: f.receipt.endpointUrl,
        }),
      });
      const nativeWrites = [...f.create.mock.calls, ...f.update.mock.calls]
        .map(([request]) => request)
        .filter(
          (request) =>
            ("name" in request ? request.name : request.providerName) === f.receipt.providerName,
        );
      expect(nativeWrites).toContainEqual(
        expect.objectContaining({
          credentials: [{ name: "NEMOCLAW_LOCAL_INFERENCE_TOKEN", value: "dummy" }],
        }),
      );
      expect(f.managed).not.toHaveBeenCalled();
      expect(f.deps.calls.resolveContextWindowForModel).not.toHaveBeenCalledWith(
        "vllm-local",
        MODEL,
      );
      expect(f.deps.calls.log).toHaveBeenCalledWith(
        `  Context window for '${MODEL}': 65536 tokens`,
      );
      expect(f.deps.calls.validateLocalProvider).not.toHaveBeenCalled();
      expect(f.deps.calls.ensureLocalProviderReachable).not.toHaveBeenCalled();
      expect(
        f.deps.calls.captureOpenshell.mock.calls.some(
          ([args]) => args[0] === "inference" && args[1] === "set",
        ),
      ).toBe(false);
    },
  );

  it("refuses a local NIM alias when the retained session belongs to a different model", async () => {
    const f = fixture(agent);
    await runInferenceSet({ ...selected, provider: "nvidia-prod", model: "hosted-model" }, f.deps);
    f.deps.loadSession = () => ({ ...f.session, model: "other-nim-model" });
    vi.clearAllMocks();
    await expect(runInferenceSet({ ...selected, provider: "nim-local" }, f.deps)).rejects.toThrow(
      "Local NVIDIA NIM requires its recorded container and endpoint",
    );
    expect(f.create).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
    expect(f.deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(f.deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
    expect(f.deps.calls.probeSandboxRoute).not.toHaveBeenCalled();
    expect(
      f.deps.calls.captureOpenshell.mock.calls.filter(([args]) => args[0] === "inference"),
    ).toEqual([]);
  });

  it("rejects a different recorded NIM endpoint before probing or changing state", async () => {
    const f = fixture(agent);
    f.entry.endpointUrl = "http://host.openshell.internal:18000/v1";
    await expect(runInferenceSet(selected, f.deps)).rejects.toThrow(
      "recorded NIM route does not match",
    );
    expect(f.servedModel).not.toHaveBeenCalled();
    expect(f.managed).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it.each([null, "different-model"])(
    "rejects NIM serving %s before changing provider or config",
    async (served) => {
      const f = fixture(agent);
      f.servedModel.mockReturnValue(served);
      await expect(runInferenceSet(selected, f.deps)).rejects.toThrow(
        "NIM does not serve the selected model",
      );
      expect(f.deps.calls.updateSandbox).not.toHaveBeenCalled();
      expect(f.deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
      expect(f.deps.calls.setOpenClawConfigValues).not.toHaveBeenCalled();
      expect(f.create).not.toHaveBeenCalled();
      expect(f.managed).not.toHaveBeenCalled();
    },
  );
});
