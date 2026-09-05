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
  createOllamaApiCapture,
  findReachableOllamaHost,
  getOllamaApiCommand,
  getOllamaModelOptions,
  getResolvedOllamaHost,
  OLLAMA_HOST_DOCKER_INTERNAL,
  loadPersistedOllamaHost,
  persistResolvedOllamaHost,
  probeLocalProviderHealth,
  probeOllamaModelCapabilities,
  resetOllamaHostCache,
  resetOllamaRuntimeContextWindowAutoState,
  runOllamaWarmup,
  setResolvedOllamaHost,
  validateLocalProvider,
  validateOllamaModel,
} from "./local";
import { withOllamaModelOwnershipTransaction } from "./ollama/proxy";

function respondsOnlyThroughDockerDesktop(apiPath: string, response: string) {
  return vi.fn((command: readonly string[]) => {
    const expectedUrl = `http://host.docker.internal:11434${apiPath}`;
    const usesExpectedTransport =
      command[0] === "docker" &&
      command.includes("run") &&
      command.includes("--rm") &&
      command.includes(CONTAINER_REACHABILITY_IMAGE) &&
      command.some((argument) => argument === expectedUrl);
    return usesExpectedTransport ? response : "";
  });
}

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

  it("restores the accepted route receipt in a fresh process", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "nemoclaw-ollama-host-receipt-"));
    try {
      setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
      persistResolvedOllamaHost(undefined, stateRoot);
      resetOllamaHostCache();

      expect(loadPersistedOllamaHost(stateRoot)).toBe(OLLAMA_HOST_DOCKER_INTERNAL);
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

      expect(clearPersistedOllamaHostIfUnused([{ provider: "nvidia-prod" }], stateRoot)).toBe(true);
      expect(loadPersistedOllamaHost(stateRoot)).toBeNull();
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("retains the persisted route while another Ollama sandbox owns it", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "nemoclaw-ollama-host-retain-"));
    try {
      persistResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL, stateRoot);

      expect(clearPersistedOllamaHostIfUnused([{ provider: "ollama-local" }], stateRoot)).toBe(
        false,
      );
      expect(loadPersistedOllamaHost(stateRoot)).toBe(OLLAMA_HOST_DOCKER_INTERNAL);
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("retains the route for a compatible endpoint at the selected local daemon", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "nemoclaw-ollama-host-compatible-retain-"));
    try {
      persistResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL, stateRoot);

      expect(
        clearPersistedOllamaHostIfUnused(
          [
            {
              provider: "compatible-endpoint",
              endpointUrl: "http://host.docker.internal:11434/v1",
            },
          ],
          stateRoot,
        ),
      ).toBe(false);
      expect(loadPersistedOllamaHost(stateRoot)).toBe(OLLAMA_HOST_DOCKER_INTERNAL);
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("retires the route when only a remote compatible endpoint remains", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "nemoclaw-ollama-host-compatible-remote-"));
    try {
      persistResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL, stateRoot);

      expect(
        clearPersistedOllamaHostIfUnused(
          [
            {
              provider: "compatible-endpoint",
              endpointUrl: "https://ollama.example.com:11434/v1",
            },
          ],
          stateRoot,
        ),
      ).toBe(true);
      expect(loadPersistedOllamaHost(stateRoot)).toBeNull();
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("serializes route publication with final ownership retirement", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "nemoclaw-ollama-host-transition-"));
    const routes: Array<{ provider: string }> = [];
    let staged!: () => void;
    let resume!: () => void;
    const stagedRoute = new Promise<void>((resolve) => {
      staged = resolve;
    });
    const resumeOnboarding = new Promise<void>((resolve) => {
      resume = resolve;
    });

    try {
      const onboarding = withOllamaModelOwnershipTransaction(async () => {
        persistResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL, stateRoot);
        staged();
        await resumeOnboarding;
        routes.push({ provider: "ollama-local" });
      });
      await stagedRoute;

      let retirementEntered = false;
      const retirement = withOllamaModelOwnershipTransaction(() => {
        retirementEntered = true;
        clearPersistedOllamaHostIfUnused(routes, stateRoot);
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(retirementEntered).toBe(false);

      resume();
      await onboarding;
      await retirement;

      expect(retirementEntered).toBe(true);
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
        command.some((argument) => argument === "http://127.0.0.1:11434/api/tags")
          ? JSON.stringify({ models: [] })
          : "",
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
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("probes a resolved Windows-host route through Docker Desktop", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "nemoclaw-ollama-host-health-"));
    try {
      persistResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL, stateRoot);
      resetOllamaHostCache();
      setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);

      const captureEx = vi.fn((command: readonly string[]) => ({
        stdout:
          command[0] === "docker" &&
          command[1] === "run" &&
          command[2] === "--rm" &&
          command[3] === CONTAINER_REACHABILITY_IMAGE &&
          command.some((argument) => argument === "http://host.docker.internal:11434/api/tags")
            ? JSON.stringify({ models: [] })
            : "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }));
      const result = probeLocalProviderHealth("ollama-local", {
        findReachableOllamaHostImpl: () => OLLAMA_HOST_DOCKER_INTERNAL,
        loadOllamaProxyTokenImpl: () => null,
        ollamaRunCaptureExImpl: captureEx,
      });

      expect(result).toMatchObject({
        ok: true,
        endpoint: "http://host.docker.internal:11434/api/tags",
      });
      expect(captureEx).toHaveBeenCalledOnce();
    } finally {
      resetOllamaHostCache();
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("reads the model inventory through Docker Desktop (#10553)", () => {
    setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
    const capture = respondsOnlyThroughDockerDesktop(
      "/api/tags",
      JSON.stringify({ models: [{ name: "qwen3.5:9b" }] }),
    );

    expect(getOllamaModelOptions(capture)).toEqual(["qwen3.5:9b"]);
    expect(capture).toHaveBeenCalledOnce();
  });

  it("validates a Windows-host model through Docker Desktop (#10553)", () => {
    setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
    const capture = respondsOnlyThroughDockerDesktop(
      "/api/show",
      JSON.stringify({ capabilities: ["tools"] }),
    );
    const captureEx = vi.fn((command: readonly string[]) => {
      const expected =
        command[0] === "docker" &&
        command[1] === "run" &&
        command[2] === "--rm" &&
        command[3] === CONTAINER_REACHABILITY_IMAGE &&
        command.some((argument) => argument === "http://host.docker.internal:11434/api/generate");
      return {
        stdout: expected ? JSON.stringify({ done: true, response: "ready" }) : "",
        stderr: "",
        exitCode: expected ? 0 : 1,
        timedOut: false,
      };
    });

    expect(validateOllamaModel("qwen3.5:9b", capture, () => false, captureEx)).toEqual({
      ok: true,
    });
    expect(captureEx).toHaveBeenCalledOnce();
  });

  it("validates health and container reachability through Docker Desktop (#10553)", () => {
    setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
    const capture = vi.fn((command: readonly string[]) => {
      const usesDockerDesktop =
        command[0] === "docker" &&
        command[1] === "run" &&
        command[2] === "--rm" &&
        command.includes(CONTAINER_REACHABILITY_IMAGE);
      const endpoint = command.find((argument) => argument.startsWith("http://"));
      return usesDockerDesktop &&
        (endpoint === "http://host.docker.internal:11434/api/tags" ||
          endpoint === "http://host.openshell.internal:11434/api/tags" ||
          endpoint === "http://host.openshell.internal:11435/api/tags")
        ? JSON.stringify({ models: [] })
        : "";
    });

    const result = validateLocalProvider(
      "ollama-local",
      capture,
      () => {},
      () => ({
        env: {},
        isolatedCredentialConfig: false,
        cleanup: () => ({ ok: true }),
      }),
    );
    expect(result).toEqual({ ok: true });
    const endpoints = capture.mock.calls.map(([command]) =>
      command.find((argument: string) => argument.startsWith("http://")),
    );
    expect(endpoints).toContain("http://host.docker.internal:11434/api/tags");
    expect(endpoints).toContain("http://host.openshell.internal:11434/api/tags");
  });

  it("rejects Windows-host health when the container route is unreachable", () => {
    setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
    const capture = vi.fn((command: readonly string[]) =>
      command.some((argument) => argument === "http://host.docker.internal:11434/api/tags")
        ? JSON.stringify({ models: [] })
        : "",
    );

    const result = validateLocalProvider(
      "ollama-local",
      capture,
      () => {},
      () => ({
        env: {},
        isolatedCredentialConfig: false,
        cleanup: () => ({ ok: true }),
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining("container reachability check failed"),
    });
    const endpoints = capture.mock.calls.map(([command]) =>
      command.find((argument: string) => argument.startsWith("http://")),
    );
    expect(endpoints).toContain("http://host.docker.internal:11434/api/tags");
    expect(
      endpoints.some((endpoint) => endpoint?.startsWith("http://host.openshell.internal:")),
    ).toBe(true);
  });

  it("checks the Hermes context window through Docker Desktop (#10553)", () => {
    setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
    const capture = respondsOnlyThroughDockerDesktop(
      "/api/ps",
      JSON.stringify({
        models: [{ name: "qwen3.5:9b", context_length: 65_536, processor: "100% GPU" }],
      }),
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
  });

  it("checks model capability metadata through Docker Desktop (#10553)", () => {
    setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
    const capture = respondsOnlyThroughDockerDesktop(
      "/api/show",
      JSON.stringify({ capabilities: ["tools"] }),
    );

    expect(probeOllamaModelCapabilities("qwen3.5:9b", capture)).toMatchObject({
      source: "api",
      supportsTools: true,
    });
    expect(capture).toHaveBeenCalledOnce();
  });

  it("isolates Docker credentials for Windows-host API requests", () => {
    const cleanup = vi.fn(() => ({ ok: true as const }));
    const capture = vi.fn((_command: readonly string[], options?: { env?: NodeJS.ProcessEnv }) =>
      options?.env?.DOCKER_CONFIG === "/tmp/credential-free-docker"
        ? JSON.stringify({ models: [] })
        : "",
    );
    const isolatedCapture = createOllamaApiCapture(capture, OLLAMA_HOST_DOCKER_INTERNAL, () => ({
      env: { DOCKER_CONFIG: "/tmp/credential-free-docker" },
      isolatedCredentialConfig: true,
      cleanup,
    }));

    expect(isolatedCapture(["curl", "-sf", "http://host.docker.internal:11434/api/tags"])).toBe(
      JSON.stringify({ models: [] }),
    );
    expect(capture).toHaveBeenCalledWith(
      expect.arrayContaining(["docker", "run", "--rm", CONTAINER_REACHABILITY_IMAGE]),
      { env: { DOCKER_CONFIG: "/tmp/credential-free-docker" } },
    );
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("runs Windows-host warm-up with an isolated Docker client", () => {
    setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
    const cleanup = vi.fn(() => ({ ok: true as const }));
    const run = vi.fn();

    runOllamaWarmup("qwen3.5:9b", run, () => ({
      env: { DOCKER_CONFIG: "/tmp/credential-free-docker" },
      isolatedCredentialConfig: true,
      cleanup,
    }));

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
        env: { DOCKER_CONFIG: "/tmp/credential-free-docker" },
      },
    );
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("keeps the Hermes context-window check fail-closed on an invalid Docker response (#10553)", () => {
    setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
    const capture = respondsOnlyThroughDockerDesktop(
      "/api/ps",
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
    expect(capture).toHaveBeenCalledWith(
      expect.arrayContaining([
        "docker",
        "run",
        "--rm",
        CONTAINER_REACHABILITY_IMAGE,
        "http://host.docker.internal:11434/api/ps",
      ]),
      expect.any(Object),
    );
  });
});
