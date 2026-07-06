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
        // Mirrors production: compatible endpoints already skip OpenShell's
        // verifier; these tests focus on which base URL gets registered.
        skipVerify: true,
      },
      openai: {
        label: "OpenAI API",
        providerName: "openai-api",
        providerType: "openai",
        credentialEnv: "OPENAI_API_KEY",
        endpointUrl: "https://api.openai.com/v1",
        helpUrl: null,
        modelMode: "input",
        defaultModel: "gpt-4.1",
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
  const model = "Qwen/Qwen2.5-1.5B-Instruct";

  it("uses a sandbox-facing host alias for loopback compatible endpoints (#5744)", async () => {
    const deps = makeDeps();

    await expect(
      setupRemoteProviderInference(
        {
          sandboxName: "dcode-vllm-local",
          model,
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
        model,
        "--timeout",
        "180",
      ],
      { ignoreError: true },
    );
  });

  it.each([
    ["IPv6 loopback", "http://[::1]:8000/v1", "http://host.openshell.internal:8000/v1"],
    [
      "first unprivileged port",
      "http://localhost:1024/v1",
      "http://host.openshell.internal:1024/v1",
    ],
  ])("rewrites %s compatible endpoint routes (#5744)", async (_name, endpointUrl, expectedUrl) => {
    const deps = makeDeps();

    await expect(
      setupRemoteProviderInference(
        {
          sandboxName: "dcode-vllm-local",
          model,
          provider: "compatible-endpoint",
          endpointUrl,
          credentialEnv: "COMPATIBLE_API_KEY",
        },
        deps,
      ),
    ).resolves.toEqual({ done: false });

    expect(deps.upsertProvider).toHaveBeenCalledWith(
      "compatible-endpoint",
      "openai",
      "COMPATIBLE_API_KEY",
      expectedUrl,
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
        model,
        "--timeout",
        "180",
      ],
      { ignoreError: true },
    );
  });

  it("uses the gateway alias when reusing an existing loopback compatible provider (#5744)", async () => {
    const deps = makeDeps();

    await expect(
      setupRemoteProviderInference(
        {
          sandboxName: "dcode-vllm-local",
          model,
          provider: "compatible-endpoint",
          endpointUrl: "http://127.0.0.1:8000/v1",
          credentialEnv: "COMPATIBLE_API_KEY",
          reuseGatewayCredentialWithoutLocalKey: true,
        },
        deps,
      ),
    ).resolves.toEqual({ done: false });

    expect(deps.upsertProvider).not.toHaveBeenCalled();
    expect(deps.runOpenshell).toHaveBeenNthCalledWith(
      1,
      ["provider", "get", "compatible-endpoint"],
      {
        ignoreError: true,
        suppressOutput: true,
      },
    );
    expect(deps.runOpenshell).toHaveBeenNthCalledWith(
      2,
      [
        "inference",
        "set",
        "--no-verify",
        "--provider",
        "compatible-endpoint",
        "--model",
        model,
        "--timeout",
        "180",
      ],
      { ignoreError: true },
    );
  });

  it("keeps the original provider route when reusing an existing non-loopback compatible provider (#5744)", async () => {
    const deps = makeDeps();

    await expect(
      setupRemoteProviderInference(
        {
          sandboxName: "dcode-vllm-local",
          model,
          provider: "compatible-endpoint",
          endpointUrl: "http://10.0.0.1:8000/v1",
          credentialEnv: "COMPATIBLE_API_KEY",
          reuseGatewayCredentialWithoutLocalKey: true,
        },
        deps,
      ),
    ).resolves.toEqual({ done: false });

    expect(deps.upsertProvider).not.toHaveBeenCalled();
    expect(deps.runOpenshell).toHaveBeenNthCalledWith(
      1,
      ["provider", "get", "compatible-endpoint"],
      {
        ignoreError: true,
        suppressOutput: true,
      },
    );
    expect(deps.runOpenshell).toHaveBeenNthCalledWith(
      2,
      [
        "inference",
        "set",
        "--no-verify",
        "--provider",
        "compatible-endpoint",
        "--model",
        model,
        "--timeout",
        "180",
      ],
      { ignoreError: true },
    );
  });

  it.each([
    ["HTTPS loopback", "compatible-endpoint", "https://localhost:8000/v1"],
    ["non-loopback host", "compatible-endpoint", "http://10.0.0.1:8000/v1"],
    ["missing explicit port", "compatible-endpoint", "http://localhost/v1"],
    ["privileged port", "compatible-endpoint", "http://localhost:1023/v1"],
    ["IPv6 zone ID", "compatible-endpoint", "http://[::1%25eth0]:8000/v1"],
    ["embedded URL credentials", "compatible-endpoint", "http://user:pass@localhost:8000/v1"],
    ["malformed URL", "compatible-endpoint", "not a url"],
    ["non-compatible provider", "openai-api", "http://localhost:8000/v1"],
  ])("does not rewrite %s endpoints", async (_name, provider, endpointUrl) => {
    const deps = makeDeps();
    const credentialEnv =
      provider === "compatible-endpoint" ? "COMPATIBLE_API_KEY" : "OPENAI_API_KEY";

    await expect(
      setupRemoteProviderInference(
        {
          sandboxName: "dcode-vllm-local",
          model,
          provider,
          endpointUrl,
          credentialEnv,
        },
        deps,
      ),
    ).resolves.toEqual({ done: false });

    expect(deps.upsertProvider).toHaveBeenCalledWith(
      provider,
      "openai",
      credentialEnv,
      endpointUrl,
      { [credentialEnv]: "dummy-key" },
    );
    expect(deps.runOpenshell).toHaveBeenCalledWith(
      [
        "inference",
        "set",
        ...(provider === "compatible-endpoint" ? ["--no-verify"] : []),
        "--provider",
        provider,
        "--model",
        model,
        ...(provider === "compatible-endpoint" ? ["--timeout", "180"] : []),
      ],
      { ignoreError: true },
    );
  });
});
