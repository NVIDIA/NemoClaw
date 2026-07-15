// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// PRA-1 regression (#6141): the HTTPS-pin runtime adapter's HTTP server
// rejects every request that doesn't present the adapter's own bearer token.
// `inference set --endpoint-url` must therefore register the adapter's own
// credentialEnv/token as the sandbox-facing route credential, never the real
// upstream secret — while still forwarding the real secret to the adapter so
// it can authenticate the outbound leg to the real provider. This file
// exercises that handoff at the `inference set` orchestration level; the
// adapter's own auth/forwarding behavior is covered separately in
// https-pin-runtime-adapter.test.ts and
// https-pin-runtime-adapter-forward.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";
import { HTTPS_PIN_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV } from "../inference/https-pin-runtime";
import type { ConfigObject } from "../security/credential-filter";
import { runInferenceSet } from "./inference-set";
import { baseSession, createDeps } from "./inference-set.test-support";
import type { EnsureHttpsPinRuntimeAdapterOptions } from "./inference-set-route-containment";

const ADAPTER_TOKEN = "test-adapter-token";
const ADAPTER_BASE_URL = "http://host.openshell.internal:11438/route/test-route";

function mockAdapter() {
  return vi.fn(async (_options: EnsureHttpsPinRuntimeAdapterOptions) => ({
    baseUrl: ADAPTER_BASE_URL,
    credentialEnv: HTTPS_PIN_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV,
    token: ADAPTER_TOKEN,
  }));
}

describe("runInferenceSet HTTPS-pin runtime adapter credential handoff (#6141)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env[HTTPS_PIN_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV];
  });

  it.each([
    ["compatible-endpoint", "COMPATIBLE_API_KEY", "openai-completions"],
    ["compatible-anthropic-endpoint", "COMPATIBLE_ANTHROPIC_API_KEY", "anthropic-messages"],
  ] as const)("registers the adapter's own token as the %s route credential, not the real upstream secret", async (provider, realCredentialEnv, inferenceApi) => {
    vi.stubEnv(realCredentialEnv, "real-upstream-secret");
    const adapter = mockAdapter();
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } },
      models: { providers: { inference: { api: "openai-completions", models: [] } } },
    };
    const deps = createDeps({
      config,
      entry: { name: "alpha", agent: "openclaw", provider: "nvidia-prod", model: "nvidia/model-a" },
      session: baseSession({
        provider: "nvidia-prod",
        model: "nvidia/model-a",
        endpointUrl: "https://integrate.api.nvidia.com/v1",
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      }),
      ensureHttpsPinRuntimeAdapter: adapter,
    });

    await runInferenceSet(
      {
        provider,
        model: "mock-model",
        noVerify: true,
        endpointUrl: "https://compatible.example/v1",
        credentialEnv: realCredentialEnv,
        inferenceApi,
      },
      deps,
    );

    // Leg 1 (adapter -> real upstream): the adapter is handed the real
    // provider secret's *value* so it can authenticate outbound.
    expect(adapter).toHaveBeenCalledWith(
      expect.objectContaining({ credentialValue: "real-upstream-secret" }),
    );

    // Leg 2 (sandbox -> adapter): the persisted route credential is the
    // adapter's own env var, never the real secret's name.
    expect(deps.calls.updateSandbox.mock.calls.at(-1)).toEqual([
      "alpha",
      expect.objectContaining({
        provider,
        endpointUrl: ADAPTER_BASE_URL,
        credentialEnv: HTTPS_PIN_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV,
      }),
    ]);
    expect(deps.getSession()).toMatchObject({
      provider,
      endpointUrl: ADAPTER_BASE_URL,
      credentialEnv: HTTPS_PIN_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV,
    });

    // The adapter's own token is staged so the sandbox-facing credential
    // env var it was just registered under actually resolves to it.
    expect(process.env[HTTPS_PIN_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV]).toBe(ADAPTER_TOKEN);
  });

  it("never persists the real upstream secret name as the route credentialEnv even when unset", async () => {
    const adapter = mockAdapter();
    const deps = createDeps({
      config: { agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } } },
      entry: { name: "alpha", agent: "openclaw", provider: "nvidia-prod", model: "nvidia/model-a" },
      session: baseSession({
        provider: "nvidia-prod",
        model: "nvidia/model-a",
        endpointUrl: "https://integrate.api.nvidia.com/v1",
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      }),
      ensureHttpsPinRuntimeAdapter: adapter,
    });

    await runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "mock-model",
        noVerify: true,
        endpointUrl: "https://compatible.example/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        inferenceApi: "openai-completions",
      },
      deps,
    );

    // No upstream secret was ever staged in this process, so the adapter
    // sees an empty credentialValue -- but the persisted route credential
    // must still be the adapter's own env var, not "COMPATIBLE_API_KEY".
    expect(adapter).toHaveBeenCalledWith(expect.objectContaining({ credentialValue: "" }));
    const persisted = deps.calls.updateSandbox.mock.calls.at(-1)?.[1] as { credentialEnv?: string };
    expect(persisted.credentialEnv).toBe(HTTPS_PIN_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV);
    expect(persisted.credentialEnv).not.toBe("COMPATIBLE_API_KEY");
  });
});
