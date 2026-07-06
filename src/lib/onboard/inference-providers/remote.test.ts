// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { setupRemoteProviderInference } from "./remote";
import type { RemoteProviderDeps } from "./types";

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`EXIT_CALLED:${code}`);
  }
}

function makeDeps(overrides: Partial<RemoteProviderDeps> = {}): RemoteProviderDeps {
  return {
    runOpenshell: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
    upsertProvider: vi.fn(() => ({ ok: true })),
    verifyInferenceRoute: vi.fn(),
    verifyOnboardInferenceSmoke: vi.fn(),
    isNonInteractive: vi.fn(() => true),
    registry: { updateSandbox: vi.fn() as never },
    exitProcess: vi.fn((code: number): never => {
      throw new ExitError(code);
    }),
    error: vi.fn(),
    log: vi.fn(),
    REMOTE_PROVIDER_CONFIG: {
      custom: {
        label: "Other OpenAI-compatible endpoint",
        providerName: "compatible-endpoint",
        providerType: "openai",
        credentialEnv: "COMPATIBLE_API_KEY",
        endpointUrl: "https://example.invalid/v1",
        helpUrl: null,
        modelMode: "input",
        defaultModel: "custom-model",
      },
    },
    hydrateCredentialEnv: vi.fn(() => "dummy-key"),
    promptValidationRecovery: vi.fn(async () => "selection" as const),
    classifyApplyFailure: vi.fn(() => ({ kind: "unknown" }) as never),
    LOCAL_INFERENCE_TIMEOUT_SECS: 180,
    bedrockRuntimeOnboard: {
      setupBedrockRuntimeInference: vi.fn(async () => ({ handled: false }) as const),
    },
    redact: vi.fn((input: string) => input),
    compactText: vi.fn((input: string) => input.trim()),
    ...overrides,
  };
}

describe("setupRemoteProviderInference", () => {
  it("uses a sandbox-facing host alias for loopback compatible endpoints (#5744)", async () => {
    const deps = makeDeps();

    await expect(
      setupRemoteProviderInference(
        {
          sandboxName: "dcode-vllm-local",
          model: "Qwen/Qwen2.5-1.5B-Instruct",
          provider: "compatible-endpoint",
          endpointUrl: "http://localhost:8000/v1",
          credentialEnv: "COMPATIBLE_API_KEY",
        },
        deps,
      ),
    ).resolves.toEqual({ done: false });

    expect(deps.upsertProvider).toHaveBeenCalledWith(
      "compatible-endpoint",
      "openai",
      "COMPATIBLE_API_KEY",
      "http://host.openshell.internal:8000/v1",
      { COMPATIBLE_API_KEY: "dummy-key" },
    );
    expect(deps.runOpenshell).toHaveBeenCalledWith(
      [
        "inference",
        "set",
        "--no-verify",
        "--provider",
        "compatible-endpoint",
        "--model",
        "Qwen/Qwen2.5-1.5B-Instruct",
        "--timeout",
        "180",
      ],
      { ignoreError: true },
    );
  });
});
