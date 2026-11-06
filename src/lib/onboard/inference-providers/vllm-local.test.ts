// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ManagedVllmInspectionError,
  UnsafeLegacyVllmBindingsError,
} from "../../inference/serving/vllm-host-local-lifecycle";
import type { VllmDeps } from "./types";
import { setupVllmLocalInference } from "./vllm-local";

const CREDENTIAL_ENV = "NEMOCLAW_VLLM_LOCAL_TOKEN";
const MODELS_ENDPOINT = "http://127.0.0.1:8000/v1/models";

afterEach(() => vi.restoreAllMocks());

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
    getLocalProviderHealthCheck: () => [
      "curl",
      "-sf",
      "--write-out",
      "\\n%{http_code}",
      MODELS_ENDPOINT,
    ],
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

  it.each([
    {
      state: "a credential-loader failure",
      failure: new Error(`unsafe ${"d".repeat(64)}`),
      message: "Managed vLLM authentication state is unsafe or unreadable.",
    },
    {
      state: "unavailable container inspection",
      failure: new ManagedVllmInspectionError(),
      message:
        "Managed vLLM container inspection failed. Verify access to Docker's default local daemon before retrying.",
    },
    {
      state: "unsafe legacy bindings",
      failure: new UnsafeLegacyVllmBindingsError(),
      message:
        "Follow 'Handle a Running vLLM Server' in the vLLM setup guide before recreating the owned `nemoclaw-vllm` container. Preserve the original model and port settings.",
    },
  ])("stops registration with a bounded diagnostic for $state", async ({ failure, message }) => {
    const error = vi.fn();
    const upsertProvider = vi.fn(async () => ({ ok: true }));
    const run = vi.fn(() => ({ status: 0 }));
    const validateLocalProvider = vi.fn(() => ({ ok: false, message: "provider unavailable" }));

    await expect(
      setupVllmLocalInference(
        { model: "served/model", provider: "vllm-local" },
        deps({
          error,
          upsertProvider,
          run,
          validateLocalProvider,
          getManagedVllmProviderBinding: () => {
            throw failure;
          },
        }),
      ),
    ).rejects.toThrow("exit 1");

    expect(upsertProvider).not.toHaveBeenCalled();
    expect(validateLocalProvider).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(error.mock.calls.flat().join("\n")).not.toContain("d".repeat(64));
  });
});

describe("vLLM host fallback after local-provider validation fails", () => {
  it.each([
    ["an HTML page", 0, "<html>dev server</html>\n200"],
    ["a JSON error", 0, '{"error":"nope"}\n200'],
    ["a redirected model list", 0, '{"data":[]}\n302'],
    ["a model list without HTTP status", 0, '{"data":[]}'],
    ["a failed command with model-list output", 22, '{"data":[]}\n200'],
  ])("does not register a provider for %s", async (_name, status, stdout) => {
    const upsertProvider = vi.fn(async () => ({ ok: true }));
    const applyLocalInferenceRoute = vi.fn(async () => false);

    await expect(
      setupVllmLocalInference(
        { model: "served/model", provider: "vllm-local" },
        deps({
          validateLocalProvider: () => ({
            ok: false,
            message: "Local provider validation failed.",
          }),
          run: vi.fn(() => ({ status, stdout })),
          upsertProvider,
          applyLocalInferenceRoute,
        }),
      ),
    ).rejects.toThrow("exit 1");

    expect(upsertProvider).not.toHaveBeenCalled();
    expect(applyLocalInferenceRoute).not.toHaveBeenCalled();
  });

  it.each([
    [MODELS_ENDPOINT, Buffer.from('{"data":[]}\n200')],
    ["http://10.40.0.1:8000/health", Buffer.from("200")],
  ])(
    "continues for a healthy host at %s when the container probe fails",
    async (endpoint, stdout) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const run = vi.fn(() => ({ status: 0, stdout }));
      const upsertProvider = vi.fn(async () => ({ ok: true }));

      await expect(
        setupVllmLocalInference(
          { model: "served/model", provider: "vllm-local" },
          deps({
            validateLocalProvider: () => ({ ok: false, message: "Container probe failed." }),
            getLocalProviderHealthCheck: () => ["curl", "-sf", endpoint],
            run,
            upsertProvider,
          }),
        ),
      ).resolves.toEqual({ done: false });

      expect(run).toHaveBeenCalledOnce();
      expect(upsertProvider).toHaveBeenCalledOnce();
    },
  );
});
