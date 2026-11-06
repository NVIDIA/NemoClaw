// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { providerAdapter } from "../../../test/helpers/credentials-provider-adapter.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenShellProviderAdapter } from "../adapters/openshell/provider-adapter";
import { setGlobalCliActionRuntimeHooksForTest } from "./global";
import { runCredentialsAddAction } from "./credentials-add";
import { runCredentialsListAction } from "./credentials/list";

vi.mock("../onboard/gateway-teardown-authority", () => ({
  resolveGatewayCredentialMutationAuthority: vi.fn(() => ({})),
}));

vi.mock("../state/mcp-lifecycle-lock/credential-ownership", () => ({
  withMcpCredentialOwnershipLock: <T>(operation: () => Promise<T> | T) => operation(),
}));

vi.mock("../gateway-start-guidance", () => ({
  gatewayStartGuidance: () => "Start the gateway again with `nemoclaw onboard`.",
}));

function nativeNvidiaProviderAdapter(): OpenShellProviderAdapter {
  let providerPresent = false;
  return providerAdapter({
    getProvider: vi.fn(async (request) =>
      providerPresent
        ? {
            ok: true as const,
            value: {
              name: request.providerName,
              type: "nemoclaw-nvidia-inference-v1",
              credentialKeys: ["NVIDIA_INFERENCE_API_KEY"],
              configKeys: [],
              revision: {
                id: "11111111-2222-4333-8444-555555555555",
                resourceVersion: 1,
              },
            },
          }
        : {
            ok: false as const,
            error: {
              kind: "command" as const,
              reason: "not_found" as const,
              message: "provider not found",
            },
          },
    ),
    createProvider: vi.fn(async () => {
      providerPresent = true;
      return { ok: true as const };
    }),
    deleteProvider: vi.fn(async () => {
      providerPresent = false;
      return { ok: true as const };
    }),
  });
}

describe("native NVIDIA credential registration and listing", () => {
  beforeEach(() => {
    setGlobalCliActionRuntimeHooksForTest({
      recoverNamedGatewayRuntime: async () => ({ recovered: true }),
      recordExtraProvider: () => true,
      forgetExtraProvider: () => true,
    });
  });

  afterEach(() => {
    setGlobalCliActionRuntimeHooksForTest({});
    vi.unstubAllEnvs();
  });

  it("maps the NVIDIA credential alias to the internal native provider", async () => {
    vi.stubEnv("NVIDIA_INFERENCE_API_KEY", "host-only-nvidia-value");
    const recordExtraProvider = vi.fn(() => true);
    setGlobalCliActionRuntimeHooksForTest({
      recoverNamedGatewayRuntime: async () => ({ recovered: true }),
      recordExtraProvider,
      forgetExtraProvider: () => true,
    });
    const providerId = "11111111-2222-4333-8444-555555555555";
    const adapter = nativeNvidiaProviderAdapter();
    const setNativeNvidiaProviderAuthority = vi.fn();

    const result = await runCredentialsAddAction(
      {
        provider: "nvidia-prod",
        type: "nvidia",
        credentials: ["NVIDIA_INFERENCE_API_KEY"],
        configPairs: [],
        fromExisting: false,
      },
      {
        providerAdapter: adapter,
        getNativeNvidiaProviderAuthority: () => undefined,
        setNativeNvidiaProviderAuthority,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(adapter.importProviderProfile).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      profilePath: expect.stringMatching(/provider-profiles\/nemoclaw-nvidia-inference-v1\.yaml$/u),
    });
    expect(adapter.createProvider).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      name: "nemoclaw-nvidia-prod-v1",
      type: "nemoclaw-nvidia-inference-v1",
      credentials: [{ name: "NVIDIA_INFERENCE_API_KEY", value: "host-only-nvidia-value" }],
      config: [],
      fromExisting: false,
    });
    expect(setNativeNvidiaProviderAuthority).toHaveBeenCalledWith("nemoclaw", {
      schemaVersion: 1,
      profileId: "nemoclaw-nvidia-inference-v1",
      providerName: "nemoclaw-nvidia-prod-v1",
      providerId,
    });
    expect(recordExtraProvider).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("host-only-nvidia-value");
    expect(result.successLines).toContain(
      "  Select it with 'nemoclaw inference set --provider nvidia-prod --model <model>'.",
    );
    expect(result.successLines.join("\n")).not.toContain("<sandbox> rebuild");
  });

  it("removes the native NVIDIA provider when authority persistence fails", async () => {
    vi.stubEnv("NVIDIA_INFERENCE_API_KEY", "host-only-nvidia-value");
    const adapter = nativeNvidiaProviderAdapter();

    const result = await runCredentialsAddAction(
      {
        provider: "nvidia-prod",
        type: "nvidia",
        credentials: ["NVIDIA_INFERENCE_API_KEY"],
        configPairs: [],
        fromExisting: false,
      },
      {
        providerAdapter: adapter,
        getNativeNvidiaProviderAuthority: () => undefined,
        setNativeNvidiaProviderAuthority: () => {
          throw new Error("state directory is read-only");
        },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.failureLines.join("\n")).toMatch(
      /newly created provider was removed.*state directory is read-only/su,
    );
    expect(adapter.deleteProvider).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      providerName: "nemoclaw-nvidia-prod-v1",
    });
    expect(JSON.stringify(result)).not.toContain("host-only-nvidia-value");
  });

  it("rejects a substituted native NVIDIA provider before replacing its credential", async () => {
    vi.stubEnv("NVIDIA_INFERENCE_API_KEY", "host-only-nvidia-value");
    const adapter = providerAdapter({
      getProvider: vi.fn(async (request) => ({
        ok: true as const,
        value: {
          name: request.providerName,
          type: "nemoclaw-nvidia-inference-v1",
          credentialKeys: ["NVIDIA_INFERENCE_API_KEY"],
          configKeys: [],
          revision: { id: "replacement-provider-id", resourceVersion: 2 },
        },
      })),
    });
    const setNativeNvidiaProviderAuthority = vi.fn();

    const result = await runCredentialsAddAction(
      {
        provider: "nvidia-prod",
        type: "nvidia",
        credentials: ["NVIDIA_INFERENCE_API_KEY"],
        configPairs: [],
        fromExisting: false,
      },
      {
        providerAdapter: adapter,
        getNativeNvidiaProviderAuthority: () => ({
          schemaVersion: 1,
          profileId: "nemoclaw-nvidia-inference-v1",
          providerName: "nemoclaw-nvidia-prod-v1",
          providerId: "11111111-2222-4333-8444-555555555555",
        }),
        setNativeNvidiaProviderAuthority,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.failureLines.join("\n")).toContain("changed identity");
    expect(adapter.updateProvider).not.toHaveBeenCalled();
    expect(setNativeNvidiaProviderAuthority).not.toHaveBeenCalled();
  });

  it("lists the native NVIDIA provider only by its logical credential name", async () => {
    const adapter = providerAdapter({
      listProviders: vi.fn(async () => ({
        ok: true as const,
        value: { names: ["nemoclaw-nvidia-prod-v1", "custom-provider"] },
      })),
    });

    const result = await runCredentialsListAction("nemoclaw", { providerAdapter: adapter });

    expect(result.exitCode).toBe(0);
    expect(result.outputLines).toContain("    nvidia-prod");
    expect(result.outputLines).toContain("    custom-provider");
    expect(result.outputLines.join("\n")).not.toContain("nemoclaw-nvidia-prod-v1");
  });
});
