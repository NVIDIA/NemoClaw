// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { setupOllamaLocalInference } from "./inference-providers/ollama-local";
import { bindOpenAiProviderProfile, createProviderReviewDeps } from "./setup-inference";

describe("bindOpenAiProviderProfile", () => {
  it("imports the profile immediately before an OpenAI provider upsert", () => {
    const events: string[] = [];
    const profileEvents = ["profile-export", "profile-import", "profile-reexport"];
    const profileResults = [
      { status: 1, stdout: "", stderr: "provider profile not found" },
      { status: 0, stdout: "", stderr: "" },
      {
        status: 0,
        stdout: JSON.stringify({
          id: "openai",
          credentials: [],
          endpoints: [],
          binaries: [],
          inference_capable: true,
        }),
        stderr: "",
      },
    ];
    let profileIndex = 0;
    const runOpenshell = vi.fn(() => {
      events.push(profileEvents[profileIndex]!);
      return profileResults[profileIndex++]!;
    });
    const upsertProvider = vi.fn(() => {
      events.push("upsert");
      return { ok: true };
    });
    const profiledUpsert = bindOpenAiProviderProfile(
      upsertProvider,
      runOpenshell,
      vi.fn(),
      (code): never => {
        throw new Error(`exit ${code}`);
      },
    );

    expect(
      profiledUpsert(
        "compatible-endpoint",
        "openai",
        "COMPATIBLE_API_KEY",
        "https://inference.example/v1",
        { COMPATIBLE_API_KEY: "test-secret" },
      ),
    ).toEqual({ ok: true });

    expect(events).toEqual(["profile-export", "profile-import", "profile-reexport", "upsert"]);
    expect(runOpenshell).toHaveBeenNthCalledWith(
      1,
      ["provider", "profile", "export", "openai", "--output", "json"],
      {
        ignoreError: true,
        suppressOutput: true,
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(runOpenshell).toHaveBeenNthCalledWith(
      2,
      ["provider", "profile", "import", "--file", expect.stringMatching(/openai\.yaml$/u)],
      {
        ignoreError: true,
        suppressOutput: true,
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(runOpenshell).toHaveBeenNthCalledWith(
      3,
      ["provider", "profile", "export", "openai", "--output", "json"],
      {
        ignoreError: true,
        suppressOutput: true,
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  });

  it("does not import the OpenAI profile for another provider type", () => {
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const upsertProvider = vi.fn(() => ({ ok: true }));
    const profiledUpsert = bindOpenAiProviderProfile(
      upsertProvider,
      runOpenshell,
      vi.fn(),
      (code): never => {
        throw new Error(`exit ${code}`);
      },
    );

    expect(
      profiledUpsert(
        "anthropic-prod",
        "anthropic",
        "ANTHROPIC_API_KEY",
        "https://api.anthropic.com",
        {},
      ),
    ).toEqual({ ok: true });
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it.each([
    {
      reason: "import failure",
      results: [
        { status: 1, stdout: "", stderr: "provider profile not found" },
        { status: 1, stdout: "", stderr: "sensitive-import-output" },
      ],
      expected: "could not import the checked-in 'openai' inference provider profile",
      guidance: "OpenShell is available and authorized",
    },
    {
      reason: "export failure",
      results: [{ status: 1, stdout: "sensitive-export-output", stderr: "" }],
      expected: "could not be read for validation",
      guidance: "OpenShell is available, authorized, and the profile is readable",
    },
    {
      reason: "incompatible profile",
      results: [
        {
          status: 0,
          stdout: JSON.stringify({
            id: "openai",
            credentials: ["sensitive-profile-field"],
            endpoints: [],
            binaries: [],
            inference_capable: true,
          }),
          stderr: "",
        },
      ],
      expected: "does not match NemoClaw's endpointless inference contract",
      guidance: "Remove the conflicting profile",
    },
  ])("fails closed with fixed guidance for $reason", ({ results, expected, guidance }) => {
    let resultIndex = 0;
    const runOpenshell = vi.fn(() => results[resultIndex++]!);
    const upsertProvider = vi.fn(() => ({ ok: true }));
    const error = vi.fn();
    const profiledUpsert = bindOpenAiProviderProfile(
      upsertProvider,
      runOpenshell,
      error,
      (code): never => {
        throw new Error(`exit ${code}`);
      },
    );

    expect(() =>
      profiledUpsert(
        "compatible-endpoint",
        "openai",
        "COMPATIBLE_API_KEY",
        "https://inference.example/v1",
        {},
      ),
    ).toThrow("exit 1");

    expect(upsertProvider).not.toHaveBeenCalled();
    const output = error.mock.calls.flat().join("\n");
    expect(output).toContain(expected);
    expect(output).toContain(guidance);
    expect(output).not.toMatch(/sensitive-(?:import|export|profile)-/u);
  });
});

describe("createProviderReviewDeps", () => {
  it("prepares the Ollama proxy after review acceptance", async () => {
    const updateSession = vi.fn();
    const checkpointSandboxName = vi.fn(async () => undefined);
    const startOllamaAuthProxy = vi.fn(() => true);
    const persistAndProbeOllamaProxy = vi.fn(async () => undefined);
    const exitProcess = vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    });
    const getOllamaProxyToken = vi.fn(() => "proxy-token");
    const deps = createProviderReviewDeps(
      updateSession,
      checkpointSandboxName,
      {
        shouldFrontOllamaWithProxy: () => true,
        startOllamaAuthProxy,
        getOllamaProxyToken,
        persistAndProbeOllamaProxy,
      },
      exitProcess,
      vi.fn(),
    );

    const preparedToken = await deps.prepareLocalProviderForInference("ollama-local");

    expect(startOllamaAuthProxy).toHaveBeenCalledOnce();
    expect(getOllamaProxyToken).toHaveBeenCalledOnce();
    expect(persistAndProbeOllamaProxy).toHaveBeenCalledWith("proxy-token");
    expect(preparedToken).toBe("proxy-token");
  });

  it("does not mutate local provider state for another provider", async () => {
    const startOllamaAuthProxy = vi.fn(() => true);
    const persistAndProbeOllamaProxy = vi.fn(async () => undefined);
    const deps = createProviderReviewDeps(
      vi.fn(),
      vi.fn(async () => undefined),
      {
        shouldFrontOllamaWithProxy: () => true,
        startOllamaAuthProxy,
        getOllamaProxyToken: () => "proxy-token",
        persistAndProbeOllamaProxy,
      },
      (code): never => {
        throw new Error(`exit ${code}`);
      },
      vi.fn(),
    );

    await expect(deps.prepareLocalProviderForInference("nvidia-prod")).resolves.toBeNull();

    expect(startOllamaAuthProxy).not.toHaveBeenCalled();
    expect(persistAndProbeOllamaProxy).not.toHaveBeenCalled();
  });

  it("exits without persisting when the Ollama proxy cannot start", async () => {
    const persistAndProbeOllamaProxy = vi.fn(async () => undefined);
    const exitProcess = vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    });
    const deps = createProviderReviewDeps(
      vi.fn(),
      vi.fn(async () => undefined),
      {
        shouldFrontOllamaWithProxy: () => true,
        startOllamaAuthProxy: () => false,
        getOllamaProxyToken: () => "proxy-token",
        persistAndProbeOllamaProxy,
      },
      exitProcess,
      vi.fn(),
    );

    await expect(deps.prepareLocalProviderForInference("ollama-local")).rejects.toThrow("exit 1");

    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(persistAndProbeOllamaProxy).not.toHaveBeenCalled();
  });

  it("exits without persisting when the Ollama proxy token is unavailable", async () => {
    const persistAndProbeOllamaProxy = vi.fn(async () => undefined);
    const exitProcess = vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    });
    const writeError = vi.fn();
    const deps = createProviderReviewDeps(
      vi.fn(),
      vi.fn(async () => undefined),
      {
        shouldFrontOllamaWithProxy: () => true,
        startOllamaAuthProxy: () => true,
        getOllamaProxyToken: () => null,
        persistAndProbeOllamaProxy,
      },
      exitProcess,
      writeError,
    );

    await expect(deps.prepareLocalProviderForInference("ollama-local")).rejects.toThrow("exit 1");

    expect(writeError).toHaveBeenCalledWith(expect.stringContaining("proxy token is not set"));
    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(persistAndProbeOllamaProxy).not.toHaveBeenCalled();
  });

  it("hands the accepted proxy token to provider setup without repeating proxy mutations", async () => {
    const startOllamaAuthProxy = vi.fn(() => true);
    const getOllamaProxyToken = vi.fn(() => "proxy-token");
    const persistAndProbeOllamaProxy = vi.fn(async () => undefined);
    const reviewDeps = createProviderReviewDeps(
      vi.fn(),
      vi.fn(async () => undefined),
      {
        shouldFrontOllamaWithProxy: () => true,
        startOllamaAuthProxy,
        getOllamaProxyToken,
        persistAndProbeOllamaProxy,
      },
      (code): never => {
        throw new Error(`exit ${code}`);
      },
      vi.fn(),
    );
    const preparedProxyToken = await reviewDeps.prepareLocalProviderForInference("ollama-local");
    const ensureOllamaAuthProxy = vi.fn();

    await setupOllamaLocalInference(
      {
        model: "qwen3.5:9b",
        provider: "ollama-local",
        allowToolsIncompatible: false,
        preparedProxyToken: preparedProxyToken ?? undefined,
      },
      {
        runOpenshell: () => ({ status: 0 }),
        upsertProvider: () => ({ ok: true }),
        verifyInferenceRoute: vi.fn(),
        verifyOnboardInferenceSmoke: vi.fn(),
        isNonInteractive: () => true,
        registry: { updateSandbox: vi.fn() as never },
        exitProcess: (code): never => {
          throw new Error(`exit ${code}`);
        },
        error: vi.fn(),
        log: vi.fn(),
        validateLocalProvider: () => ({ ok: true }),
        getLocalProviderBaseUrl: () => "http://host.openshell.internal:11435/v1",
        applyLocalInferenceRoute: async () => false,
        getOllamaWarmupCommand: () => ["ollama", "run", "qwen3.5:9b"],
        run: vi.fn() as never,
        shouldFrontOllamaWithProxy: () => true,
        ensureOllamaAuthProxy,
        isProxyHealthy: () => true,
        getOllamaProxyToken,
        persistAndProbeOllamaProxy,
        localInference: {
          validateOllamaModelWithToolsOverride: () => ({ ok: true }),
          validateSandboxFacingOllamaModel: () => ({ ok: true }),
        },
        OLLAMA_PROXY_CREDENTIAL_ENV: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
      },
    );

    expect(startOllamaAuthProxy).toHaveBeenCalledOnce();
    expect(getOllamaProxyToken).toHaveBeenCalledOnce();
    expect(persistAndProbeOllamaProxy).toHaveBeenCalledOnce();
    expect(ensureOllamaAuthProxy).not.toHaveBeenCalled();
  });
});
