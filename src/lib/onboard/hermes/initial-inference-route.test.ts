// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { inspectInferenceProviderProfile } from "../../adapters/openshell/provider-profile";
import { registeredInferenceFixture } from "../../../../test/helpers/registered-inference";
import {
  readVerifiedRegisteredCredentialHandle,
  verifyRegisteredInferenceProviderAttachment,
} from "../../actions/inference-set/registered";
import { describe, expect, it, vi } from "vitest";
import { patchHermesInferenceConfig } from "../../actions/inference-set";
import { applyHermesManagedRoute } from "../../hermes-managed-route";
import { nativeLocalIdentity } from "../../inference/native-local/contract";
import { gatewayReachableCompatibleEndpointUrl } from "../inference-providers/compatible-endpoint-gateway-route";
import { hostLocalInferenceReceipt } from "../../../../test/helpers/host-local-inference-receipt";
import { serializeHostLocalInferenceReceipt } from "../runtime-provider/host-local-inference";
import type { ConfigObject } from "../../security/credential-filter";
import type { SandboxEntry } from "../../state/registry";
import {
  createInitialHermesInferenceRoute,
  type InitialHermesInferenceRouteDeps,
} from "./initial-inference-route";

const issued = (scope: string) => `openshell:resolve:env:${scope}_NEMOCLAW_LOCAL_INFERENCE_TOKEN`;
const digest = Symbol("matching read digest");

type MutableHermesConfig = ConfigObject & {
  model: ConfigObject;
  providers: Record<string, ConfigObject>;
  custom_providers: ConfigObject[];
};

function fixture(
  provider:
    | "compatible-endpoint"
    | "vllm-local"
    | "ollama-local"
    | "llama-cpp-local" = "compatible-endpoint",
  endpointUrl = "http://host.openshell.internal:8000/v1",
) {
  const binding = {
    provider,
    endpointUrl,
    credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
    authMode: "authenticated" as const,
    agent: "hermes" as const,
    gatewayName: "gateway-a",
    sandboxName: "alpha",
  };
  const receipt = {
    ...binding,
    ...nativeLocalIdentity(binding),
    schemaVersion: 1 as const,
    providerId: "provider-id",
  };
  const entry: SandboxEntry = {
    name: "alpha",
    agent: "hermes",
    gatewayName: "gateway-a",
    model: "selected-local-model",
    provider: receipt.provider,
    endpointUrl: receipt.endpointUrl,
    preferredInferenceApi: "openai-completions",
    nativeLocalProviderAttachment: receipt,
    workload: {
      schemaVersion: 1,
      kind: "external-image",
      reference: `example/hermes@sha256:${"a".repeat(64)}`,
      platform: "linux/amd64",
      runtimeImageContentId: `sha256:${"b".repeat(64)}`,
      shared: true,
    },
  };
  const config: ConfigObject = {
    mcp_servers: { example: { command: "example-mcp" } },
    display: { show_reasoning: false },
    providers: { unrelated: { api_key: "${UNRELATED_TOKEN}" } },
  };
  applyHermesManagedRoute(config, {
    upstreamProvider: "nvidia-prod",
    baseUrl: "https://inference.local/v1",
    model: "image-model",
    inferenceApi: "openai-completions",
  });
  Object.defineProperty(config, digest, {
    value: "original-bytes-sha256",
    enumerable: false,
  });
  const target = {
    agentName: "hermes",
    configPath: "/sandbox/.hermes/config.yaml",
    configDir: "/sandbox/.hermes",
    configFile: "config.yaml",
    format: "yaml" as const,
    sensitiveFiles: [],
  };
  const events: string[] = [];
  const deps: InitialHermesInferenceRouteDeps = {
    getSandbox: vi.fn(() => entry),
    withSandboxMutationLock: async (_name, action) => {
      events.push("lock");
      try {
        return await action();
      } finally {
        events.push("unlock");
      }
    },
    readCredentialHandle: vi.fn(async () => {
      events.push("credential");
      return issued("v7");
    }),
    readRegisteredCredentialHandle: vi.fn(async () => {
      throw new Error("unexpected registered selection");
    }),
    resolveAgentConfig: vi.fn(() => target),
    readSandboxConfig: vi.fn(() => {
      events.push("read");
      return config;
    }),
    patchHermesInferenceConfig,
    writeSandboxConfig: vi.fn((_name, _target, value) => {
      events.push("write");
      expect(value).toBe(config);
      expect(Object.getOwnPropertyDescriptor(value, digest)?.value).toBe("original-bytes-sha256");
    }),
    restartGateway: vi.fn(async () => {
      events.push("restart");
      return { ok: true };
    }),
  };
  const revalidate = vi.fn();
  const initialize = createInitialHermesInferenceRoute(deps);
  const run = () => initialize("alpha", "selected-local-model", provider, "gateway-a", revalidate);
  return {
    entry,
    receipt,
    config: config as MutableHermesConfig,
    target,
    deps,
    events,
    revalidate,
    initialize,
    run,
  };
}

function bridgeFixture() {
  const f = fixture("vllm-local");
  const hostReceipt = hostLocalInferenceReceipt("docker");
  const receipt = {
    ...hostReceipt,
    endpoint: { ...hostReceipt.endpoint, host: "host.openshell.internal" },
    inference: {
      protocol: "openai-chat-completions" as const,
      model: "selected-local-model",
      toolCallingRequired: true,
    },
  };
  f.entry.endpointUrl = "https://inference.local/v1";
  f.entry.hostLocalInferenceReceipt = serializeHostLocalInferenceReceipt(receipt);
  return { ...f, hostReceipt: receipt };
}

describe("external Hermes initial native-local route", () => {
  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "projects a compatible %s endpoint using the producer's gateway mapping",
    async (host) => {
      const rawEndpoint = `http://${host}:11434/v1/`;
      const mapped = gatewayReachableCompatibleEndpointUrl("compatible-endpoint", rawEndpoint);
      expect(mapped).toBe("http://host.openshell.internal:11434/v1");
      const f = fixture("compatible-endpoint", mapped as string);
      f.entry.endpointUrl = rawEndpoint;
      await f.run();
      expect(f.deps.readCredentialHandle).toHaveBeenCalledWith("alpha", "gateway-a", f.receipt);
      expect(f.config.model).toMatchObject({ base_url: mapped, api_key: issued("v7") });
      expect(f.config.providers["compatible-endpoint"]).toMatchObject({
        api: mapped,
        api_key: issued("v7"),
      });
      expect(f.config.custom_providers).toEqual([
        expect.objectContaining({ base_url: mapped, api_key: issued("v7") }),
      ]);
      expect(f.entry.endpointUrl).toBe(rawEndpoint);
      expect(f.events).toEqual(["lock", "credential", "read", "write", "restart", "unlock"]);
    },
  );

  it.each(["http://localhost:11436/v1", "http://localhost:11434/other"])(
    "refuses a gateway attachment that does not map from %s",
    async (endpoint) => {
      const f = fixture("compatible-endpoint", "http://host.openshell.internal:11434/v1");
      f.entry.endpointUrl = endpoint;
      await expect(f.run()).rejects.toThrow("does not match");
      expect(f.events).toEqual([]);
      expect(f.deps.readCredentialHandle).not.toHaveBeenCalled();
      expect(f.deps.writeSandboxConfig).not.toHaveBeenCalled();
      expect(f.deps.restartGateway).not.toHaveBeenCalled();
    },
  );

  it("refuses a loopback route changed while reading the issued credential", async () => {
    const f = fixture("compatible-endpoint", "http://host.openshell.internal:11434/v1");
    f.entry.endpointUrl = "http://localhost:11434/v1";
    vi.mocked(f.deps.readCredentialHandle).mockImplementation(async () => {
      f.entry.endpointUrl = "http://localhost:11435/v1";
      return issued("v7");
    });
    await expect(f.run()).rejects.toThrow("does not match");
    expect(f.deps.readCredentialHandle).toHaveBeenCalledOnce();
    expect(f.deps.readSandboxConfig).not.toHaveBeenCalled();
    expect(f.deps.writeSandboxConfig).not.toHaveBeenCalled();
    expect(f.deps.restartGateway).not.toHaveBeenCalled();
  });

  it("projects the exact receipt-bound host endpoint from a published application route", async () => {
    const f = bridgeFixture();
    const registered = structuredClone(f.entry);
    await f.run();
    expect(f.config.model).toMatchObject({
      base_url: f.receipt.endpointUrl,
      api_key: issued("v7"),
    });
    expect(f.config.providers["vllm-local"]).toMatchObject({
      api: f.receipt.endpointUrl,
      api_key: issued("v7"),
    });
    expect(f.config.custom_providers).toEqual([
      expect.objectContaining({
        name: "vllm-local",
        base_url: f.receipt.endpointUrl,
        api_key: issued("v7"),
      }),
    ]);
    expect(f.entry).toEqual(registered);
    expect(f.events).toEqual(["lock", "credential", "read", "write", "restart", "unlock"]);
  });

  it.each([
    {
      name: "missing",
      setup(f: ReturnType<typeof bridgeFixture>) {
        delete f.entry.hostLocalInferenceReceipt;
      },
    },
    {
      name: "malformed",
      setup(f: ReturnType<typeof bridgeFixture>) {
        f.entry.hostLocalInferenceReceipt = "{}";
      },
    },
    {
      name: "mismatched",
      setup(f: ReturnType<typeof bridgeFixture>) {
        f.entry.hostLocalInferenceReceipt = serializeHostLocalInferenceReceipt({
          ...f.hostReceipt,
          endpoint: { ...f.hostReceipt.endpoint, port: 8001 },
        });
      },
    },
  ])("rejects $name host bridge receipt before any side effect", async ({ setup }) => {
    const f = bridgeFixture();
    setup(f);
    await expect(f.run()).rejects.toThrow("does not match");
    expect(f.events).toEqual([]);
    expect(f.deps.readCredentialHandle).not.toHaveBeenCalled();
    expect(f.deps.readSandboxConfig).not.toHaveBeenCalled();
    expect(f.deps.writeSandboxConfig).not.toHaveBeenCalled();
    expect(f.deps.restartGateway).not.toHaveBeenCalled();
  });

  it("rejects changed host receipt bytes even when the endpoint remains equal", async () => {
    const f = bridgeFixture();
    vi.mocked(f.deps.readCredentialHandle).mockImplementation(async () => {
      f.entry.hostLocalInferenceReceipt = `${f.entry.hostLocalInferenceReceipt} `;
      return issued("v7");
    });
    await expect(f.run()).rejects.toThrow("does not match");
    expect(f.deps.readSandboxConfig).not.toHaveBeenCalled();
    expect(f.deps.writeSandboxConfig).not.toHaveBeenCalled();
    expect(f.deps.restartGateway).not.toHaveBeenCalled();
  });

  it.each(["v7", "v8", `s${"a".repeat(64)}`])(
    "projects issued %s into all managed slots while retaining unrelated state and read identity",
    async (scope) => {
      const f = fixture();
      vi.mocked(f.deps.readCredentialHandle).mockResolvedValue(issued(scope));
      const beforeEntry = structuredClone(f.entry);
      await f.run();
      expect(f.config.model).toMatchObject({
        default: "selected-local-model",
        provider: "custom",
        base_url: f.receipt.endpointUrl,
        api_key: issued(scope),
      });
      expect(f.config.providers["compatible-endpoint"].api_key).toBe(issued(scope));
      expect(f.config.custom_providers).toEqual([
        expect.objectContaining({
          name: "compatible-endpoint",
          api_key: issued(scope),
          base_url: f.receipt.endpointUrl,
        }),
      ]);
      expect(f.config.providers.unrelated).toEqual({
        api_key: "${UNRELATED_TOKEN}",
      });
      expect(f.config.mcp_servers).toEqual({
        example: { command: "example-mcp" },
      });
      expect(f.config.display).toEqual({ show_reasoning: false });
      expect(f.entry).toEqual(beforeEntry);
      expect(f.deps.readCredentialHandle).toHaveBeenCalledExactlyOnceWith(
        "alpha",
        "gateway-a",
        f.receipt,
      );
      expect(f.deps.readSandboxConfig).toHaveBeenCalledExactlyOnceWith(
        "alpha",
        f.target,
        "gateway-a",
      );
      expect(f.events).toEqual(["lock", "read", "write", "restart", "unlock"]);
      expect(f.revalidate).toHaveBeenCalledTimes(4);
    },
  );

  it.each([
    {
      name: "nonexternal",
      setup(f: ReturnType<typeof fixture>) {
        delete f.entry.workload;
      },
    },
    {
      name: "shared",
      setup(f: ReturnType<typeof fixture>) {
        delete f.entry.nativeLocalProviderAttachment;
        f.entry.provider = "nvidia-prod";
        f.entry.endpointUrl = "https://inference.local/v1";
      },
    },
    {
      name: "hosted",
      setup(f: ReturnType<typeof fixture>) {
        delete f.entry.nativeLocalProviderAttachment;
        f.entry.provider = "hermes-provider";
        f.entry.endpointUrl = "https://inference-api.nousresearch.com/v1";
      },
    },
  ])("leaves $name selection alone", async ({ setup }) => {
    const f = fixture();
    setup(f);
    await f.initialize("alpha", "selected-local-model", "compatible-endpoint", "gateway-a");
    expect(f.events).toEqual([]);
    expect(f.deps.readCredentialHandle).not.toHaveBeenCalled();
    expect(f.deps.writeSandboxConfig).not.toHaveBeenCalled();
  });

  it("projects an attached native NIM route", async () => {
    const f = fixture("vllm-local");
    const binding = { ...f.receipt, authMode: "sentinel" as const };
    const receipt = { ...binding, ...nativeLocalIdentity(binding) };
    f.entry.nimContainer = "nemoclaw-nim-owned";
    f.entry.nativeLocalProviderAttachment = receipt;
    await f.run();
    expect(f.deps.readCredentialHandle).toHaveBeenCalledExactlyOnceWith(
      "alpha",
      "gateway-a",
      receipt,
    );
    expect(f.config.model).toMatchObject({ base_url: receipt.endpointUrl, api_key: issued("v7") });
    expect(f.config.providers["vllm-local"].api_key).toBe(issued("v7"));
    expect(f.events).toEqual(["lock", "credential", "read", "write", "restart", "unlock"]);
  });

  it("rejects legacy NIM before reading credentials or changing config", async () => {
    const f = fixture("vllm-local");
    f.entry.nimContainer = "nemoclaw-nim-owned";
    delete f.entry.nativeLocalProviderAttachment;
    await expect(f.run()).rejects.toThrow("does not match");
    expect(f.events).toEqual([]);
    expect(f.deps.readCredentialHandle).not.toHaveBeenCalled();
    expect(f.deps.writeSandboxConfig).not.toHaveBeenCalled();
  });

  it.each(["name", "agent", "gatewayName", "provider", "model", "endpointUrl"] as const)(
    "refuses a mismatched registered %s before reading credentials or config",
    async (field) => {
      const f = fixture();
      f.entry[field] = "mismatch";
      await expect(f.run()).rejects.toThrow("does not match");
      expect(f.events).toEqual([]);
      expect(f.deps.readCredentialHandle).not.toHaveBeenCalled();
      expect(f.deps.writeSandboxConfig).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "absent",
      setup(f: ReturnType<typeof fixture>) {
        delete f.entry.nativeLocalProviderAttachment;
      },
    },
    {
      name: "invalid-identity",
      setup(f: ReturnType<typeof fixture>) {
        f.entry.nativeLocalProviderAttachment = {
          ...f.receipt,
          providerName: "other",
        };
      },
    },
    {
      name: "other-agent",
      setup(f: ReturnType<typeof fixture>) {
        const { agent: _agent, ...binding } = f.receipt;
        f.entry.nativeLocalProviderAttachment = {
          ...binding,
          ...nativeLocalIdentity(binding),
        };
      },
    },
  ])("refuses $name local receipt", async ({ setup }) => {
    const f = fixture();
    setup(f);
    await expect(f.run()).rejects.toThrow("does not match");
    expect(f.deps.readCredentialHandle).not.toHaveBeenCalled();
    expect(f.deps.writeSandboxConfig).not.toHaveBeenCalled();
  });

  it("requires sandbox identity revalidation for the applicable path", async () => {
    const f = fixture();
    await expect(
      f.initialize("alpha", "selected-local-model", "compatible-endpoint", "gateway-a"),
    ).rejects.toThrow("verified sandbox identity");
    expect(f.events).toEqual([]);
  });

  it("rejects changed receipt authority after the credential probe without touching config", async () => {
    const f = fixture();
    vi.mocked(f.deps.readCredentialHandle).mockImplementation(async () => {
      f.entry.nativeLocalProviderAttachment = {
        ...f.receipt,
        providerId: "replaced",
      };
      return issued("v7");
    });
    await expect(f.run()).rejects.toThrow("does not match");
    expect(f.deps.readSandboxConfig).not.toHaveBeenCalled();
    expect(f.deps.writeSandboxConfig).not.toHaveBeenCalled();
    expect(f.deps.restartGateway).not.toHaveBeenCalled();
  });

  it("does not write or restart after unavailable or unverified credentials", async () => {
    const f = fixture();
    vi.mocked(f.deps.readCredentialHandle).mockRejectedValue(
      new Error("attachment verification failed"),
    );
    await expect(f.run()).rejects.toThrow("attachment verification failed");
    expect(f.deps.readSandboxConfig).not.toHaveBeenCalled();
    expect(f.deps.writeSandboxConfig).not.toHaveBeenCalled();
    expect(f.deps.restartGateway).not.toHaveBeenCalled();
  });

  it("refuses raw credentials before writing config", async () => {
    const f = fixture();
    vi.mocked(f.deps.readCredentialHandle).mockResolvedValue("synthetic-raw-local-secret");
    await expect(f.run()).rejects.toThrow("provider-bound credential handle");
    expect(f.deps.writeSandboxConfig).not.toHaveBeenCalled();
    expect(f.deps.restartGateway).not.toHaveBeenCalled();
  });

  it("propagates a guarded write failure without restarting", async () => {
    const f = fixture();
    vi.mocked(f.deps.writeSandboxConfig).mockImplementation(() => {
      throw new Error("config changed after read");
    });
    await expect(f.run()).rejects.toThrow("config changed after read");
    expect(f.deps.restartGateway).not.toHaveBeenCalled();
  });

  it("refuses completion after restart failure and retries activation on unchanged config", async () => {
    const f = fixture();
    vi.mocked(f.deps.restartGateway).mockResolvedValueOnce({ ok: false });
    await expect(f.run()).rejects.toThrow("restart failed");
    await f.run();
    expect(f.deps.restartGateway).toHaveBeenCalledTimes(2);
    expect(f.deps.restartGateway).toHaveBeenLastCalledWith("alpha", "gateway-a");
  });
});

describe("restored Hermes native route projection", () => {
  it.each(["vllm-local", "ollama-local", "llama-cpp-local"] as const)(
    "retains the effective API for %s despite a stale Responses preference",
    async (provider) => {
      const f = fixture(provider);
      f.entry.preferredInferenceApi = "openai-responses";
      await f.run();
      const restored = structuredClone(f.config);
      vi.mocked(f.deps.readCredentialHandle).mockResolvedValue(issued("v8"));
      const project = createInitialHermesInferenceRoute(f.deps, {
        activation: "deferred",
        workload: "registered",
        projection: "credential",
      });
      await project("alpha", "selected-local-model", provider, "gateway-a", f.revalidate);
      restored.model.api_key = issued("v8");
      restored.providers[provider].api_key = issued("v8");
      restored.custom_providers[0].api_key = issued("v8");
      expect(f.config).toEqual(restored);
    },
  );

  it.each([
    {
      name: "changed model",
      change: (f: ReturnType<typeof fixture>) => {
        f.config.model.default = "different-model";
      },
    },
    {
      name: "changed endpoint",
      change: (f: ReturnType<typeof fixture>) => {
        f.config.model.base_url = "http://foreign.example/v1";
      },
    },
    {
      name: "inconsistent credential",
      change: (f: ReturnType<typeof fixture>) => {
        f.config.providers["compatible-endpoint"].api_key = issued("v3");
      },
    },
    {
      name: "missing credential",
      change: (f: ReturnType<typeof fixture>) => {
        delete f.config.model.api_key;
        delete f.config.providers["compatible-endpoint"].api_key;
        delete f.config.custom_providers[0].api_key;
      },
    },
  ])("does not replace a restored route with $name", async ({ change }) => {
    const f = fixture();
    await f.run();
    change(f);
    vi.mocked(f.deps.writeSandboxConfig).mockClear();
    vi.mocked(f.deps.restartGateway).mockClear();
    const before = structuredClone(f.config);
    const project = createInitialHermesInferenceRoute(f.deps, {
      activation: "deferred",
      workload: "registered",
      projection: "credential",
    });
    await expect(
      project("alpha", "selected-local-model", "compatible-endpoint", "gateway-a", f.revalidate),
    ).rejects.toThrow("does not match its registered route");
    expect(f.config).toEqual(before);
    expect(f.deps.writeSandboxConfig).not.toHaveBeenCalled();
    expect(f.deps.restartGateway).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing replacement identity", gateway: "gateway-a", revalidate: undefined },
    { name: "foreign selected gateway", gateway: "foreign-gateway", revalidate: vi.fn() },
  ])("refuses $name before reading restored configuration", async ({ gateway, revalidate }) => {
    const f = fixture();
    const project = createInitialHermesInferenceRoute(f.deps, {
      activation: "deferred",
      workload: "registered",
      projection: "credential",
    });
    await expect(
      project("alpha", "selected-local-model", "compatible-endpoint", gateway, revalidate),
    ).rejects.toThrow();
    expect(f.deps.readCredentialHandle).not.toHaveBeenCalled();
    expect(f.deps.writeSandboxConfig).not.toHaveBeenCalled();
    expect(f.deps.restartGateway).not.toHaveBeenCalled();
  });

  it.each([
    { name: "external", setup: (_f: ReturnType<typeof fixture>) => {} },
    {
      name: "legacy registered",
      setup: (f: ReturnType<typeof fixture>) => {
        delete f.entry.workload;
      },
    },
    {
      name: "managed",
      setup: (f: ReturnType<typeof fixture>) => {
        f.entry.workload = {
          ...f.entry.workload,
          kind: "managed-image",
        } as SandboxEntry["workload"];
      },
    },
  ])(
    "rebinds the archived reference for $name state without activating twice",
    async ({ setup }) => {
      const f = fixture();
      await f.run();
      setup(f);
      f.config.model.context_length = 32768;
      f.config.model.temperature = 0.25;
      f.config.providers["compatible-endpoint"].discover_models = false;
      f.config.custom_providers[0].timeout = 120;
      f.config.user_model_options = f.config.model;
      const restored = structuredClone(f.config);
      vi.mocked(f.deps.readCredentialHandle).mockResolvedValue(issued("v8"));
      vi.mocked(f.deps.restartGateway).mockClear();
      f.events.length = 0;
      const project = createInitialHermesInferenceRoute(f.deps, {
        activation: "deferred",
        workload: "registered",
        projection: "credential",
      });
      await project(
        "alpha",
        "selected-local-model",
        "compatible-endpoint",
        "gateway-a",
        f.revalidate,
      );
      restored.model = { ...restored.model, api_key: issued("v8") };
      restored.providers["compatible-endpoint"].api_key = issued("v8");
      restored.custom_providers[0].api_key = issued("v8");
      expect(f.config).toEqual(restored);
      expect(f.config.model.api_key).toBe(issued("v8"));
      expect(f.config.providers["compatible-endpoint"].api_key).toBe(issued("v8"));
      expect(f.config.custom_providers).toEqual([
        expect.objectContaining({ api_key: issued("v8") }),
      ]);
      expect(f.config.providers.unrelated).toEqual({
        api_key: "${UNRELATED_TOKEN}",
      });
      expect(f.config.mcp_servers).toEqual({
        example: { command: "example-mcp" },
      });
      expect(f.events).toEqual(["lock", "read", "write", "unlock"]);
      expect(f.deps.writeSandboxConfig).toHaveBeenLastCalledWith("alpha", f.target, f.config, {
        gatewayName: "gateway-a",
        deferReload: true,
        restoreNativeLocalCredential: true,
      });
      expect(f.deps.restartGateway).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "live replacement",
      change: (f: ReturnType<typeof fixture>) => {
        f.revalidate.mockImplementation(() => {
          throw new Error("live identity changed");
        });
      },
    },
    {
      name: "registered workload",
      change: (f: ReturnType<typeof fixture>) => {
        f.entry.workload = undefined;
      },
    },
    {
      name: "provider attachment",
      change: (f: ReturnType<typeof fixture>) => {
        f.entry.nativeLocalProviderAttachment = {
          ...f.receipt,
          providerId: "foreign",
        };
      },
    },
  ])("refuses changed $name before overwriting restored configuration", async ({ change }) => {
    const f = fixture();
    vi.mocked(f.deps.readCredentialHandle).mockImplementation(async () => {
      change(f);
      return issued("v8");
    });
    const project = createInitialHermesInferenceRoute(f.deps, {
      activation: "deferred",
      workload: "registered",
      projection: "credential",
    });
    await expect(
      project("alpha", "selected-local-model", "compatible-endpoint", "gateway-a", f.revalidate),
    ).rejects.toThrow();
    expect(f.deps.readSandboxConfig).not.toHaveBeenCalled();
    expect(f.deps.writeSandboxConfig).not.toHaveBeenCalled();
    expect(f.deps.restartGateway).not.toHaveBeenCalled();
  });
});

describe("registered Hermes native route restoration", () => {
  function registeredFixture() {
    const f = fixture();
    const native = registeredInferenceFixture(true);
    Object.assign(f.entry, {
      name: native.binding.sandboxName,
      gatewayName: native.binding.gatewayName,
      provider: native.binding.providerName,
      endpointUrl: native.binding.endpointUrl,
      preferredInferenceApi: native.binding.inferenceApi,
      credentialEnv: native.binding.credentialEnv,
      registeredInferenceProviderAttachment: native.binding,
      nativeLocalProviderAttachment: undefined,
    });
    const read = vi.fn(async () => native.handle);
    vi.mocked(f.deps.readRegisteredCredentialHandle).mockImplementation(async (attachment) => {
      await verifyRegisteredInferenceProviderAttachment({
        adapter: native.adapter,
        expected: attachment,
      });
      return readVerifiedRegisteredCredentialHandle({
        attachment,
        adapter: native.adapter,
        read,
        sleep: async () => {},
      });
    });
    const run = (projection: "route" | "credential" = "route") =>
      createInitialHermesInferenceRoute(f.deps, {
        activation: "deferred",
        workload: "registered",
        projection,
      })(
        f.entry.name,
        f.entry.model!,
        native.binding.providerName,
        native.binding.gatewayName,
        f.revalidate,
      );
    return { ...f, native, read, run };
  }

  it.each(["openai-completions", "openai-responses", "anthropic-messages"] as const)(
    "refreshes only registered credential slots while preserving %s configuration",
    async (api) => {
      const f = registeredFixture();
      // The fixture profile must match the selected API as well as its endpoint.
      f.native.profile.credentials[0].auth_style =
        api === "anthropic-messages" ? "header" : "bearer";
      f.native.profile.credentials[0].header_name =
        api === "anthropic-messages" ? "x-api-key" : "authorization";
      f.native.binding = {
        ...f.native.binding,
        inferenceApi: api,
        profileDigest: inspectInferenceProviderProfile(JSON.stringify(f.native.profile))!.digest,
      };
      f.entry.registeredInferenceProviderAttachment = f.native.binding;
      f.entry.preferredInferenceApi = api;
      await f.run();
      f.config.model.context_length = 32768;
      f.config.model.temperature = 0.25;
      f.config.providers[f.native.binding.providerName].discover_models = false;
      f.config.custom_providers.find((row) => row.name === f.native.binding.providerName)!.timeout =
        120;
      const restored = structuredClone(f.config);
      const fresh = `openshell:resolve:env:s${"b".repeat(64)}_VENDOR_API_KEY`;
      f.read.mockResolvedValue(fresh);
      await f.run("credential");
      restored.model.api_key = fresh;
      restored.providers[f.native.binding.providerName].api_key = fresh;
      restored.custom_providers.find((row) => row.name === f.native.binding.providerName)!.api_key =
        fresh;
      expect(f.config).toEqual(restored);
      expect(f.deps.writeSandboxConfig).toHaveBeenLastCalledWith(f.entry.name, f.target, f.config, {
        gatewayName: f.native.binding.gatewayName,
        deferReload: true,
        restoreNativeLocalCredential: true,
      });
      expect(f.deps.readCredentialHandle).not.toHaveBeenCalled();
      expect(f.deps.restartGateway).not.toHaveBeenCalled();
      expect(f.native.adapter.updateProvider).not.toHaveBeenCalled();
      expect(f.native.adapter.deleteProvider).not.toHaveBeenCalled();
    },
  );

  it.each([
    "replaced",
    "detached",
    "wrong-gateway",
    "changed-selection",
    "raw-handle",
    "wrong-environment",
    "missing-handle",
    "changed-revision",
  ])("refuses registered restore with %s before writing or restarting", async (state) => {
    const f = registeredFixture();
    await f.run();
    const before = structuredClone(f.config);
    vi.mocked(f.deps.writeSandboxConfig).mockClear();
    const changes: Record<string, () => void> = {
      replaced: () => {
        f.native.state.id = "other";
      },
      detached: () => {
        f.native.state.attached = false;
      },
      "wrong-gateway": () => {
        f.entry.gatewayName = "other";
      },
      "changed-selection": () => {
        f.read.mockImplementation(async () => {
          f.entry.model = "other";
          return f.native.handle;
        });
      },
      "missing-handle": () => {
        f.read.mockRejectedValue(new Error("issued handle unavailable"));
      },
      "changed-revision": () => {
        f.read.mockImplementation(async () => {
          f.native.state.revision++;
          return f.native.handle;
        });
      },
      "raw-handle": () => {
        f.read.mockResolvedValue("raw-secret");
      },
      "wrong-environment": () => {
        f.read.mockResolvedValue(`openshell:resolve:env:s${"b".repeat(64)}_OTHER_KEY`);
      },
    };
    changes[state]();
    await expect(f.run("credential")).rejects.toThrow();
    expect(f.config).toEqual(before);
    expect(f.deps.writeSandboxConfig).not.toHaveBeenCalled();
    expect(f.deps.restartGateway).not.toHaveBeenCalled();
    expect(f.native.adapter.updateProvider).not.toHaveBeenCalled();
    expect(f.native.adapter.deleteProvider).not.toHaveBeenCalled();
  });
});

describe("restored Hermes NVIDIA route", () => {
  it.each([false, true])(
    "rebinds NVIDIA credentials with Discord enrolled: %s",
    async (discord) => {
      const f = fixture();
      f.entry.provider = "nvidia-prod";
      f.entry.endpointUrl = "https://integrate.api.nvidia.com/v1";
      f.entry.nativeLocalProviderAttachment = undefined;
      f.entry.nativeNvidiaProviderAttachment = {
        schemaVersion: 1,
        profileId: "nemoclaw-nvidia-inference-v1",
        providerName: "nemoclaw-nvidia-prod-v1",
        providerId: "nvidia-provider-id",
      };
      applyHermesManagedRoute(f.config, {
        upstreamProvider: "nvidia-prod",
        baseUrl: f.entry.endpointUrl,
        model: f.entry.model!,
        inferenceApi: "openai-completions",
        nativeCredentialHandle: "openshell:resolve:env:v6_NVIDIA_INFERENCE_API_KEY",
      });
      f.entry.endpointUrl = discord ? f.entry.endpointUrl : undefined;
      f.config.discord = discord ? { require_mention: true, allowed_users: ["123"] } : undefined;
      f.config.model.temperature = 0.25;
      const before = structuredClone(f.config);
      const handle = "openshell:resolve:env:v8_NVIDIA_INFERENCE_API_KEY";
      const readNvidiaCredentialHandle = vi.fn(async () => handle);
      const restore = createInitialHermesInferenceRoute(
        { ...f.deps, readNvidiaCredentialHandle },
        {
          activation: "deferred",
          workload: "registered",
          projection: "credential",
        },
      );
      await restore("alpha", f.entry.model!, "nvidia-prod", "gateway-a", f.revalidate);
      before.model.api_key = handle;
      before.providers["nvidia-prod"].api_key = handle;
      before.custom_providers.find((p) => p.name === "nvidia-prod")!.api_key = handle;
      expect(f.config).toEqual(before);
      expect(readNvidiaCredentialHandle).toHaveBeenCalled();
      expect(f.deps.writeSandboxConfig).toHaveBeenCalled();
      expect(f.deps.restartGateway).not.toHaveBeenCalled();
    },
  );
});

it("keeps a retained shared NVIDIA route during credential-only restore", async () => {
  const f = fixture();
  f.entry.provider = "nvidia-prod";
  f.entry.nativeLocalProviderAttachment = undefined;
  f.entry.endpointUrl = "https://inference.local/v1";
  const restored = structuredClone(f.config);
  const restore = createInitialHermesInferenceRoute(f.deps, {
    activation: "deferred",
    workload: "registered",
    projection: "credential",
  });
  await expect(
    restore("alpha", f.entry.model!, "nvidia-prod", "gateway-a", f.revalidate),
  ).resolves.toBeUndefined();
  expect(f.config).toEqual(restored);
  expect(f.deps.readSandboxConfig).not.toHaveBeenCalled();
  expect(f.deps.writeSandboxConfig).not.toHaveBeenCalled();
});

it.each([null, {}])("rejects a malformed present NVIDIA receipt: %s", async (receipt) => {
  const f = fixture();
  f.entry.provider = "nvidia-prod";
  f.entry.nativeLocalProviderAttachment = undefined;
  Object.assign(f.entry, { nativeNvidiaProviderAttachment: receipt });
  const restore = createInitialHermesInferenceRoute(f.deps, {
    activation: "deferred",
    workload: "registered",
    projection: "credential",
  });
  await expect(
    restore("alpha", f.entry.model!, "nvidia-prod", "gateway-a", f.revalidate),
  ).rejects.toThrow("does not match its registered selection");
  expect(f.deps.writeSandboxConfig).not.toHaveBeenCalled();
});
