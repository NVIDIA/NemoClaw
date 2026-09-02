// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import type { StdioOptions } from "node:child_process";

import { describe, expect, it, vi } from "vitest";
import { OLLAMA_PORT, OLLAMA_PROXY_PORT } from "../../../core/ports";
import type { SandboxExecSignalSource } from "../exec";
import type { AgentDispatchChild } from "./passthrough-dispatch";
import {
  maybeWarmOllamaAfterDaemonRestart,
  runOllamaRecoveryCapture,
  type OllamaRestartRecoveryDeps,
} from "./ollama-restart-recovery";

const unloadedStatus = {
  probed: true,
  loaded: false,
  cpuOnly: false,
};

function successfulWarmResult() {
  return {
    stdout: JSON.stringify({ response: "Hello!", done: true }),
    exitCode: 0,
    timedOut: false,
  };
}

function getCommandUrl(command: readonly string[]): string {
  return command.find((arg) => arg.startsWith("http://")) ?? "";
}

function getCommandBody(command: readonly string[]): Record<string, unknown> {
  const dataIndex = command.indexOf("-d");
  return JSON.parse(command[dataIndex + 1] ?? "null") as Record<string, unknown>;
}

describe("maybeWarmOllamaAfterDaemonRestart", () => {
  it("skips routes that are not local Ollama", async () => {
    await expect(
      maybeWarmOllamaAfterDaemonRestart({ provider: "vllm-local", model: "meta/llama" }),
    ).resolves.toEqual({ kind: "skipped", reason: "not-ollama" });
  });

  it("skips a local Ollama route without a registered model", async () => {
    await expect(maybeWarmOllamaAfterDaemonRestart({ provider: "ollama-local" })).resolves.toEqual({
      kind: "skipped",
      reason: "missing-model",
    });
  });

  it("uses the persisted direct bridge route for both the default probe and warm-up", async () => {
    const cleanup = vi.fn(() => ({ ok: true as const }));
    const prepareDockerEnvironment = () => ({
      env: { DOCKER_CONFIG: "/tmp/credential-free-docker" },
      isolatedCredentialConfig: true,
      cleanup,
    });
    const runCaptureImpl = vi.fn(
      (_command: readonly string[], options?: { env?: NodeJS.ProcessEnv }) =>
        options?.env?.DOCKER_CONFIG === "/tmp/credential-free-docker"
          ? JSON.stringify({ models: [] })
          : "",
    );
    const runCaptureExImpl = vi.fn((_command: string[], options?: { env?: NodeJS.ProcessEnv }) =>
      options?.env?.DOCKER_CONFIG === "/tmp/credential-free-docker"
        ? successfulWarmResult()
        : { stdout: "", exitCode: 1, timedOut: false },
    );

    await expect(
      maybeWarmOllamaAfterDaemonRestart(
        {
          provider: "ollama-local",
          model: "qwen3.6:35b",
          endpointUrl: `http://host.openshell.internal:${OLLAMA_PORT}/v1`,
        },
        {
          runCaptureImpl,
          runCaptureExImpl,
          prepareDockerEnvironment,
        },
      ),
    ).resolves.toEqual({ kind: "warmed", ok: true });

    expect(getCommandUrl(runCaptureImpl.mock.calls[0][0])).toBe(
      `http://host.docker.internal:${OLLAMA_PORT}/api/ps`,
    );
    expect(runCaptureImpl.mock.calls[0][0][0]).toBe("docker");
    expect(getCommandUrl(runCaptureExImpl.mock.calls[0][0])).toBe(
      `http://host.docker.internal:${OLLAMA_PORT}/api/generate`,
    );
    expect(runCaptureExImpl.mock.calls[0][0][0]).toBe("docker");
    expect(getCommandBody(runCaptureExImpl.mock.calls[0][0])).toMatchObject({
      model: "qwen3.6:35b",
      stream: false,
      think: false,
    });
    expect(runCaptureImpl.mock.calls[0][1]?.env?.DOCKER_CONFIG).toBe("/tmp/credential-free-docker");
    expect(runCaptureExImpl.mock.calls[0][1]?.env?.DOCKER_CONFIG).toBe(
      "/tmp/credential-free-docker",
    );
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it("runs the production status probe and warm-up through the async capture boundary", async () => {
    const runRecoveryCaptureImpl = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ models: [] }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      })
      .mockResolvedValueOnce({ ...successfulWarmResult(), stderr: "" });

    await expect(
      maybeWarmOllamaAfterDaemonRestart(
        { provider: "ollama-local", model: "qwen3.6:35b" },
        { runRecoveryCaptureImpl },
      ),
    ).resolves.toEqual({ kind: "warmed", ok: true });
    expect(runRecoveryCaptureImpl).toHaveBeenCalledTimes(2);
    expect(getCommandUrl(runRecoveryCaptureImpl.mock.calls[0]?.[0] ?? [])).toBe(
      `http://127.0.0.1:${OLLAMA_PORT}/api/ps`,
    );
    expect(getCommandUrl(runRecoveryCaptureImpl.mock.calls[1]?.[0] ?? [])).toBe(
      `http://127.0.0.1:${OLLAMA_PORT}/api/generate`,
    );
  });

  it("stops recovery after an async status probe is cancelled", async () => {
    const runRecoveryCaptureImpl = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: false,
      signal: "SIGTERM",
    });

    await expect(
      maybeWarmOllamaAfterDaemonRestart(
        { provider: "ollama-local", model: "qwen3.6:35b" },
        { runRecoveryCaptureImpl },
      ),
    ).resolves.toEqual({ kind: "cancelled", signal: "SIGTERM" });
    expect(runRecoveryCaptureImpl).toHaveBeenCalledOnce();
  });

  it("prepares and cleans one Docker environment for each recovery request", async () => {
    const cleanups: Array<ReturnType<typeof vi.fn>> = [];
    const prepareDockerEnvironment = vi.fn(() => {
      const cleanup = vi.fn(() => ({ ok: true as const }));
      cleanups.push(cleanup);
      return {
        env: { DOCKER_CONFIG: `/tmp/credential-free-docker-${cleanups.length}` },
        isolatedCredentialConfig: true,
        cleanup,
      };
    });
    const commands: string[][] = [];
    const runCaptureImpl = vi.fn((command: readonly string[]) => {
      commands.push([...command]);
      return getCommandUrl(command).endsWith("/api/ps")
        ? JSON.stringify({ models: [] })
        : JSON.stringify({ models: [{ name: "llama3.2:1b" }] });
    });
    const runCaptureExImpl = vi.fn((command: string[]) => {
      commands.push([...command]);
      return {
        stdout: JSON.stringify({ error: "model not found" }),
        exitCode: 0,
        timedOut: false,
      };
    });

    await expect(
      maybeWarmOllamaAfterDaemonRestart(
        {
          provider: "ollama-local",
          model: "qwen3.6:35b",
          endpointUrl: `http://host.openshell.internal:${OLLAMA_PORT}/v1`,
        },
        { runCaptureImpl, runCaptureExImpl, prepareDockerEnvironment },
      ),
    ).resolves.toMatchObject({ kind: "skipped", reason: "model-absent" });

    expect(commands.map(getCommandUrl)).toEqual([
      `http://host.docker.internal:${OLLAMA_PORT}/api/ps`,
      `http://host.docker.internal:${OLLAMA_PORT}/api/generate`,
      `http://host.docker.internal:${OLLAMA_PORT}/api/tags`,
    ]);
    expect(commands.every((command) => command[0] === "docker")).toBe(true);
    expect(prepareDockerEnvironment).toHaveBeenCalledTimes(3);
    expect(cleanups).toHaveLength(3);
    expect(cleanups[0]).toHaveBeenCalledOnce();
    expect(cleanups[1]).toHaveBeenCalledOnce();
    expect(cleanups[2]).toHaveBeenCalledOnce();
  });

  it("forwards SIGTERM to an active recovery child and releases its Docker environment", async () => {
    const childEvents = new EventEmitter();
    const signalEvents = new EventEmitter();
    const stderr = new EventEmitter();
    const stdout = new EventEmitter();
    const cleanup = vi.fn(() => ({ ok: true as const }));
    const child: AgentDispatchChild = {
      exitCode: null,
      signalCode: null,
      kill: vi.fn((signal) => {
        child.signalCode = signal;
        queueMicrotask(() => childEvents.emit("close", null, signal));
        return true;
      }),
      once: ((event: string, listener: (...args: unknown[]) => void) =>
        childEvents.once(event, listener)) as AgentDispatchChild["once"],
      stderr,
      stdout,
    };
    const signalSource: SandboxExecSignalSource = {
      add: (signal, listener) => signalEvents.on(signal, listener),
      remove: (signal, listener) => signalEvents.off(signal, listener),
    };
    const spawnRecoveryChild = vi.fn(
      (_binary: string, _args: readonly string[], _stdio: StdioOptions, _env: NodeJS.ProcessEnv) =>
        child,
    );

    const pending = runOllamaRecoveryCapture(
      ["curl", `http://host.docker.internal:${OLLAMA_PORT}/api/ps`],
      {
        host: "host.docker.internal",
        timeoutMilliseconds: 300_000,
        prepareDockerEnvironment: () => ({
          env: { DOCKER_CONFIG: "/tmp/credential-free-docker" },
          isolatedCredentialConfig: true,
          cleanup,
        }),
        signalSource,
        spawnRecoveryChild,
      },
    );
    signalEvents.emit("SIGTERM");

    await expect(pending).resolves.toMatchObject({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: false,
    });
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawnRecoveryChild.mock.calls[0]?.[0]).toBe("docker");
    expect(spawnRecoveryChild.mock.calls[0]?.[3]?.DOCKER_CONFIG).toBe(
      "/tmp/credential-free-docker",
    );
    expect(cleanup).toHaveBeenCalledOnce();
    expect(signalEvents.listenerCount("SIGTERM")).toBe(0);
    expect(signalEvents.listenerCount("SIGINT")).toBe(0);
  });

  it("maps an auth-proxy route back to host loopback", async () => {
    const runCaptureImpl = vi.fn((_command: readonly string[]) => JSON.stringify({ models: [] }));
    const runCaptureExImpl = vi.fn((_command: string[]) => successfulWarmResult());

    await maybeWarmOllamaAfterDaemonRestart(
      {
        provider: "ollama-local",
        model: "qwen3.6:35b",
        endpointUrl: `http://host.openshell.internal:${OLLAMA_PROXY_PORT}/v1`,
      },
      { runCaptureImpl, runCaptureExImpl },
    );

    expect(getCommandUrl(runCaptureImpl.mock.calls[0][0])).toBe(
      `http://127.0.0.1:${OLLAMA_PORT}/api/ps`,
    );
    expect(runCaptureImpl.mock.calls[0][0][0]).toBe("curl");
    expect(getCommandUrl(runCaptureExImpl.mock.calls[0][0])).toBe(
      `http://127.0.0.1:${OLLAMA_PORT}/api/generate`,
    );
    expect(runCaptureExImpl.mock.calls[0][0][0]).toBe("curl");
  });

  it("falls back to an allowlisted host instead of probing an arbitrary registry URL", async () => {
    const runCaptureImpl = vi.fn((_command: readonly string[]) => JSON.stringify({ models: [] }));
    const runCaptureExImpl = vi.fn((_command: string[]) => successfulWarmResult());

    await maybeWarmOllamaAfterDaemonRestart(
      {
        provider: "ollama-local",
        model: "qwen3.6:35b",
        endpointUrl: `http://example.com:${OLLAMA_PORT}/v1`,
      },
      {
        getOllamaHost: () => "also.example.com",
        runCaptureImpl,
        runCaptureExImpl,
      },
    );

    expect(getCommandUrl(runCaptureImpl.mock.calls[0][0])).toContain("http://127.0.0.1:");
    expect(getCommandUrl(runCaptureExImpl.mock.calls[0][0])).toContain("http://127.0.0.1:");
  });

  it("does not map an unrecognized proxy-port host to host loopback (#6039)", async () => {
    const runCaptureImpl = vi.fn((_command: readonly string[]) => JSON.stringify({ models: [] }));
    const runCaptureExImpl = vi.fn((_command: string[]) => successfulWarmResult());

    await maybeWarmOllamaAfterDaemonRestart(
      {
        provider: "ollama-local",
        model: "qwen3.6:35b",
        endpointUrl: `http://example.com:${OLLAMA_PROXY_PORT}/v1`,
      },
      {
        getOllamaHost: () => "host.docker.internal",
        runCaptureImpl,
        runCaptureExImpl,
      },
    );

    expect(getCommandUrl(runCaptureImpl.mock.calls[0][0])).toBe(
      `http://host.docker.internal:${OLLAMA_PORT}/api/ps`,
    );
    expect(getCommandUrl(runCaptureExImpl.mock.calls[0][0])).toBe(
      `http://host.docker.internal:${OLLAMA_PORT}/api/generate`,
    );
  });

  it("skips the warm-up when the selected model is already loaded", async () => {
    const probeRuntimeModelStatus = vi.fn(() => ({
      probed: true,
      loaded: true,
      cpuOnly: false,
    }));
    const runCaptureExImpl = vi.fn(() => successfulWarmResult());

    await expect(
      maybeWarmOllamaAfterDaemonRestart(
        { provider: "ollama-local", model: "qwen3.6:35b" },
        { probeRuntimeModelStatus, runCaptureExImpl },
      ),
    ).resolves.toEqual({ kind: "skipped", reason: "already-loaded" });
    expect(runCaptureExImpl).not.toHaveBeenCalled();
  });

  it("skips the warm-up when the daemon probe is unreachable", async () => {
    const runCaptureExImpl = vi.fn(() => successfulWarmResult());

    await expect(
      maybeWarmOllamaAfterDaemonRestart(
        { provider: "ollama-local", model: "qwen3.6:35b" },
        { runCaptureImpl: () => "", runCaptureExImpl },
      ),
    ).resolves.toEqual({
      kind: "skipped",
      reason: "unreachable",
      endpoint: `http://127.0.0.1:${OLLAMA_PORT}`,
    });
    expect(runCaptureExImpl).not.toHaveBeenCalled();
  });

  it("skips the warm-up when the daemon status response is malformed", async () => {
    const runCaptureExImpl = vi.fn(() => successfulWarmResult());

    await expect(
      maybeWarmOllamaAfterDaemonRestart(
        { provider: "ollama-local", model: "qwen3.6:35b" },
        { runCaptureImpl: () => "not-json", runCaptureExImpl },
      ),
    ).resolves.toEqual({
      kind: "skipped",
      reason: "unreachable",
      endpoint: `http://127.0.0.1:${OLLAMA_PORT}`,
    });
    expect(runCaptureExImpl).not.toHaveBeenCalled();
  });

  it("reports a bounded warm-up timeout", async () => {
    await expect(
      maybeWarmOllamaAfterDaemonRestart(
        { provider: "ollama-local", model: "qwen3.6:35b" },
        {
          probeRuntimeModelStatus: () => unloadedStatus,
          runCaptureExImpl: () => ({
            stdout: "",
            exitCode: 28,
            timedOut: true,
          }),
        },
      ),
    ).resolves.toEqual({
      kind: "warmed",
      ok: false,
      reason: "timeout",
      endpoint: "http://127.0.0.1:11434",
      detail: "warm-up exceeded 300 seconds",
    });
  });

  it("limits warm-up to the command timeout budget remaining after the probe", async () => {
    let nowMs = 1_000;
    const runCaptureExImpl = vi.fn(
      (_command: string[], _options?: { env?: NodeJS.ProcessEnv; timeout?: number }) =>
        successfulWarmResult(),
    );
    const probeRuntimeModelStatus = vi.fn(() => {
      nowMs = 6_000;
      return unloadedStatus;
    });

    await expect(
      maybeWarmOllamaAfterDaemonRestart(
        { provider: "ollama-local", model: "qwen3.6:35b" },
        {
          probeRuntimeModelStatus,
          runCaptureExImpl,
          timeoutSeconds: 30,
          now: () => nowMs,
        },
      ),
    ).resolves.toEqual({ kind: "warmed", ok: true });

    const warmCommand = runCaptureExImpl.mock.calls[0][0];
    expect(warmCommand[warmCommand.indexOf("--max-time") + 1]).toBe("25");
    expect(runCaptureExImpl.mock.calls[0][1]?.timeout).toBe(25_000);
    expect(probeRuntimeModelStatus).toHaveBeenCalledWith(
      "qwen3.6:35b",
      expect.any(Function),
      expect.any(Function),
      5_000,
    );
  });

  it("skips warm-up when the probe consumes the command timeout budget", async () => {
    let nowMs = 1_000;
    const runCaptureExImpl = vi.fn(() => successfulWarmResult());
    const probeRuntimeModelStatus = vi.fn(() => {
      nowMs = 31_000;
      return unloadedStatus;
    });

    await expect(
      maybeWarmOllamaAfterDaemonRestart(
        { provider: "ollama-local", model: "qwen3.6:35b" },
        {
          probeRuntimeModelStatus,
          runCaptureExImpl,
          timeoutSeconds: 30,
          now: () => nowMs,
        },
      ),
    ).resolves.toEqual({
      kind: "skipped",
      reason: "deadline-exhausted",
      endpoint: `http://127.0.0.1:${OLLAMA_PORT}`,
    });
    expect(runCaptureExImpl).not.toHaveBeenCalled();
  });

  it("bounds the daemon probe and skips warm-up when a short timeout is consumed", async () => {
    let nowMs = 1_000;
    const probeRuntimeModelStatus = vi.fn(() => {
      nowMs = 3_000;
      return unloadedStatus;
    });

    await expect(
      maybeWarmOllamaAfterDaemonRestart(
        { provider: "ollama-local", model: "qwen3.6:35b" },
        { probeRuntimeModelStatus, timeoutSeconds: 2, now: () => nowMs },
      ),
    ).resolves.toEqual({
      kind: "skipped",
      reason: "deadline-exhausted",
      endpoint: `http://127.0.0.1:${OLLAMA_PORT}`,
    });
    expect(probeRuntimeModelStatus).toHaveBeenCalledWith(
      "qwen3.6:35b",
      expect.any(Function),
      expect.any(Function),
      2_000,
    );
  });

  it("does not treat an exit-zero Ollama error body as a successful warm-up", async () => {
    await expect(
      maybeWarmOllamaAfterDaemonRestart(
        { provider: "ollama-local", model: "missing:latest" },
        {
          probeRuntimeModelStatus: () => unloadedStatus,
          probeModelInventory: () => null,
          runCaptureExImpl: () => ({
            stdout: JSON.stringify({ error: "model not found" }),
            exitCode: 0,
            timedOut: false,
          }),
        },
      ),
    ).resolves.toMatchObject({
      kind: "warmed",
      ok: false,
      reason: "ollama-error",
      endpoint: "http://127.0.0.1:11434",
      detail: expect.stringContaining("model not found"),
    });
  });

  it("keeps the warm-up error when the inventory probe throws", async () => {
    await expect(
      maybeWarmOllamaAfterDaemonRestart(
        { provider: "ollama-local", model: "qwen3.6:35b" },
        {
          probeRuntimeModelStatus: () => unloadedStatus,
          probeModelInventory: () => {
            throw new Error("inventory unavailable");
          },
          runCaptureExImpl: () => ({
            stdout: JSON.stringify({ error: "runner stopped unexpectedly" }),
            exitCode: 0,
            timedOut: false,
          }),
        },
      ),
    ).resolves.toMatchObject({
      kind: "warmed",
      ok: false,
      reason: "ollama-error",
      detail: expect.stringContaining("runner stopped unexpectedly"),
    });
  });

  it("reports an endpoint that no longer holds the model instead of a warm failure (#9455)", async () => {
    const probeModelInventory = vi.fn(() => ["llama3.2:1b"]);

    await expect(
      maybeWarmOllamaAfterDaemonRestart(
        {
          provider: "ollama-local",
          model: "gemma4:26b",
          endpointUrl: `http://host.openshell.internal:${OLLAMA_PORT}/v1`,
        },
        {
          probeRuntimeModelStatus: () => unloadedStatus,
          probeModelInventory,
          runCaptureExImpl: () => ({
            stdout: JSON.stringify({ error: "model not found" }),
            exitCode: 0,
            timedOut: false,
          }),
        },
      ),
    ).resolves.toEqual({
      kind: "skipped",
      reason: "model-absent",
      endpoint: `http://host.docker.internal:${OLLAMA_PORT}`,
      inventoryLabel: "llama3.2:1b",
    });
    expect(probeModelInventory).toHaveBeenCalledWith(
      "host.docker.internal",
      undefined,
      5_000,
      undefined,
    );
  });

  it("keeps the warm failure when the daemon does hold the model (#9455)", async () => {
    await expect(
      maybeWarmOllamaAfterDaemonRestart(
        { provider: "ollama-local", model: "qwen3.6:35b" },
        {
          probeRuntimeModelStatus: () => unloadedStatus,
          probeModelInventory: () => ["qwen3.6:35b"],
          runCaptureExImpl: () => ({
            stdout: JSON.stringify({ error: "runner stopped unexpectedly" }),
            exitCode: 0,
            timedOut: false,
          }),
        },
      ),
    ).resolves.toMatchObject({
      kind: "warmed",
      ok: false,
      reason: "ollama-error",
      endpoint: "http://127.0.0.1:11434",
      detail: expect.stringContaining("runner stopped unexpectedly"),
    });
  });

  it("accepts a completed thinking-only response from a thinking model", async () => {
    await expect(
      maybeWarmOllamaAfterDaemonRestart(
        { provider: "ollama-local", model: "qwen3.6:35b" },
        {
          probeRuntimeModelStatus: () => unloadedStatus,
          runCaptureExImpl: () => ({
            stdout: JSON.stringify({ response: "", thinking: "The model is ready.", done: true }),
            exitCode: 0,
            timedOut: false,
          }),
        },
      ),
    ).resolves.toEqual({ kind: "warmed", ok: true });
  });

  it.each([
    ["empty body", ""],
    ["malformed JSON", "not-json"],
    ["missing done marker", JSON.stringify({ response: "Hello!" })],
    ["empty response", JSON.stringify({ response: "", done: true })],
  ])("rejects an invalid warm response: %s", async (_name, stdout) => {
    await expect(
      maybeWarmOllamaAfterDaemonRestart(
        { provider: "ollama-local", model: "qwen3.6:35b" },
        {
          probeRuntimeModelStatus: () => unloadedStatus,
          runCaptureExImpl: () => ({ stdout, exitCode: 0, timedOut: false }),
        },
      ),
    ).resolves.toMatchObject({
      kind: "warmed",
      ok: false,
      reason: "invalid-response",
      endpoint: "http://127.0.0.1:11434",
    });
  });

  it("reports a non-zero warm command exit", async () => {
    await expect(
      maybeWarmOllamaAfterDaemonRestart(
        { provider: "ollama-local", model: "qwen3.6:35b" },
        {
          probeRuntimeModelStatus: () => unloadedStatus,
          runCaptureExImpl: () => ({ stdout: "", exitCode: 7, timedOut: false }),
        },
      ),
    ).resolves.toEqual({
      kind: "warmed",
      ok: false,
      reason: "command-failed",
      endpoint: "http://127.0.0.1:11434",
      detail: "warm-up exited 7",
    });
  });

  it("reports a warm process spawn failure without throwing", async () => {
    const deps: OllamaRestartRecoveryDeps = {
      probeRuntimeModelStatus: () => unloadedStatus,
      runCaptureExImpl: () => {
        throw new Error("spawn failed");
      },
    };

    await expect(
      maybeWarmOllamaAfterDaemonRestart({ provider: "ollama-local", model: "qwen3.6:35b" }, deps),
    ).resolves.toEqual({
      kind: "warmed",
      ok: false,
      reason: "spawn-failed",
      endpoint: "http://127.0.0.1:11434",
      detail: "spawn failed",
    });
  });
});
