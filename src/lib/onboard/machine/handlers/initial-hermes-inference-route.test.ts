// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { SandboxEntry } from "../../../state/registry";
import type { ConfigObject } from "../../../security/credential-filter";
import { patchHermesInferenceConfig } from "../../../actions/inference-set";
import { initializeExternalHermesInferenceRoute } from "./initial-hermes-inference-route";

function fixture() {
  const entry = {
    agent: "hermes",
    provider: "compatible-endpoint",
    model: "selected-model",
    gatewayName: "selected-gateway",
    endpointUrl: "https://models.example.test/v1",
    workload: { kind: "external-image" },
    nativeHostedProviderAttachment: { profileId: "native-custom" },
  } as SandboxEntry;
  const config: ConfigObject = {
    model: { default: "baked-model", base_url: "https://inference.local/v1" },
  };
  const target = {
    agentName: "hermes",
    configPath: "/sandbox/.hermes/config.yaml",
    configDir: "/sandbox/.hermes",
    configFile: "config.yaml",
    format: "yaml",
  };
  const operations: string[] = [];
  const deps = {
    getSandbox: vi.fn(() => entry),
    readSandboxConfig: vi.fn(() => config),
    resolveAgentConfig: vi.fn(() => target),
    patchHermesInferenceConfig: vi.fn(patchHermesInferenceConfig),
    readNativeNvidiaCredentialHandle: vi.fn(async () => "unused"),
    writeSandboxConfig: vi.fn(() => {
      operations.push("write");
    }),
  };
  const options = {
    getSandbox: deps.getSandbox,
    sandboxName: "external-hermes",
    gatewayName: entry.gatewayName!,
    model: entry.model!,
    provider: entry.provider!,
    preferredInferenceApi: "openai-completions",
    revalidateSandboxIdentity: vi.fn(() => {
      operations.push("identity");
    }),
  };
  return { entry, config, target, deps, options, operations };
}

describe("external-image Hermes initial inference route", () => {
  it.each(["vllm-local", "ollama-local", "llama-cpp-local", "native-extra"])(
    "preserves the route owned by the %s initializer",
    async (provider) => {
      const f = fixture();
      f.entry.provider = f.options.provider = provider;
      f.entry.endpointUrl = "http://host.openshell.internal:8000/v1";
      f.entry.registeredInferenceProviderAttachment =
        provider === "native-extra" ? ({ providerName: provider } as never) : undefined;
      const before = structuredClone(f.config);
      await initializeExternalHermesInferenceRoute(f.options, f.deps);
      expect(f.deps.readSandboxConfig).not.toHaveBeenCalled();
      expect(f.deps.writeSandboxConfig).not.toHaveBeenCalled();
      expect(f.config).toEqual(before);
    },
  );

  it("uses the provider-bound NVIDIA handle from the selected gateway", async () => {
    const f = fixture();
    f.entry.provider = f.options.provider = "nvidia-prod";
    const handle = "openshell:resolve:env:v42_NVIDIA_INFERENCE_API_KEY";
    f.deps.readNativeNvidiaCredentialHandle.mockResolvedValueOnce(handle);
    await initializeExternalHermesInferenceRoute(f.options, f.deps);
    expect(f.deps.readNativeNvidiaCredentialHandle).toHaveBeenCalledWith(
      "external-hermes",
      "selected-gateway",
    );
    expect(f.config.model).toMatchObject({
      api_key: handle,
      base_url: "https://integrate.api.nvidia.com/v1",
    });
  });

  it("does not write configuration when the NVIDIA handle is unavailable", async () => {
    const f = fixture();
    f.entry.provider = f.options.provider = "nvidia-prod";
    f.deps.readNativeNvidiaCredentialHandle.mockRejectedValueOnce(new Error("handle unavailable"));
    await expect(initializeExternalHermesInferenceRoute(f.options, f.deps)).rejects.toThrow(
      "handle unavailable",
    );
    expect(f.deps.writeSandboxConfig).not.toHaveBeenCalled();
  });

  it("replaces baked inference.local configuration with the registered native selection", async () => {
    const f = fixture();
    await initializeExternalHermesInferenceRoute(f.options, f.deps);
    expect(f.config.model).toMatchObject({
      default: "selected-model",
      base_url: "https://models.example.test/v1",
      api_key: "${COMPATIBLE_API_KEY}",
    });
    expect(f.deps.readSandboxConfig).toHaveBeenCalledWith(
      "external-hermes",
      f.target,
      "selected-gateway",
    );
    expect(f.operations).toEqual(["identity", "identity", "write"]);
  });

  it.each([
    { agent: "openclaw" },
    { provider: "openai-api" },
    { model: "other-model" },
    { gatewayName: "other-gateway" },
    { workload: { kind: "managed-image" } },
  ])("rejects a different registered selection %j before reading configuration", async (change) => {
    const f = fixture();
    Object.assign(f.entry, change);
    await expect(initializeExternalHermesInferenceRoute(f.options, f.deps)).rejects.toThrow(
      "registered external-image selection",
    );
    expect(f.deps.readSandboxConfig).not.toHaveBeenCalled();
    expect(f.deps.writeSandboxConfig).not.toHaveBeenCalled();
  });

  it.each(["writeSandboxConfig"] as const)(
    "reports a failed configuration transaction when %s fails",
    async (operation) => {
      const f = fixture();
      f.deps[operation].mockImplementation(() => {
        throw new Error("transaction failed");
      });
      await expect(initializeExternalHermesInferenceRoute(f.options, f.deps)).rejects.toThrow(
        "transaction failed",
      );
    },
  );

  it("stops before writing when sandbox identity changes after reading", async () => {
    const f = fixture();
    f.options.revalidateSandboxIdentity
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("identity changed");
      });
    await expect(initializeExternalHermesInferenceRoute(f.options, f.deps)).rejects.toThrow(
      "identity changed",
    );
    expect(f.deps.writeSandboxConfig).not.toHaveBeenCalled();
  });
});
