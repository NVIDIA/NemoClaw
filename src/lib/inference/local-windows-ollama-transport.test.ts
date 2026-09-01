// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyOllamaRuntimeContextWindow,
  clearPersistedOllamaHostIfUnused,
  CONTAINER_REACHABILITY_IMAGE,
  findReachableOllamaHost,
  getOllamaApiCommand,
  getOllamaHostForCleanup,
  getOllamaModelOptions,
  getResolvedOllamaHost,
  OLLAMA_HOST_DOCKER_INTERNAL,
  loadPersistedOllamaHost,
  persistResolvedOllamaHost,
  probeLocalProviderHealth,
  probeOllamaModelCapabilities,
  resetOllamaHostCache,
  resetOllamaRuntimeContextWindowAutoState,
  setResolvedOllamaHost,
  validateLocalProvider,
  validateOllamaModel,
} from "./local";

describe("Windows-host Ollama transport", () => {
  afterEach(() => {
    resetOllamaHostCache();
    resetOllamaRuntimeContextWindowAutoState();
  });

  it("selects Docker Desktop only for the Windows-host transport owner", () => {
    expect(
      getOllamaApiCommand(
        ["-sf", "http://host.docker.internal:11434/api/tags"],
        OLLAMA_HOST_DOCKER_INTERNAL,
      ),
    ).toEqual([
      "docker",
      "run",
      "--rm",
      CONTAINER_REACHABILITY_IMAGE,
      "-sf",
      "http://host.docker.internal:11434/api/tags",
    ]);
    expect(getOllamaApiCommand(["-sf", "http://127.0.0.1:11434/api/tags"], "127.0.0.1")).toEqual([
      "curl",
      "-sf",
      "http://127.0.0.1:11434/api/tags",
    ]);
  });

  it("restores the accepted route for cleanup in a fresh process", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "nemoclaw-ollama-host-receipt-"));
    try {
      setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
      persistResolvedOllamaHost(undefined, stateRoot);
      resetOllamaHostCache();

      expect(loadPersistedOllamaHost(stateRoot)).toBe(OLLAMA_HOST_DOCKER_INTERNAL);
      expect(getOllamaHostForCleanup(stateRoot)).toBe(OLLAMA_HOST_DOCKER_INTERNAL);
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("restores the prior receipt when staged provider setup rolls back", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "nemoclaw-ollama-host-rollback-"));
    try {
      persistResolvedOllamaHost("127.0.0.1", stateRoot);
      const rollback = persistResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL, stateRoot);
      expect(loadPersistedOllamaHost(stateRoot)).toBe(OLLAMA_HOST_DOCKER_INTERNAL);

      rollback();

      expect(loadPersistedOllamaHost(stateRoot)).toBe("127.0.0.1");
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("retires the final persisted route after Ollama ownership ends", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "nemoclaw-ollama-host-retire-"));
    try {
      persistResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL, stateRoot);

      expect(clearPersistedOllamaHostIfUnused(["nvidia-prod"], stateRoot)).toBe(true);
      expect(loadPersistedOllamaHost(stateRoot)).toBeNull();
      expect(getOllamaHostForCleanup(stateRoot)).toBe("127.0.0.1");
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("retains the persisted route while another Ollama sandbox owns it", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "nemoclaw-ollama-host-retain-"));
    try {
      persistResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL, stateRoot);

      expect(clearPersistedOllamaHostIfUnused(["ollama-local"], stateRoot)).toBe(false);
      expect(loadPersistedOllamaHost(stateRoot)).toBe(OLLAMA_HOST_DOCKER_INTERNAL);
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("re-probes a stale persisted route before fresh-process connect discovery", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "nemoclaw-ollama-host-connect-"));
    try {
      persistResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL, stateRoot);
      resetOllamaHostCache();
      const capture = vi.fn((command: readonly string[]) =>
        command.includes("http://127.0.0.1:11434/api/tags") ? JSON.stringify({ models: [] }) : "",
      );

      expect(findReachableOllamaHost(capture, { isWsl: true }, stateRoot)).toBe("127.0.0.1");
      expect(capture).toHaveBeenCalledTimes(2);
      expect(capture.mock.calls[0]?.[0]).toEqual(
        expect.arrayContaining(["docker", "run", "http://host.docker.internal:11434/api/tags"]),
      );
      expect(capture.mock.calls[1]?.[0]).toEqual(
        expect.arrayContaining(["curl", "http://127.0.0.1:11434/api/tags"]),
      );
      expect(loadPersistedOllamaHost(stateRoot)).toBeNull();
      expect(getResolvedOllamaHost()).toBe("127.0.0.1");
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("rejects an untrusted persisted host", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "nemoclaw-ollama-host-invalid-"));
    try {
      writeFileSync(
        join(stateRoot, "ollama-host.json"),
        JSON.stringify({ schemaVersion: 1, host: "example.com" }),
      );
      resetOllamaHostCache();

      expect(loadPersistedOllamaHost(stateRoot)).toBeNull();
      expect(getOllamaHostForCleanup(stateRoot)).toBe("127.0.0.1");
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("probes persisted Windows-host health through Docker Desktop", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "nemoclaw-ollama-host-health-"));
    try {
      persistResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL, stateRoot);
      resetOllamaHostCache();
      setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);

      const result = probeLocalProviderHealth("ollama-local", {
        findReachableOllamaHostImpl: () => OLLAMA_HOST_DOCKER_INTERNAL,
        loadOllamaProxyTokenImpl: () => null,
        ollamaRunCaptureExImpl: () => ({
          stdout: JSON.stringify({ models: [] }),
          stderr: "",
          exitCode: 0,
          timedOut: false,
        }),
      });

      expect(result).toMatchObject({
        ok: true,
        endpoint: "http://host.docker.internal:11434/api/tags",
      });
    } finally {
      resetOllamaHostCache();
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("reads the model inventory through Docker Desktop (#10553)", () => {
    setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
    const capture = vi.fn(() => JSON.stringify({ models: [{ name: "qwen3.5:9b" }] }));

    expect(getOllamaModelOptions(capture)).toEqual(["qwen3.5:9b"]);
  });

  it("validates a Windows-host model through Docker Desktop (#10553)", () => {
    setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
    const capture = vi.fn(() => JSON.stringify({ capabilities: ["tools"] }));
    const captureEx = vi.fn(() => ({
      stdout: JSON.stringify({ done: true, response: "ready" }),
      stderr: "",
      exitCode: 0,
      timedOut: false,
    }));

    expect(validateOllamaModel("qwen3.5:9b", capture, () => false, captureEx)).toEqual({
      ok: true,
    });
  });

  it("validates health and container reachability through Docker Desktop (#10553)", () => {
    setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
    const capture = vi.fn((_command: readonly string[]) => JSON.stringify({ models: [] }));

    expect(
      validateLocalProvider(
        "ollama-local",
        capture,
        () => {},
        () => ({
          env: {},
          isolatedCredentialConfig: false,
          cleanup: () => ({ ok: true }),
        }),
      ),
    ).toEqual({ ok: true });
  });

  it("checks the Hermes context window through Docker Desktop (#10553)", () => {
    setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
    const capture = vi.fn((command: readonly string[]) =>
      String(command.at(-1)).endsWith("/api/ps")
        ? JSON.stringify({
            models: [{ name: "qwen3.5:9b", context_length: 65_536, processor: "100% GPU" }],
          })
        : "",
    );
    const env: NodeJS.ProcessEnv = {};

    expect(
      applyOllamaRuntimeContextWindow("qwen3.5:9b", {
        contextWindowFloor: 64_000,
        env,
        logger: { log: vi.fn(), warn: vi.fn() },
        runCaptureImpl: capture,
      }),
    ).toEqual({ ok: true });
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("65536");
  });

  it("checks model capability metadata through Docker Desktop (#10553)", () => {
    setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
    const capture = vi.fn((_command: readonly string[]) =>
      JSON.stringify({ capabilities: ["tools"] }),
    );

    expect(probeOllamaModelCapabilities("qwen3.5:9b", capture)).toMatchObject({
      source: "api",
      supportsTools: true,
    });
  });

  it("keeps the Hermes context-window check fail-closed on an invalid Docker response (#10553)", () => {
    setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
    const capture = vi.fn((_command: readonly string[]) =>
      JSON.stringify({ models: [{ name: "qwen3.5:9b", context_length: "invalid" }] }),
    );

    const result = applyOllamaRuntimeContextWindow("qwen3.5:9b", {
      contextWindowFloor: 64_000,
      env: {},
      logger: { log: vi.fn(), warn: vi.fn() },
      runCaptureImpl: capture,
    });

    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining("cannot verify the required 64000-token window"),
    });
  });
});
