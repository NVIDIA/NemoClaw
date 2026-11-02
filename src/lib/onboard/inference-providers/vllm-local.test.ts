// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import * as nim from "../../inference/nim";
import type { VllmDeps } from "./types";
import { setupVllmLocalInference } from "./vllm-local";

const CREDENTIAL_ENV = "NEMOCLAW_VLLM_LOCAL_TOKEN";

function deps(overrides: Partial<VllmDeps> = {}): VllmDeps {
  return {
    runOpenshell: vi.fn(() => ({ status: 0 })),
    upsertProvider: vi.fn(async () => ({ ok: true })),
    verifyInferenceRoute: vi.fn(),
    verifyOnboardInferenceSmoke: vi.fn(),
    isNonInteractive: () => true,
    registry: { updateSandbox: vi.fn() as VllmDeps["registry"]["updateSandbox"] },
    exitProcess: (code) => {
      throw new Error(`exit ${code}`);
    },
    error: vi.fn(),
    log: vi.fn(),
    validateLocalProvider: () => ({ ok: true }),
    getLocalProviderHealthCheck: () => ["curl", "-sf", "http://127.0.0.1:8000/v1/models"],
    getLocalProviderBaseUrl: () => "http://host.openshell.internal:8000/v1",
    applyLocalInferenceRoute: async () => false,
    run: vi.fn(() => ({ status: 0 })),
    VLLM_LOCAL_CREDENTIAL_ENV: CREDENTIAL_ENV,
    getManagedVllmProviderBinding: () => null,
    ...overrides,
  };
}

describe("vLLM local provider credential", () => {
  it("preserves the literal dummy credential for legacy single-host vLLM", async () => {
    const upsertProvider = vi.fn(async () => ({ ok: true }));

    await expect(
      setupVllmLocalInference(
        { model: "served/model", provider: "vllm-local" },
        deps({ upsertProvider }),
      ),
    ).resolves.toEqual({ done: false });

    expect(upsertProvider).toHaveBeenCalledWith(
      "vllm-local",
      "openai",
      CREDENTIAL_ENV,
      "http://host.openshell.internal:8000/v1",
      { [CREDENTIAL_ENV]: "dummy" },
    );
  });

  it("registers the persisted managed key through provider env, never as an argv field", async () => {
    const apiKey = "c".repeat(64);
    const upsertProvider = vi.fn(async () => ({ ok: true }));

    await expect(
      setupVllmLocalInference(
        { model: "served/model", provider: "vllm-local" },
        deps({
          upsertProvider,
          getManagedVllmProviderBinding: () => ({
            baseUrl: "http://10.40.0.1:8000/v1",
            apiKey,
          }),
        }),
      ),
    ).resolves.toEqual({ done: false });

    expect(upsertProvider).toHaveBeenCalledWith(
      "vllm-local",
      "openai",
      CREDENTIAL_ENV,
      "http://10.40.0.1:8000/v1",
      { [CREDENTIAL_ENV]: apiKey },
    );
  });

  it("fails closed without rendering credential-loader details", async () => {
    const leaked = "d".repeat(64);
    const error = vi.fn();
    const upsertProvider = vi.fn(async () => ({ ok: true }));

    await expect(
      setupVllmLocalInference(
        { model: "served/model", provider: "vllm-local" },
        deps({
          error,
          upsertProvider,
          getManagedVllmProviderBinding: () => {
            throw new Error(`unsafe ${leaked}`);
          },
        }),
      ),
    ).rejects.toThrow("exit 1");

    expect(upsertProvider).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      "  Managed vLLM authentication state is unsafe or unreadable.",
    );
    expect(error.mock.calls.flat().join("\n")).not.toContain(leaked);
  });
});

describe("Local NIM provider selection", () => {
  it("uses its sentinel and owned port without reading managed vLLM or host credentials", async () => {
    vi.spyOn(nim, "getServedModelId").mockReturnValue("local/nim-model");
    vi.stubEnv("NGC_API_KEY", "ngc-download-secret");
    vi.stubEnv("OPENAI_API_KEY", "host-openai-secret");
    const getManagedVllmProviderBinding = vi.fn(() => ({
      baseUrl: "http://host.openshell.internal:18000/v1",
      apiKey: "managed-vllm-secret",
    }));
    const validateLocalProvider = vi.fn(() => ({ ok: true as const }));
    const getLocalProviderBaseUrl = vi.fn(() => "http://host.openshell.internal:18000/v1");
    const selected = deps({
      getManagedVllmProviderBinding,
      validateLocalProvider,
      getLocalProviderBaseUrl,
    });
    await expect(
      setupVllmLocalInference(
        { model: "local/nim-model", provider: "vllm-local", localNimSelected: true },
        selected,
      ),
    ).resolves.toEqual({ done: false });
    expect(selected.upsertProvider).toHaveBeenCalledWith(
      "vllm-local",
      "openai",
      CREDENTIAL_ENV,
      nim.getNimInferenceEndpoints().baseUrl,
      { [CREDENTIAL_ENV]: "dummy" },
    );
    expect(getManagedVllmProviderBinding).not.toHaveBeenCalled();
    expect(validateLocalProvider).not.toHaveBeenCalled();
    expect(getLocalProviderBaseUrl).not.toHaveBeenCalled();
  });

  it.each([null, "different-model"])(
    "stops before provider mutation when NIM serves %s",
    async (observed) => {
      vi.spyOn(nim, "getServedModelId").mockReturnValue(observed);
      const selected = deps();
      await expect(
        setupVllmLocalInference(
          { model: "local/nim-model", provider: "vllm-local", localNimSelected: true },
          selected,
        ),
      ).rejects.toThrow("exit 1");
      expect(selected.upsertProvider).not.toHaveBeenCalled();
      expect(selected.error).toHaveBeenCalledWith(
        "  Local NVIDIA NIM does not serve the selected model. Onboarding stopped.",
      );
    },
  );
});
