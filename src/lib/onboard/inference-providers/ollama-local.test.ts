// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../adapters/docker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/docker")>()),
  detectContainerRuntimeFromDockerInfo: vi.fn(() => "docker-desktop"),
}));
vi.mock("../../platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../platform")>()),
  containerCanReachHostLoopback: vi.fn(() => true),
}));

import {
  CONTAINER_REACHABILITY_IMAGE,
  loadPersistedOllamaHost,
  OLLAMA_HOST_DOCKER_INTERNAL,
  persistResolvedOllamaHost,
  resetOllamaHostCache,
  runOllamaWarmup,
  setResolvedOllamaHost,
} from "../../inference/local";
import { setupOllamaLocalInference } from "./ollama-local";
import type { OllamaDeps } from "./types";

const CREDENTIAL_ENV = "NEMOCLAW_OLLAMA_PROXY_TOKEN";

beforeEach(() => {
  vi.stubEnv("DOCKER_CONTEXT", "default");
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetOllamaHostCache();
});

const SANDBOX_ENDPOINT_MISMATCH =
  "Selected Ollama model 'llama3.2:1b' answers on http://127.0.0.1:11434, but the daemon the " +
  "sandbox reaches through http://host.openshell.internal:11434 does not serve it " +
  "(reported models: qwen3.5:2b, gemma4:26b).";

type OllamaDepsOverrides = Omit<Partial<OllamaDeps>, "localInference"> & {
  localInference?: Partial<OllamaDeps["localInference"]>;
};

function deps(overrides: OllamaDepsOverrides = {}): OllamaDeps {
  const { localInference, ...rest } = overrides;
  return {
    runOpenshell: vi.fn(() => ({ status: 0 })),
    upsertProvider: vi.fn(() => ({ ok: true })),
    verifyInferenceRoute: vi.fn(),
    verifyOnboardInferenceSmoke: vi.fn(),
    isNonInteractive: () => true,
    registry: { updateSandbox: vi.fn() as OllamaDeps["registry"]["updateSandbox"] },
    exitProcess: (code) => {
      throw new Error(`exit ${code}`);
    },
    error: vi.fn(),
    log: vi.fn(),
    validateLocalProvider: () => ({ ok: true }),
    getLocalProviderBaseUrl: () => "http://host.openshell.internal:11434/v1",
    applyLocalInferenceRoute: async () => false,
    run: vi.fn(() => ({ status: 0 })),
    shouldFrontOllamaWithProxy: () => false,
    ensureOllamaAuthProxy: vi.fn(),
    isProxyHealthy: () => true,
    getOllamaProxyToken: () => "token",
    persistAndProbeOllamaProxy: async () => {},
    localInference: {
      validateOllamaModelWithToolsOverride: () => ({ ok: true }),
      validateSandboxFacingOllamaModel: () => ({ ok: true }),
      runOllamaWarmup: vi.fn(),
      persistResolvedOllamaHost: () => () => {},
      ...localInference,
    },
    OLLAMA_PROXY_CREDENTIAL_ENV: CREDENTIAL_ENV,
    ...rest,
  };
}

describe("Ollama local provider sandbox-facing model gate", () => {
  it("refuses to record a route the sandbox endpoint cannot serve (#9454)", async () => {
    const upsertProvider = vi.fn(() => ({ ok: true }));
    const error = vi.fn();
    const validateSandboxFacingOllamaModel = vi.fn(() => ({
      ok: false,
      message: SANDBOX_ENDPOINT_MISMATCH,
    }));

    await expect(
      setupOllamaLocalInference(
        { model: "llama3.2:1b", provider: "ollama-local", allowToolsIncompatible: false },
        deps({
          upsertProvider,
          error,
          localInference: {
            validateOllamaModelWithToolsOverride: () => ({ ok: true }),
            validateSandboxFacingOllamaModel,
          },
        }),
      ),
    ).rejects.toThrow("exit 1");

    expect(validateSandboxFacingOllamaModel).toHaveBeenCalledWith("llama3.2:1b");
    expect(upsertProvider).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(`  ${SANDBOX_ENDPOINT_MISMATCH}`);
  });

  it("blocks even when every host-side check passes (#9454)", async () => {
    const validateOllamaModelWithToolsOverride = vi.fn(() => ({ ok: true }));
    const run = vi.fn<OllamaDeps["run"]>((_command) => ({ status: 0 }));

    await expect(
      setupOllamaLocalInference(
        { model: "llama3.2:1b", provider: "ollama-local", allowToolsIncompatible: false },
        deps({
          run,
          validateLocalProvider: () => ({ ok: true }),
          localInference: {
            validateOllamaModelWithToolsOverride,
            validateSandboxFacingOllamaModel: () => ({
              ok: false,
              message: SANDBOX_ENDPOINT_MISMATCH,
            }),
          },
        }),
      ),
    ).rejects.toThrow("exit 1");

    expect(validateOllamaModelWithToolsOverride).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("records the route when the sandbox endpoint serves the model", async () => {
    const upsertProvider = vi.fn(() => ({ ok: true }));
    const stateRoot = mkdtempSync(join(tmpdir(), "nemoclaw-ollama-provider-route-"));
    setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
    try {
      await expect(
        setupOllamaLocalInference(
          { model: "llama3.2:1b", provider: "ollama-local", allowToolsIncompatible: false },
          deps({
            upsertProvider,
            localInference: {
              persistResolvedOllamaHost: () => persistResolvedOllamaHost(undefined, stateRoot),
            },
          }),
        ),
      ).resolves.toEqual({ done: false });

      expect(upsertProvider).toHaveBeenCalledWith(
        "ollama-local",
        "openai",
        CREDENTIAL_ENV,
        "http://host.openshell.internal:11434/v1",
        { [CREDENTIAL_ENV]: "ollama" },
      );
      expect(loadPersistedOllamaHost(stateRoot)).toBe(OLLAMA_HOST_DOCKER_INTERNAL);
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("dispatches Windows-host warm-up through Docker Desktop", async () => {
    setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
    const run = vi.fn((_command: unknown) => ({ status: 0 }));
    const cleanup = vi.fn(() => ({ ok: true as const }));
    const protectionCapture = vi.fn((command: readonly string[]) =>
      command.join(" ").includes("Get-NetTCPConnection")
        ? "127.0.0.1"
        : command.includes("Host: rebinding.invalid")
          ? "403"
          : JSON.stringify({ models: [] }),
    );

    await expect(
      setupOllamaLocalInference(
        { model: "llama3.2:1b", provider: "ollama-local", allowToolsIncompatible: false },
        deps({
          run,
          localInference: {
            validateOllamaModelWithToolsOverride: () => ({ ok: true }),
            validateSandboxFacingOllamaModel: () => ({ ok: true }),
            runOllamaWarmup: (model, runImpl) =>
              runOllamaWarmup(
                model,
                runImpl,
                () => ({
                  env: { DOCKER_CONFIG: "/tmp/credential-free-docker" },
                  isolatedCredentialConfig: true,
                  cleanup,
                }),
                protectionCapture,
              ),
            persistResolvedOllamaHost: vi.fn(() => () => {}),
          },
        }),
      ),
    ).resolves.toEqual({ done: false });

    expect(run).toHaveBeenCalledWith(
      expect.arrayContaining([
        "docker",
        "run",
        "--rm",
        CONTAINER_REACHABILITY_IMAGE,
        "http://host.docker.internal:11434/api/generate",
      ]),
      {
        ignoreError: true,
        env: expect.objectContaining({
          DOCKER_CONFIG: "/tmp/credential-free-docker",
          DOCKER_CONTEXT: "default",
        }),
      },
    );
    expect(cleanup).toHaveBeenCalledTimes(3);
  });

  it("fails before provider registration when the cleanup route cannot be staged", async () => {
    const upsertProvider = vi.fn(() => ({ ok: true }));
    const error = vi.fn();

    await expect(
      setupOllamaLocalInference(
        { model: "llama3.2:1b", provider: "ollama-local", allowToolsIncompatible: false },
        deps({
          upsertProvider,
          error,
          localInference: {
            validateOllamaModelWithToolsOverride: () => ({ ok: true }),
            validateSandboxFacingOllamaModel: () => ({ ok: true }),
            persistResolvedOllamaHost: () => {
              throw new Error("state path is unsafe");
            },
          },
        }),
      ),
    ).rejects.toThrow("exit 1");

    expect(upsertProvider).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("state path is unsafe"));
  });

  it("restores the prior cleanup route when provider registration fails", async () => {
    const rollbackPersistedOllamaHost = vi.fn();
    const persistResolvedOllamaHost = vi.fn(() => rollbackPersistedOllamaHost);

    await expect(
      setupOllamaLocalInference(
        { model: "llama3.2:1b", provider: "ollama-local", allowToolsIncompatible: false },
        deps({
          upsertProvider: () => ({ ok: false, status: 1, message: "provider rejected" }),
          localInference: {
            validateOllamaModelWithToolsOverride: () => ({ ok: true }),
            validateSandboxFacingOllamaModel: () => ({ ok: true }),
            persistResolvedOllamaHost,
          },
        }),
      ),
    ).rejects.toThrow("exit 1");

    expect(persistResolvedOllamaHost).toHaveBeenCalledOnce();
    expect(rollbackPersistedOllamaHost).toHaveBeenCalledOnce();
  });

  it("restores the prior cleanup route when route application requests reselection", async () => {
    const rollbackPersistedOllamaHost = vi.fn();
    const persistResolvedOllamaHost = vi.fn(() => rollbackPersistedOllamaHost);

    await expect(
      setupOllamaLocalInference(
        { model: "llama3.2:1b", provider: "ollama-local", allowToolsIncompatible: false },
        deps({
          applyLocalInferenceRoute: async () => true,
          localInference: {
            validateOllamaModelWithToolsOverride: () => ({ ok: true }),
            validateSandboxFacingOllamaModel: () => ({ ok: true }),
            persistResolvedOllamaHost,
          },
        }),
      ),
    ).resolves.toEqual({ done: true, result: { retry: "selection" } });

    expect(persistResolvedOllamaHost).toHaveBeenCalledOnce();
    expect(rollbackPersistedOllamaHost).toHaveBeenCalledOnce();
  });

  it("restores the prior cleanup route when route application throws", async () => {
    const rollbackPersistedOllamaHost = vi.fn();
    const persistResolvedOllamaHost = vi.fn(() => rollbackPersistedOllamaHost);

    await expect(
      setupOllamaLocalInference(
        { model: "llama3.2:1b", provider: "ollama-local", allowToolsIncompatible: false },
        deps({
          applyLocalInferenceRoute: async () => {
            throw new Error("route application failed");
          },
          localInference: {
            validateOllamaModelWithToolsOverride: () => ({ ok: true }),
            validateSandboxFacingOllamaModel: () => ({ ok: true }),
            persistResolvedOllamaHost,
          },
        }),
      ),
    ).rejects.toThrow("route application failed");

    expect(persistResolvedOllamaHost).toHaveBeenCalledOnce();
    expect(rollbackPersistedOllamaHost).toHaveBeenCalledOnce();
  });

  it("restores the prior cleanup route when provider-owned proof mismatches", async () => {
    const rollbackPersistedOllamaHost = vi.fn();
    const persistResolvedOllamaHost = vi.fn(() => rollbackPersistedOllamaHost);

    await expect(
      setupOllamaLocalInference(
        { model: "llama3.2:1b", provider: "ollama-local", allowToolsIncompatible: false },
        deps({
          providerOwnedInferenceProof: {
            protocol: "openai-chat-completions",
            model: "ollama/wrong-model",
            toolCallingRequired: true,
          },
          localInference: {
            validateOllamaModelWithToolsOverride: () => ({ ok: true }),
            validateSandboxFacingOllamaModel: () => ({ ok: true }),
            persistResolvedOllamaHost,
          },
        }),
      ),
    ).rejects.toThrow("exit 1");

    expect(rollbackPersistedOllamaHost).toHaveBeenCalledOnce();
  });

  it("restores the prior cleanup route when model validation fails", async () => {
    const rollbackPersistedOllamaHost = vi.fn();
    const persistResolvedOllamaHost = vi.fn(() => rollbackPersistedOllamaHost);

    await expect(
      setupOllamaLocalInference(
        { model: "llama3.2:1b", provider: "ollama-local", allowToolsIncompatible: false },
        deps({
          localInference: {
            validateOllamaModelWithToolsOverride: () => ({
              ok: false,
              message: "model validation failed",
            }),
            validateSandboxFacingOllamaModel: () => ({ ok: true }),
            persistResolvedOllamaHost,
          },
        }),
      ),
    ).rejects.toThrow("exit 1");

    expect(rollbackPersistedOllamaHost).toHaveBeenCalledOnce();
  });

  it("restores the prior cleanup route when model warm-up throws", async () => {
    const rollbackPersistedOllamaHost = vi.fn();

    await expect(
      setupOllamaLocalInference(
        { model: "llama3.2:1b", provider: "ollama-local", allowToolsIncompatible: false },
        deps({
          localInference: {
            runOllamaWarmup: () => {
              throw new Error("warm-up transport failed");
            },
            validateOllamaModelWithToolsOverride: () => ({ ok: true }),
            validateSandboxFacingOllamaModel: () => ({ ok: true }),
            persistResolvedOllamaHost: () => rollbackPersistedOllamaHost,
          },
        }),
      ),
    ).rejects.toThrow("warm-up transport failed");

    expect(rollbackPersistedOllamaHost).toHaveBeenCalledOnce();
  });
});
