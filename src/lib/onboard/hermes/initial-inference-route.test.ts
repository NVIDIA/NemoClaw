// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { patchHermesInferenceConfig } from "../../actions/inference-set";
import { applyHermesManagedRoute } from "../../hermes-managed-route";
import { nativeLocalIdentity } from "../../inference/native-local/contract";
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

function fixture(provider: "compatible-endpoint" | "vllm-local" = "compatible-endpoint") {
  const binding = {
    provider,
    endpointUrl: "http://host.openshell.internal:8000/v1",
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
  Object.defineProperty(config, digest, { value: "original-bytes-sha256", enumerable: false });
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
  return { entry, receipt, config, target, deps, events, revalidate, initialize, run };
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
      expect(f.config.providers.unrelated).toEqual({ api_key: "${UNRELATED_TOKEN}" });
      expect(f.config.mcp_servers).toEqual({ example: { command: "example-mcp" } });
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
        f.entry.nativeLocalProviderAttachment = { ...f.receipt, providerName: "other" };
      },
    },
    {
      name: "other-agent",
      setup(f: ReturnType<typeof fixture>) {
        const { agent: _agent, ...binding } = f.receipt;
        f.entry.nativeLocalProviderAttachment = { ...binding, ...nativeLocalIdentity(binding) };
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
      f.entry.nativeLocalProviderAttachment = { ...f.receipt, providerId: "replaced" };
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
