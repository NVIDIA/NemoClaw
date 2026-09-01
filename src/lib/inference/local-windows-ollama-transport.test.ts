// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyOllamaRuntimeContextWindow,
  CONTAINER_REACHABILITY_IMAGE,
  getOllamaModelOptions,
  getOllamaProbeCommand,
  getOllamaWarmupRequestCommand,
  OLLAMA_HOST_DOCKER_INTERNAL,
  probeOllamaModelCapabilities,
  resetOllamaHostCache,
  resetOllamaRuntimeContextWindowAutoState,
  setResolvedOllamaHost,
} from "./local";

describe("Windows-host Ollama transport", () => {
  afterEach(() => {
    resetOllamaHostCache();
    resetOllamaRuntimeContextWindowAutoState();
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
      "http://host.docker.internal:11434/api/generate",
      "-H",
      "Content-Type: application/json",
      "-d",
      expect.stringContaining('"model":"qwen3.5:9b"'),
    ]);
  });

  it("checks the Hermes context window and model metadata through Docker Desktop (#10553)", () => {
    setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
    const responses: Record<string, string> = {
      "http://host.docker.internal:11434/api/ps": JSON.stringify({
        models: [{ name: "qwen3.5:9b", context_length: 65_536, processor: "100% GPU" }],
      }),
      "http://host.docker.internal:11434/api/show": JSON.stringify({ capabilities: ["tools"] }),
    };
    const capture = vi.fn((command: readonly string[]) => {
      return responses[String(command.at(-1))] ?? "";
    });
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
    expect(probeOllamaModelCapabilities("qwen3.5:9b", capture)).toMatchObject({
      source: "api",
      supportsTools: true,
    });
    expect(capture).toHaveBeenCalledTimes(2);
    capture.mock.calls.forEach(([command]) => {
      expect(command).toEqual(
        expect.arrayContaining(["docker", "run", "--rm", CONTAINER_REACHABILITY_IMAGE]),
      );
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
    expect(capture.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(["docker", "run", "--rm", CONTAINER_REACHABILITY_IMAGE]),
    );
  });
});
