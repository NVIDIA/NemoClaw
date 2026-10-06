// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeCompatibleFixture } from "../inference/native-compatible/switch.test-support";
import { runInferenceSet } from "./inference-set";
import { createDeps, createCompatibleProviderCapture } from "./inference-set.test-support";

const OLD_ROUTE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OLD_ADAPTER_BASE_URL = `http://host.openshell.internal:11438/route/${OLD_ROUTE_ID}`;

function failRegistryRead(): never {
  throw new Error("registry unavailable");
}
// Hosted endpoints now use scoped native providers. Their collision, revision,
// ambiguous creation, rollback, and DNS rotation contracts are exercised by
// inference-set-compatible-provider.test.ts. This owner retains the migration
// boundary: credential custody and safe retirement of a recorded legacy adapter.
describe("native hosted selection and legacy HTTPS-pin adapter retirement", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(["openai-completions", "anthropic-messages"] as const)(
    "keeps the %s credential out of config, state, logs, and managed command arguments",
    async (api) => {
      const native = await nativeCompatibleFixture("https://compatible.example/v1", api, false);
      const provider =
        api === "anthropic-messages" ? "compatible-anthropic-endpoint" : "compatible-endpoint";
      const credentialEnv =
        api === "anthropic-messages" ? "COMPATIBLE_ANTHROPIC_API_KEY" : "COMPATIBLE_API_KEY";
      const config = {};
      const deps = createDeps({
        config,
        entry: { name: "alpha", agent: "openclaw", provider: "nvidia-prod", model: "old" },
        providerAdapter: native.providerAdapter,
        resolveNativeCompatibleEndpointHost: native.lookup,
        resolveCredentialValue: () => "real-upstream-secret",
      });
      await runInferenceSet(
        {
          provider,
          model: "new",
          endpointUrl: native.profile.endpoint,
          credentialEnv,
          inferenceApi: api,
        },
        deps,
      );
      expect(native.adapter.createProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          credentials: [{ name: native.profile.credentialEnv, value: "real-upstream-secret" }],
          config: [],
        }),
      );
      expect(deps.calls.ensureHttpsPinRuntimeAdapter).not.toHaveBeenCalled();
      expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
      expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
        "alpha",
        expect.objectContaining({
          endpointUrl: native.profile.endpoint,
          nativeCompatibleProviderAttachment: native.receipt,
        }),
      );
      expect(
        JSON.stringify([
          config,
          deps.calls.updateSandbox.mock.calls,
          deps.calls.updateSession.mock.calls,
          deps.calls.log.mock.calls,
        ]),
      ).not.toContain("real-upstream-secret");
    },
  );

  it("retains the legacy adapter when native registry publication fails", async () => {
    const native = await nativeCompatibleFixture("https://compatible.example/v1", undefined, false);
    const deps = createDeps({
      config: {},
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-endpoint",
        model: "old",
        endpointUrl: OLD_ADAPTER_BASE_URL,
      },
      providerAdapter: native.providerAdapter,
      resolveNativeCompatibleEndpointHost: native.lookup,
      updateSandbox: () => false,
    });
    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "new",
          endpointUrl: native.profile.endpoint,
          credentialEnv: "COMPATIBLE_API_KEY",
          inferenceApi: "openai-completions",
        },
        deps,
      ),
    ).rejects.toThrow("Failed to update NemoClaw registry for sandbox 'alpha'");
    expect(deps.calls.revokeHttpsPinRuntimeAdapterRoute).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
  });

  it("revokes a superseded adapter route only after both registry commits", async () => {
    vi.stubEnv("COMPATIBLE_API_KEY", "real-upstream-secret");
    const native = await nativeCompatibleFixture("https://new.example/v1", undefined, false);
    const deps = createDeps({
      providerAdapter: native.providerAdapter,
      resolveNativeCompatibleEndpointHost: native.lookup,
      config: {},
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-endpoint",
        model: "old",
        endpointUrl: OLD_ADAPTER_BASE_URL,
      },
    });

    await runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "new",
        endpointUrl: "https://new.example/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        inferenceApi: "openai-completions",
      },
      deps,
    );

    // Two route commits precede revocation; successful config synchronization then clears its receipt.
    expect(deps.calls.updateSandbox).toHaveBeenCalledTimes(3);
    expect(deps.calls.updateSandbox).toHaveBeenLastCalledWith("alpha", {
      openClawConfigSyncPending: undefined,
    });
    expect(deps.calls.revokeHttpsPinRuntimeAdapterRoute).toHaveBeenCalledWith(OLD_ROUTE_ID);
    expect(
      deps.calls.revokeHttpsPinRuntimeAdapterRoute.mock.invocationCallOrder[0],
    ).toBeGreaterThan(deps.calls.updateSandbox.mock.invocationCallOrder[1]);
  });

  it("revokes an adapter route when switching to a non-adapter provider", async () => {
    const deps = createDeps({
      config: {},
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-endpoint",
        model: "old",
        endpointUrl: OLD_ADAPTER_BASE_URL,
      },
    });

    await runInferenceSet({ provider: "nvidia-prod", model: "nvidia/new" }, deps);

    expect(deps.calls.revokeHttpsPinRuntimeAdapterRoute).toHaveBeenCalledWith(OLD_ROUTE_ID);
  });

  it("keeps a superseded route while another sandbox still references it", async () => {
    vi.stubEnv("COMPATIBLE_API_KEY", "real-upstream-secret");
    const alpha = {
      name: "alpha",
      agent: "openclaw" as const,
      provider: "compatible-endpoint",
      model: "old",
      endpointUrl: OLD_ADAPTER_BASE_URL,
    };
    const peer = {
      name: "peer",
      agent: "openclaw" as const,
      provider: "compatible-endpoint",
      model: "old",
      endpointUrl: OLD_ADAPTER_BASE_URL,
    };
    const native = await nativeCompatibleFixture("https://new.example/v1", undefined, false);
    const deps = createDeps({
      providerAdapter: native.providerAdapter,
      resolveNativeCompatibleEndpointHost: native.lookup,
      config: {},
      entries: [alpha],
    });
    deps.listSandboxes = () => ({
      sandboxes: [alpha, peer],
      defaultSandbox: "alpha",
    });

    await runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "new",
        endpointUrl: "https://new.example/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        inferenceApi: "openai-completions",
      },
      deps,
    );

    expect(deps.calls.revokeHttpsPinRuntimeAdapterRoute).not.toHaveBeenCalled();
  });

  it.each([
    ["peer registry read", "list"],
    ["adapter DELETE", "revoke"],
  ] as const)("keeps the committed route when post-commit %s fails", async (_name, failure) => {
    vi.stubEnv("COMPATIBLE_API_KEY", "real-upstream-secret");
    const native = await nativeCompatibleFixture("https://new.example/v1", undefined, false);
    const deps = createDeps({
      providerAdapter: native.providerAdapter,
      resolveNativeCompatibleEndpointHost: native.lookup,
      config: {},
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-endpoint",
        model: "old",
        endpointUrl: OLD_ADAPTER_BASE_URL,
      },
      revokeHttpsPinRuntimeAdapterRoute:
        failure === "revoke"
          ? async () => {
              throw new Error("delete unavailable");
            }
          : undefined,
    });
    deps.listSandboxes = failure === "list" ? failRegistryRead : deps.listSandboxes;

    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "new",
          endpointUrl: "https://new.example/v1",
          credentialEnv: "COMPATIBLE_API_KEY",
          inferenceApi: "openai-completions",
        },
        deps,
      ),
    ).resolves.toMatchObject({ sandboxName: "alpha", provider: "compatible-endpoint" });
    expect(deps.calls.updateSandbox).toHaveBeenCalledTimes(3);
    expect(deps.calls.updateSandbox).toHaveBeenLastCalledWith("alpha", {
      openClawConfigSyncPending: undefined,
    });
    expect(deps.calls.log).toHaveBeenCalledWith(expect.stringContaining("could not be revoked"));
  });

  it("retains the same legacy adapter during a model-only switch", async () => {
    const deps = createDeps({
      config: {},
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-endpoint",
        model: "old",
        endpointUrl: OLD_ADAPTER_BASE_URL,
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
      },
      captureOpenshell: createCompatibleProviderCapture({
        name: "compatible-endpoint",
        type: "openai",
        credentialEnv: "COMPATIBLE_API_KEY",
        configKey: "OPENAI_BASE_URL",
      }),
    });
    await runInferenceSet({ provider: "compatible-endpoint", model: "new" }, deps);
    expect(deps.calls.revokeHttpsPinRuntimeAdapterRoute).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ endpointUrl: OLD_ADAPTER_BASE_URL, model: "new" }),
    );
  });
});
