// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOSTED_NATIVE_PROVIDERS } from "../inference/native-provider/hosted";
import { providerAdapter } from "../../../test/helpers/credentials-provider-adapter.ts";
import { setGlobalCliActionRuntimeHooksForTest } from "./global";
import { runCredentialsAddAction } from "./credentials-add";

vi.mock("../onboard/gateway-teardown-authority", () => ({
  resolveGatewayCredentialMutationAuthority: vi.fn(() => ({})),
}));

vi.mock("../state/mcp-lifecycle-lock/credential-ownership", () => ({
  withMcpCredentialOwnershipLock: <T>(operation: () => Promise<T> | T) => operation(),
}));

vi.mock("../gateway-start-guidance", () => ({
  gatewayStartGuidance: () => "Start the gateway again with `nemoclaw onboard`.",
}));

describe("native hosted credential registration", () => {
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

  it.each(HOSTED_NATIVE_PROVIDERS)(
    "registers $label credentials only in the owned native provider",
    async (definition) => {
      vi.stubEnv(definition.credentialEnv, "host-only-value");
      let present = false;
      const adapter = providerAdapter({
        getProvider: vi.fn(async () =>
          present
            ? {
                ok: true as const,
                value: {
                  name: definition.providerName,
                  type: definition.profileId,
                  credentialKeys: [definition.credentialEnv],
                  configKeys: [],
                  revision: { id: "owned-id", resourceVersion: 1 },
                },
              }
            : {
                ok: false as const,
                error: {
                  kind: "command" as const,
                  reason: "not_found" as const,
                  message: "absent",
                },
              },
        ),
        createProvider: vi.fn(async () => {
          present = true;
          return { ok: true as const };
        }),
      });
      const save = vi.fn();
      const result = await runCredentialsAddAction(
        {
          provider: definition.logicalProvider,
          type: definition.api === "anthropic-messages" ? "anthropic" : "openai",
          credentials: [definition.credentialEnv],
          configPairs: [],
          fromExisting: false,
        },
        {
          providerAdapter: adapter,
          getNativeHostedProviderAuthority: () => undefined,
          setNativeHostedProviderAuthority: save,
        },
      );
      expect(result.exitCode).toBe(0);
      expect(adapter.createProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          name: definition.providerName,
          type: definition.profileId,
          credentials: [{ name: definition.credentialEnv, value: "host-only-value" }],
          config: [],
        }),
      );
      expect(save).toHaveBeenCalledWith(
        "nemoclaw",
        definition.logicalProvider,
        expect.objectContaining({ providerName: definition.providerName, providerId: "owned-id" }),
      );
      expect(JSON.stringify([result, save.mock.calls])).not.toContain("host-only-value");
    },
  );

  it("keeps an explicit Hermes native name bound to its own endpoint during credential rotation", async () => {
    const definition = HOSTED_NATIVE_PROVIDERS.find(
      (item) => item.logicalProvider === "hermes-provider",
    )!;
    vi.stubEnv("OPENAI_API_KEY", "host-only-value");
    const receipt = {
      schemaVersion: 1 as const,
      profileId: definition.profileId,
      providerName: definition.providerName,
      providerId: "owned-id",
    };
    const readAuthority = vi.fn(() => receipt);
    const adapter = providerAdapter({
      getProvider: vi.fn(async () => ({
        ok: true as const,
        value: {
          name: definition.providerName,
          type: definition.profileId,
          credentialKeys: ["OPENAI_API_KEY"],
          configKeys: [],
          revision: { id: "owned-id", resourceVersion: 1 },
        },
      })),
    });
    const result = await runCredentialsAddAction(
      {
        provider: definition.providerName,
        type: "openai",
        credentials: ["OPENAI_API_KEY"],
        configPairs: [],
        fromExisting: false,
      },
      {
        providerAdapter: adapter,
        getNativeHostedProviderAuthority: readAuthority,
        setNativeHostedProviderAuthority: vi.fn(),
      },
    );
    expect(readAuthority).toHaveBeenNthCalledWith(
      1,
      "nemoclaw",
      "hermes-provider",
      definition.endpoint,
    );
    expect(result.exitCode).toBe(0);
    expect(adapter.updateProvider).toHaveBeenCalledWith(
      expect.objectContaining({ providerName: definition.providerName }),
    );
    expect(adapter.createProvider).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("host-only-value");
  });

  it("refuses a fixed provider endpoint override without registering anything", async () => {
    vi.stubEnv("OPENAI_API_KEY", "host-only-value");
    const adapter = providerAdapter();
    const result = await runCredentialsAddAction(
      {
        provider: "openai-api",
        type: "openai",
        credentials: ["OPENAI_API_KEY"],
        configPairs: ["OPENAI_BASE_URL=https://8.8.8.8/v1"],
        fromExisting: false,
      },
      { providerAdapter: adapter },
    );
    expect(result.exitCode).toBe(1);
    expect(adapter.createProvider).not.toHaveBeenCalled();
  });
});
