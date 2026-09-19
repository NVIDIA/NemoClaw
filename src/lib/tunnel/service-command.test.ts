// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveDefaultSandboxName, runStartCommand, runStopCommand } from "./service-command";
import { stopAll } from "./services";

describe("services command", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      NEMOCLAW_SANDBOX_NAME: process.env.NEMOCLAW_SANDBOX_NAME,
      NEMOCLAW_SANDBOX: process.env.NEMOCLAW_SANDBOX,
      SANDBOX_NAME: process.env.SANDBOX_NAME,
    };
    delete process.env.NEMOCLAW_SANDBOX_NAME;
    delete process.env.NEMOCLAW_SANDBOX;
    delete process.env.SANDBOX_NAME;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val !== undefined) {
        process.env[key] = val;
      } else {
        delete process.env[key];
      }
    }
  });

  it("returns a safe default sandbox name", () => {
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "alpha-1" }))).toBe("alpha-1");
  });

  it("drops an unsafe default sandbox name", () => {
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "bad name" }))).toBeUndefined();
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "../../oops" }))).toBeUndefined();
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: ".hidden" }))).toBeUndefined();
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "-leading-dash" }))).toBeUndefined();
  });

  it("prefers NEMOCLAW_SANDBOX_NAME env var over registry default", () => {
    process.env.NEMOCLAW_SANDBOX_NAME = "env-sandbox";
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "registry-sandbox" }))).toBe(
      "env-sandbox",
    );
  });

  it("prefers NEMOCLAW_SANDBOX env var over registry default", () => {
    process.env.NEMOCLAW_SANDBOX = "env-sandbox-2";
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "registry-sandbox" }))).toBe(
      "env-sandbox-2",
    );
  });

  it("ignores unsafe env var values and falls back to registry", () => {
    process.env.NEMOCLAW_SANDBOX_NAME = "bad name";
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "registry-sandbox" }))).toBe(
      "registry-sandbox",
    );
  });

  it("starts services for the default sandbox when present", async () => {
    const startAll = vi.fn(async () => {});
    await runStartCommand({
      listSandboxes: () => ({ defaultSandbox: "alpha" }),
      startAll,
    });
    expect(startAll).toHaveBeenCalledWith({ sandboxName: "alpha" });
  });

  it("stops services without a sandbox override when the default sandbox is unsafe", () => {
    const stopAll = vi.fn();
    runStopCommand({
      listSandboxes: () => ({ defaultSandbox: "bad name" }),
      getSandbox: () => null,
      loadPersistedOllamaHost: () => null,
      loadPendingOllamaModelCleanup: () => [],
      stopAll,
    });
    expect(stopAll).toHaveBeenCalledWith({
      sandboxName: undefined,
      cleanupOllamaModels: false,
    });
  });

  it("opts the legacy full-stop command into managed gateway release", () => {
    const stopAll = vi.fn();
    runStopCommand({
      listSandboxes: () => ({ defaultSandbox: "alpha" }),
      getSandbox: () => ({ provider: "ollama-local" }),
      loadPersistedOllamaHost: () => null,
      loadPendingOllamaModelCleanup: () => [],
      stopAll,
      releaseGatewayPort: true,
    });
    expect(stopAll).toHaveBeenCalledWith({
      sandboxName: "alpha",
      cleanupOllamaModels: true,
      releaseGatewayPort: true,
    });
  });

  it("skips Ollama cleanup on a vLLM-only installation (#12049)", () => {
    const stopAll = vi.fn();
    runStopCommand({
      listSandboxes: () => ({ defaultSandbox: "my-assistant" }),
      getSandbox: () => ({ provider: "vllm-local" }),
      loadPersistedOllamaHost: () => null,
      loadPendingOllamaModelCleanup: () => [],
      stopAll,
    });
    expect(stopAll).toHaveBeenCalledWith({
      sandboxName: "my-assistant",
      cleanupOllamaModels: false,
    });
  });

  it("skips Ollama cleanup when Ollama was never configured and no sandbox is selected (#12049)", () => {
    const stopAll = vi.fn();
    runStopCommand({
      listSandboxes: () => ({ defaultSandbox: null }),
      getSandbox: () => null,
      loadPersistedOllamaHost: () => null,
      loadPendingOllamaModelCleanup: () => [],
      stopAll,
    });
    expect(stopAll).toHaveBeenCalledWith({
      sandboxName: undefined,
      cleanupOllamaModels: false,
    });
  });

  it("still unloads Ollama when the selected sandbox owns a local route", () => {
    const stopAll = vi.fn();
    runStopCommand({
      listSandboxes: () => ({ defaultSandbox: "my-assistant" }),
      getSandbox: () => ({ provider: "ollama-local" }),
      loadPersistedOllamaHost: () => "127.0.0.1",
      loadPendingOllamaModelCleanup: () => [],
      stopAll,
    });
    expect(stopAll).toHaveBeenCalledWith({
      sandboxName: "my-assistant",
      cleanupOllamaModels: true,
    });
  });

  it("skips Ollama cleanup for vllm-local even when a leftover host receipt exists (#12049)", () => {
    const stopAll = vi.fn();
    runStopCommand({
      listSandboxes: () => ({ defaultSandbox: "my-assistant" }),
      getSandbox: () => ({ provider: "vllm-local" }),
      loadPersistedOllamaHost: () => "127.0.0.1",
      loadPendingOllamaModelCleanup: () => [],
      stopAll,
    });
    expect(stopAll).toHaveBeenCalledWith({
      sandboxName: "my-assistant",
      cleanupOllamaModels: false,
    });
  });

  it("unloads Ollama when no sandbox is selected but a host receipt exists", () => {
    const stopAll = vi.fn();
    runStopCommand({
      listSandboxes: () => ({ defaultSandbox: null }),
      getSandbox: () => null,
      loadPersistedOllamaHost: () => "127.0.0.1",
      loadPendingOllamaModelCleanup: () => [],
      stopAll,
    });
    expect(stopAll).toHaveBeenCalledWith({
      sandboxName: undefined,
      cleanupOllamaModels: true,
    });
  });

  it("still unloads Ollama when a pending cleanup receipt remains", () => {
    const stopAll = vi.fn();
    runStopCommand({
      listSandboxes: () => ({ defaultSandbox: "my-assistant" }),
      getSandbox: () => ({ provider: "vllm-local" }),
      loadPersistedOllamaHost: () => null,
      loadPendingOllamaModelCleanup: () => ["llama3"],
      stopAll,
    });
    expect(stopAll).toHaveBeenCalledWith({
      sandboxName: "my-assistant",
      cleanupOllamaModels: true,
    });
  });

  it("does not ask to restore an Ollama endpoint on a vLLM-only stop (#12049)", () => {
    const pidDir = mkdtempSync(join(tmpdir(), "nemoclaw-vllm-tunnel-stop-"));
    const unloadOllamaModels = vi.fn(() => ({
      ok: false as const,
      outcome: "discovery-failed" as const,
      endpoint: "http://127.0.0.1:11434",
      selectedModels: [],
      discoveries: [],
      requests: [],
      message: "No reachable local Ollama endpoint was found for cleanup",
    }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    runStopCommand({
      listSandboxes: () => ({ defaultSandbox: "my-assistant" }),
      getSandbox: () => ({ provider: "vllm-local" }),
      loadPersistedOllamaHost: () => null,
      loadPendingOllamaModelCleanup: () => [],
      stopAll: (options) =>
        stopAll({
          ...options,
          pidDir,
          unloadOllamaModels,
        }),
    });

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    logSpy.mockRestore();

    expect(unloadOllamaModels).not.toHaveBeenCalled();
    expect(output).not.toContain("Ollama model cleanup failed");
    expect(output).not.toContain("restore access to http://127.0.0.1:11434");
    expect(output).not.toContain("Ollama model cleanup remains incomplete");
    expect(output).toContain("All services stopped");
  });
});
