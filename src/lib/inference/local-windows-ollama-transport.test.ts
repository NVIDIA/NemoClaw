// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONTAINER_REACHABILITY_IMAGE,
  getOllamaModelOptions,
  getOllamaProbeCommand,
  getOllamaWarmupCommand,
  OLLAMA_HOST_DOCKER_INTERNAL,
  resetOllamaHostCache,
  setResolvedOllamaHost,
} from "./local";

describe("Windows-host Ollama transport", () => {
  afterEach(() => {
    resetOllamaHostCache();
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

  it("warms and validates models through Docker Desktop (#10553)", () => {
    setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);

    const warmup = getOllamaWarmupCommand("qwen3.5:9b");
    expect(warmup[2]).toContain(`'docker' 'run' '--rm' '${CONTAINER_REACHABILITY_IMAGE}'`);
    expect(warmup[2]).toContain("http://host.docker.internal:11434/api/generate");

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
});
