// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OLLAMA_PORT, OLLAMA_PROXY_PORT } from "../../../core/ports";
import { prepareOllamaApiExecution } from "../../../inference/local";
import {
  maybeWarmOllamaAfterDaemonRestart,
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

function windowsRouteProtectionCapture(command: readonly string[]): string {
  const rendered = command.join(" ");
  return rendered.includes("Get-NetTCPConnection")
    ? "127.0.0.1"
    : command.includes("Host: rebinding.invalid")
      ? "403"
      : JSON.stringify({ models: [] });
}

describe("maybeWarmOllamaAfterDaemonRestart", () => {
  const originalPath = process.env.PATH;
  let fakeDockerDir: string;

  beforeAll(() => {
    fakeDockerDir = mkdtempSync(join(tmpdir(), "nemoclaw-restart-recovery-docker-"));
    const fakeDockerPath = join(fakeDockerDir, "docker");
    writeFileSync(fakeDockerPath, "#!/bin/sh\nprintf '%s\\n' 'Operating System: Docker Desktop'\n");
    chmodSync(fakeDockerPath, 0o755);
    process.env.PATH = `${fakeDockerDir}${delimiter}${originalPath ?? ""}`;
  });

  afterAll(() => {
    Reflect.deleteProperty(process.env, "PATH");
    Object.assign(process.env, originalPath === undefined ? {} : { PATH: originalPath });
    rmSync(fakeDockerDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.stubEnv("DOCKER_CONTEXT", "default");
    vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("skips routes that are not local Ollama", () => {
    expect(
      maybeWarmOllamaAfterDaemonRestart({ provider: "vllm-local", model: "meta/llama" }),
    ).toEqual({ kind: "skipped", reason: "not-ollama" });
  });

  it("skips a local Ollama route without a registered model", () => {
    expect(maybeWarmOllamaAfterDaemonRestart({ provider: "ollama-local" })).toEqual({
      kind: "skipped",
      reason: "missing-model",
    });
  });

  it("uses the persisted direct bridge route for both the default probe and warm-up", () => {
    const cleanup = vi.fn(() => ({ ok: true as const }));
    const prepareDockerEnvironment = () => ({
      env: { DOCKER_CONFIG: "/tmp/credential-free-docker" },
      isolatedCredentialConfig: true,
      cleanup,
    });
    const runCaptureImpl = vi.fn(
      (command: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
        const protection = windowsRouteProtectionCapture(command);
        return protection !== JSON.stringify({ models: [] })
          ? protection
          : options?.env?.DOCKER_CONFIG === "/tmp/credential-free-docker"
            ? protection
            : "";
      },
    );
    const runCaptureExImpl = vi.fn((_command: string[], options?: { env?: NodeJS.ProcessEnv }) =>
      options?.env?.DOCKER_CONFIG === "/tmp/credential-free-docker"
        ? successfulWarmResult()
        : { stdout: "", exitCode: 1, timedOut: false },
    );

    expect(
      maybeWarmOllamaAfterDaemonRestart(
        {
          provider: "ollama-local",
          model: "qwen3.6:35b",
          endpointUrl: `http://host.openshell.internal:${OLLAMA_PORT}/v1`,
        },
        {
          runCaptureImpl,
          runCaptureExImpl,
          revalidateOllamaHost: () => "host.docker.internal",
          prepareDockerEnvironment,
          prepareOllamaApiExecution: (command, host, options) =>
            prepareOllamaApiExecution(command, host, {
              ...options,
              prepareDockerEnvironment,
              runCaptureImpl,
            }),
        },
      ),
    ).toEqual({ kind: "warmed", ok: true, timedOut: false });

    const modelProbe = runCaptureImpl.mock.calls.find(([command]) =>
      getCommandUrl(command).endsWith("/api/ps"),
    );
    expect(getCommandUrl(modelProbe?.[0] ?? [])).toBe(
      `http://host.docker.internal:${OLLAMA_PORT}/api/ps`,
    );
    expect(modelProbe?.[0][0]).toBe("docker");
    expect(getCommandUrl(runCaptureExImpl.mock.calls[0][0])).toBe(
      `http://host.docker.internal:${OLLAMA_PORT}/api/generate`,
    );
    expect(runCaptureExImpl.mock.calls[0][0][0]).toBe("docker");
    expect(getCommandBody(runCaptureExImpl.mock.calls[0][0])).toMatchObject({
      model: "qwen3.6:35b",
      stream: false,
      think: false,
    });
    expect(modelProbe?.[1]?.env?.DOCKER_CONFIG).toBe("/tmp/credential-free-docker");
    expect(runCaptureExImpl.mock.calls[0][1]?.env?.DOCKER_CONFIG).toBe(
      "/tmp/credential-free-docker",
    );
    expect(cleanup).toHaveBeenCalledTimes(6);
  });

  it("maps an auth-proxy route back to host loopback", () => {
    const runCaptureImpl = vi.fn((_command: readonly string[]) => JSON.stringify({ models: [] }));
    const runCaptureExImpl = vi.fn((_command: string[]) => successfulWarmResult());

    maybeWarmOllamaAfterDaemonRestart(
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

  it("skips a stale raw Windows route before model probes or warm-up", () => {
    const probeRuntimeModelStatus = vi.fn(() => unloadedStatus);
    const runCaptureExImpl = vi.fn(() => successfulWarmResult());

    expect(
      maybeWarmOllamaAfterDaemonRestart(
        {
          provider: "ollama-local",
          model: "qwen3.6:35b",
          endpointUrl: `http://host.openshell.internal:${OLLAMA_PORT}/v1`,
        },
        {
          revalidateOllamaHost: () => null,
          probeRuntimeModelStatus,
          runCaptureExImpl,
        },
      ),
    ).toEqual({ kind: "skipped", reason: "unreachable" });
    expect(probeRuntimeModelStatus).not.toHaveBeenCalled();
    expect(runCaptureExImpl).not.toHaveBeenCalled();
  });

  it("falls back to an allowlisted host instead of probing an arbitrary registry URL", () => {
    const runCaptureImpl = vi.fn((_command: readonly string[]) => JSON.stringify({ models: [] }));
    const runCaptureExImpl = vi.fn((_command: string[]) => successfulWarmResult());

    maybeWarmOllamaAfterDaemonRestart(
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

  it("does not map an unrecognized proxy-port host to host loopback (#6039)", () => {
    const runCaptureImpl = vi.fn(windowsRouteProtectionCapture);
    const runCaptureExImpl = vi.fn((_command: string[]) => successfulWarmResult());

    maybeWarmOllamaAfterDaemonRestart(
      {
        provider: "ollama-local",
        model: "qwen3.6:35b",
        endpointUrl: `http://example.com:${OLLAMA_PROXY_PORT}/v1`,
      },
      {
        getOllamaHost: () => "host.docker.internal",
        revalidateOllamaHost: () => "host.docker.internal",
        runCaptureImpl,
        runCaptureExImpl,
        prepareOllamaApiExecution: (command, host, options) =>
          prepareOllamaApiExecution(command, host, { ...options, runCaptureImpl }),
      },
    );

    const modelProbe = runCaptureImpl.mock.calls.find(([command]) =>
      getCommandUrl(command).endsWith("/api/ps"),
    );
    expect(getCommandUrl(modelProbe?.[0] ?? [])).toBe(
      `http://host.docker.internal:${OLLAMA_PORT}/api/ps`,
    );
    expect(getCommandUrl(runCaptureExImpl.mock.calls[0][0])).toBe(
      `http://host.docker.internal:${OLLAMA_PORT}/api/generate`,
    );
  });

  it("skips the warm-up when the selected model is already loaded", () => {
    const probeRuntimeModelStatus = vi.fn(() => ({
      probed: true,
      loaded: true,
      cpuOnly: false,
    }));
    const runCaptureExImpl = vi.fn(() => successfulWarmResult());

    expect(
      maybeWarmOllamaAfterDaemonRestart(
        { provider: "ollama-local", model: "qwen3.6:35b" },
        { probeRuntimeModelStatus, runCaptureExImpl },
      ),
    ).toEqual({ kind: "skipped", reason: "already-loaded" });
    expect(runCaptureExImpl).not.toHaveBeenCalled();
  });

  it("skips the warm-up when the daemon probe is unreachable", () => {
    const runCaptureExImpl = vi.fn(() => successfulWarmResult());

    expect(
      maybeWarmOllamaAfterDaemonRestart(
        { provider: "ollama-local", model: "qwen3.6:35b" },
        { runCaptureImpl: () => "", runCaptureExImpl },
      ),
    ).toEqual({ kind: "skipped", reason: "unreachable" });
    expect(runCaptureExImpl).not.toHaveBeenCalled();
  });

  it("reports a bounded warm-up timeout", () => {
    expect(
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
    ).toEqual({
      kind: "warmed",
      ok: false,
      timedOut: true,
      reason: "timeout",
      endpoint: "http://127.0.0.1:11434",
      detail: "warm-up exceeded 300 seconds",
    });
  });

  it("does not treat an exit-zero Ollama error body as a successful warm-up", () => {
    expect(
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
    ).toMatchObject({
      kind: "warmed",
      ok: false,
      timedOut: false,
      reason: "ollama-error",
      endpoint: "http://127.0.0.1:11434",
      detail: expect.stringContaining("model not found"),
    });
  });

  it("reports an endpoint that no longer holds the model instead of a warm failure (#9455)", () => {
    const probeModelInventory = vi.fn(() => ["llama3.2:1b"]);
    const runCaptureImpl = vi.fn(windowsRouteProtectionCapture);

    expect(
      maybeWarmOllamaAfterDaemonRestart(
        {
          provider: "ollama-local",
          model: "gemma4:26b",
          endpointUrl: `http://host.openshell.internal:${OLLAMA_PORT}/v1`,
        },
        {
          revalidateOllamaHost: () => "host.docker.internal",
          probeRuntimeModelStatus: () => unloadedStatus,
          probeModelInventory,
          runCaptureImpl,
          prepareOllamaApiExecution: (command, host, options) =>
            prepareOllamaApiExecution(command, host, { ...options, runCaptureImpl }),
          runCaptureExImpl: () => ({
            stdout: JSON.stringify({ error: "model not found" }),
            exitCode: 0,
            timedOut: false,
          }),
        },
      ),
    ).toEqual({
      kind: "skipped",
      reason: "model-absent",
      endpoint: `http://host.docker.internal:${OLLAMA_PORT}`,
      inventoryLabel: "llama3.2:1b",
    });
    expect(probeModelInventory).toHaveBeenCalledWith("host.docker.internal", expect.any(Function));
  });

  it("keeps the warm failure when the daemon does hold the model (#9455)", () => {
    expect(
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
    ).toMatchObject({
      kind: "warmed",
      ok: false,
      timedOut: false,
      reason: "ollama-error",
      endpoint: "http://127.0.0.1:11434",
      detail: expect.stringContaining("runner stopped unexpectedly"),
    });
  });

  it("accepts a completed thinking-only response from a thinking model", () => {
    expect(
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
    ).toEqual({ kind: "warmed", ok: true, timedOut: false });
  });

  it.each([
    ["empty body", ""],
    ["malformed JSON", "not-json"],
    ["missing done marker", JSON.stringify({ response: "Hello!" })],
    ["empty response", JSON.stringify({ response: "", done: true })],
  ])("rejects an invalid warm response: %s", (_name, stdout) => {
    expect(
      maybeWarmOllamaAfterDaemonRestart(
        { provider: "ollama-local", model: "qwen3.6:35b" },
        {
          probeRuntimeModelStatus: () => unloadedStatus,
          runCaptureExImpl: () => ({ stdout, exitCode: 0, timedOut: false }),
        },
      ),
    ).toMatchObject({
      kind: "warmed",
      ok: false,
      timedOut: false,
      reason: "invalid-response",
      endpoint: "http://127.0.0.1:11434",
    });
  });

  it("reports a non-zero warm command exit", () => {
    expect(
      maybeWarmOllamaAfterDaemonRestart(
        { provider: "ollama-local", model: "qwen3.6:35b" },
        {
          probeRuntimeModelStatus: () => unloadedStatus,
          runCaptureExImpl: () => ({ stdout: "", exitCode: 7, timedOut: false }),
        },
      ),
    ).toEqual({
      kind: "warmed",
      ok: false,
      timedOut: false,
      reason: "command-failed",
      endpoint: "http://127.0.0.1:11434",
      detail: "warm-up exited 7",
    });
  });

  it("reports a warm process spawn failure without throwing", () => {
    const deps: OllamaRestartRecoveryDeps = {
      probeRuntimeModelStatus: () => unloadedStatus,
      runCaptureExImpl: () => {
        throw new Error("spawn failed");
      },
    };

    expect(
      maybeWarmOllamaAfterDaemonRestart({ provider: "ollama-local", model: "qwen3.6:35b" }, deps),
    ).toEqual({
      kind: "warmed",
      ok: false,
      timedOut: false,
      reason: "spawn-failed",
      endpoint: "http://127.0.0.1:11434",
      detail: "spawn failed",
    });
  });
});
