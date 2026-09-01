// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyOllamaRuntimeContextWindow,
  CONTAINER_REACHABILITY_IMAGE,
  findReachableOllamaHost,
  getLocalProviderHealthCheck,
  getOllamaHostForCleanup,
  getOllamaModelOptions,
  getOllamaProbeCommand,
  getResolvedOllamaHost,
  getOllamaWarmupRequestCommand,
  OLLAMA_HOST_DOCKER_INTERNAL,
  loadPersistedOllamaHost,
  persistResolvedOllamaHost,
  probeLocalProviderHealth,
  probeOllamaModelCapabilities,
  resetOllamaHostCache,
  resetOllamaRuntimeContextWindowAutoState,
  setResolvedOllamaHost,
  validateLocalProvider,
} from "./local";

describe("Windows-host Ollama transport", () => {
  afterEach(() => {
    resetOllamaHostCache();
    resetOllamaRuntimeContextWindowAutoState();
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

  it("restores the persisted route before fresh-process connect discovery", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "nemoclaw-ollama-host-connect-"));
    try {
      persistResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL, stateRoot);
      resetOllamaHostCache();
      const capture = vi.fn(() => {
        throw new Error("fresh-process connect must not probe WSL loopback");
      });

      expect(findReachableOllamaHost(capture, {}, stateRoot)).toBe(OLLAMA_HOST_DOCKER_INTERNAL);
      expect(capture).not.toHaveBeenCalled();
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
      expect(getResolvedOllamaHost(stateRoot)).toBe("127.0.0.1");
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("probes persisted Windows-host health through Docker Desktop", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "nemoclaw-ollama-host-health-"));
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    try {
      persistResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL, stateRoot);
      resetOllamaHostCache();
      expect(getResolvedOllamaHost(stateRoot)).toBe(OLLAMA_HOST_DOCKER_INTERNAL);

      const result = probeLocalProviderHealth("ollama-local", {
        loadOllamaProxyTokenImpl: () => null,
        ollamaSpawnSyncImpl: (command, args) => {
          calls.push({ command, args });
          const statusOutput = args[args.indexOf("-w") + 1].replace("%{http_code}", "200");
          const stdout = `${JSON.stringify({ models: [] })}${statusOutput}`;
          return {
            pid: 1,
            output: ["", stdout, ""],
            stdout,
            stderr: "",
            status: 0,
            signal: null,
          };
        },
      });

      expect(result).toMatchObject({
        ok: true,
        endpoint: "http://host.docker.internal:11434/api/tags",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ command: "docker" });
      expect(calls[0]?.args).toEqual(
        expect.arrayContaining([
          "run",
          "--rm",
          CONTAINER_REACHABILITY_IMAGE,
          "http://host.docker.internal:11434/api/tags",
        ]),
      );
    } finally {
      resetOllamaHostCache();
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("reads the model inventory through Docker Desktop (#10553)", () => {
    setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
    const capture = vi.fn(() => JSON.stringify({ models: [{ name: "qwen3.5:9b" }] }));

    expect(getOllamaModelOptions(capture)).toEqual(["qwen3.5:9b"]);
    expect(capture).toHaveBeenCalledWith(
      [
        "docker",
        "run",
        "--rm",
        CONTAINER_REACHABILITY_IMAGE,
        "-sf",
        "--connect-timeout",
        "3",
        "--max-time",
        "5",
        "http://host.docker.internal:11434/api/tags",
      ],
      { ignoreError: true },
    );
  });

  it("builds warm-up and validation requests for Docker Desktop (#10553)", () => {
    setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);

    expect(getOllamaWarmupRequestCommand("qwen3.5:9b")).toEqual([
      "docker",
      "run",
      "--rm",
      CONTAINER_REACHABILITY_IMAGE,
      "-s",
      "--connect-timeout",
      "10",
      "--max-time",
      "120",
      "http://host.docker.internal:11434/api/generate",
      "-H",
      "Content-Type: application/json",
      "-d",
      expect.stringContaining('"model":"qwen3.5:9b"'),
    ]);

    expect(getOllamaProbeCommand("qwen3.5:9b")).toEqual([
      "docker",
      "run",
      "--rm",
      CONTAINER_REACHABILITY_IMAGE,
      "-sS",
      "--max-time",
      "120",
      "-H",
      "Content-Type: application/json",
      "-d",
      expect.stringContaining('"model":"qwen3.5:9b"'),
      "http://host.docker.internal:11434/api/generate",
    ]);
  });

  it("validates health and container reachability through Docker Desktop (#10553)", () => {
    setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
    const capture = vi.fn((_command: readonly string[]) => JSON.stringify({ models: [] }));

    expect(getLocalProviderHealthCheck("ollama-local")).toEqual([
      "docker",
      "run",
      "--rm",
      CONTAINER_REACHABILITY_IMAGE,
      "-sf",
      "http://host.docker.internal:11434/api/tags",
    ]);
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

    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        "docker",
        "run",
        "--rm",
        CONTAINER_REACHABILITY_IMAGE,
        "http://host.docker.internal:11434/api/tags",
      ]),
    );
    expect(capture.mock.calls[1]?.[0]).toEqual(
      expect.arrayContaining([
        "docker",
        "run",
        "--rm",
        "--add-host",
        "host.openshell.internal:host-gateway",
        "http://host.openshell.internal:11434/api/tags",
      ]),
    );
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
    expect(capture).toHaveBeenCalledOnce();
    expect(capture.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        "docker",
        "run",
        "--rm",
        CONTAINER_REACHABILITY_IMAGE,
        "http://host.docker.internal:11434/api/ps",
      ]),
    );
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
    expect(capture).toHaveBeenCalledOnce();
    expect(capture.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        "docker",
        "run",
        "--rm",
        CONTAINER_REACHABILITY_IMAGE,
        "http://host.docker.internal:11434/api/show",
      ]),
    );
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
    expect(capture.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        "docker",
        "run",
        "--rm",
        CONTAINER_REACHABILITY_IMAGE,
        "http://host.docker.internal:11434/api/ps",
      ]),
    );
  });
});
