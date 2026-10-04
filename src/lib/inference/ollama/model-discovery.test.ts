// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { waitForPulledOllamaModel } from "./model-discovery";

describe("waitForPulledOllamaModel", () => {
  it("returns immediately when Ollama already lists the pulled model", () => {
    const getModelOptions = vi.fn(() => ["qwen3.5:9b"]);
    const sleep = vi.fn();

    expect(
      waitForPulledOllamaModel("qwen3.5:9b", {
        getModelOptions,
        now: () => 0,
        sleep,
      }),
    ).toBe(true);
    expect(getModelOptions).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    ["llama3.2", "llama3.2:latest"],
    ["registry.example:5000/acme/model", "registry.example:5000/acme/model:latest"],
    ["acme/model:7b", "acme/model:7b"],
    ["acme/model@sha256:abc", "acme/model@sha256:abc"],
    ["registry.example:5000/acme/model:tag:extra", "registry.example:5000/acme/model:tag:extra"],
  ])("matches pulled model reference %s to listed reference %s", (requested, listed) => {
    expect(
      waitForPulledOllamaModel(requested, {
        getModelOptions: () => [listed],
        now: () => 0,
        sleep: () => {},
      }),
    ).toBe(true);
  });

  it("does not match a different tag on the same model", () => {
    expect(
      waitForPulledOllamaModel("acme/model:7b", {
        getModelOptions: () => ["acme/model:8b"],
        now: () => 0,
        sleep: () => {},
      }),
    ).toBe(false);
  });

  it("compares malformed registry references literally without collapsing them", () => {
    expect(
      waitForPulledOllamaModel("registry.example:5000/acme/model:tag:extra", {
        getModelOptions: () => ["registry.example:5000/acme/model:tag:other"],
        now: () => 0,
        sleep: () => {},
      }),
    ).toBe(false);
  });

  it("retries model discovery with bounded backoff after a completed pull (#6038)", () => {
    const sleeps: number[] = [];
    let nowMs = 0;
    let attempts = 0;

    const discovered = waitForPulledOllamaModel("qwen3.5:9b", {
      getModelOptions: () => {
        attempts += 1;
        return attempts >= 3 ? ["qwen3.5:9b"] : [];
      },
      now: () => nowMs,
      sleep: (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
    });

    expect(discovered).toBe(true);
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([250, 500]);
  });

  it("fails after the bounded discovery window when Ollama never lists the model (#6038)", () => {
    const sleeps: number[] = [];
    let nowMs = 0;
    let attempts = 0;

    const discovered = waitForPulledOllamaModel("qwen3.5:9b", {
      getModelOptions: () => {
        attempts += 1;
        return [];
      },
      now: () => nowMs,
      sleep: (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
    });

    expect(discovered).toBe(false);
    expect(attempts).toBe(8);
    expect(sleeps).toEqual([250, 500, 1_000, 2_000, 2_000, 2_000, 2_000]);
  });

  it("stops when the deadline elapses before the attempt cap", () => {
    let nowMs = 0;
    let attempts = 0;

    const discovered = waitForPulledOllamaModel("qwen3.5:9b", {
      getModelOptions: () => {
        attempts += 1;
        return [];
      },
      now: () => nowMs,
      sleep: () => {
        nowMs = 10_000;
      },
    });

    expect(discovered).toBe(false);
    expect(attempts).toBe(1);
  });
});
