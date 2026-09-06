// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
  probeWindowsHostOllamaRouteProtection,
  resetOllamaHostCache,
  resetOllamaRuntimeContextWindowAutoState,
  type RunCaptureFn,
  runOllamaWarmup,
  setResolvedOllamaHost,
  validateLocalProvider,
  validateOllamaModel,
} from "./local";
import { withOllamaModelOwnershipTransaction } from "./ollama/proxy";

function respondsOnlyThroughDockerDesktop(apiPath: string, response: string) {
  return vi.fn((command: readonly string[]) => {
    const rendered = command.join(" ");
    const expectedUrl = `http://host.docker.internal:11434${apiPath}`;
    const usesExpectedTransport =
      command[0] === "docker" &&
      command.includes("run") &&
      command.includes("--rm") &&
      command.includes(CONTAINER_REACHABILITY_IMAGE) &&
      command.some((argument) => argument === expectedUrl);
    return rendered.includes("Get-NetTCPConnection")
      ? "127.0.0.1"
      : command.includes("Host: rebinding.invalid")
        ? "403"
        : usesExpectedTransport
          ? response
          : rendered.includes("host.docker.internal:11434/api/tags")
            ? JSON.stringify({ models: [] })
            : "";
  });
}

function respondsWithOllamaInventorySequence(responses: string[]) {
  return vi.fn<RunCaptureFn>((command, options) => {
    const rendered = command.join(" ");
    switch (true) {
      case rendered.includes("Get-NetTCPConnection"):
        return "127.0.0.1";
      case command.includes("Host: rebinding.invalid"):
        return "403";
      case rendered.includes("host.docker.internal:11434/api/tags") && options?.timeout === 10_000:
        return JSON.stringify({ models: [] });
      default:
        return responses.shift() ?? "";
    }
  });
}

function isolatedDockerEnvironment() {
  return {
    env: {},
    isolatedCredentialConfig: false,
    cleanup: () => ({ ok: true as const }),
  };
}

describe("Windows-host Ollama transport", () => {
  const originalPath = process.env.PATH;
  let fakeDockerDir: string;

  beforeAll(() => {
    fakeDockerDir = mkdtempSync(join(tmpdir(), "nemoclaw-fake-docker-desktop-"));
    const fakeDockerPath = join(fakeDockerDir, "docker");
    writeFileSync(
      fakeDockerPath,
      [
        "#!/bin/sh",
        'if [ "$1" = "info" ]; then',
        "  printf '%s\\n' 'Operating System: Docker Desktop'",
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
    );
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
    vi.stubEnv("DOCKER_HOST", "");
    vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
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

  it("accepts route protection only when both probes use Docker Desktop", () => {
    const capture = vi.fn<RunCaptureFn>((command) => {
      const usesDockerDesktop =
        command[0] === "docker" &&
        command[1] === "run" &&
        command[2] === "--rm" &&
        command[3] === CONTAINER_REACHABILITY_IMAGE;
      return usesDockerDesktop
        ? command.includes("Host: rebinding.invalid")
          ? "403"
          : JSON.stringify({ models: [] })
        : "";
    });

    expect(
      probeWindowsHostOllamaRouteProtection(capture, {
        runtime: "docker-desktop",
        wslDetection: { isWsl: true },
        env: { DOCKER_CONTEXT: "default" },
        loopbackOnly: true,
        prepareDockerEnvironment: isolatedDockerEnvironment,
      }),
    ).toEqual({
      loopbackOnly: true,
      reachable: true,
      hostValidationEnabled: true,
      protected: true,
    });
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls.every(([command]) => command[0] === "docker")).toBe(true);
    expect(capture.mock.calls.map(([, options]) => options)).toEqual([
      expect.objectContaining({ ignoreError: true, timeout: 10_000 }),
      expect.objectContaining({ ignoreError: true, timeout: 10_000 }),
    ]);
  });

  it("rejects Host validation observed outside Docker Desktop", () => {
    const capture = vi.fn((command: readonly string[]) =>
      command[0] === "docker" && command.some((argument) => argument.endsWith("/api/tags"))
        ? JSON.stringify({ models: [] })
        : command[0] === "curl" && command.includes("Host: rebinding.invalid")
          ? "403"
          : "",
    );

    expect(
      probeWindowsHostOllamaRouteProtection(capture, {
        runtime: "docker-desktop",
        wslDetection: { isWsl: true },
        env: { DOCKER_CONTEXT: "default" },
        loopbackOnly: true,
        prepareDockerEnvironment: isolatedDockerEnvironment,
      }),
    ).toMatchObject({
      reachable: true,
      hostValidationEnabled: false,
      protected: false,
    });
  });

  it.each([
    ["an explicit Docker host", { DOCKER_HOST: "ssh://remote-builder.example" }],
    ["a non-default Docker context", { DOCKER_CONTEXT: "remote-builder" }],
  ])("rejects the raw route for %s", (_description, env) => {
    const capture = vi.fn(() => JSON.stringify({ models: [] }));

    expect(
      probeWindowsHostOllamaRouteProtection(capture, {
        runtime: "docker-desktop",
        wslDetection: { isWsl: true },
        env,
        loopbackOnly: true,
        prepareDockerEnvironment: isolatedDockerEnvironment,
      }),
    ).toEqual({
      loopbackOnly: false,
      reachable: false,
      hostValidationEnabled: false,
      protected: false,
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it("rejects the raw route for a persisted non-default Docker context", () => {
    const capture = vi.fn(() => JSON.stringify({ models: [] }));

    expect(
      probeWindowsHostOllamaRouteProtection(capture, {
        runtime: "docker-desktop",
        wslDetection: { isWsl: true },
        env: {},
        dockerContextIsDefault: () => false,
        loopbackOnly: true,
        prepareDockerEnvironment: isolatedDockerEnvironment,
      }),
    ).toEqual({
      loopbackOnly: false,
      reachable: false,
      hostValidationEnabled: false,
      protected: false,
    });
    expect(capture).not.toHaveBeenCalled();
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

  it("clears a stale persisted route before fresh-process connect discovery", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "nemoclaw-ollama-host-connect-"));
    try {
      persistResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL, stateRoot);
      resetOllamaHostCache();
      const capture = vi.fn((command: readonly string[]) =>
        command.some((argument) => argument === "http://127.0.0.1:11434/api/tags")
          ? JSON.stringify({ models: [] })
          : "",
      );

      expect(
        findReachableOllamaHost(capture, { isWsl: true }, stateRoot, {
          runtime: "docker-desktop",
          prepareDockerEnvironment: isolatedDockerEnvironment,
        }),
      ).toBe("127.0.0.1");
      expect(capture.mock.calls.map(([command]) => command)).toEqual(
        expect.arrayContaining([
          expect.arrayContaining(["docker", "run", "http://host.docker.internal:11434/api/tags"]),
          expect.arrayContaining(["curl", "http://127.0.0.1:11434/api/tags"]),
        ]),
      );
      expect(loadPersistedOllamaHost(stateRoot)).toBeNull();
      expect(getResolvedOllamaHost()).toBe("127.0.0.1");
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("rejects and clears a persisted Windows route without Host validation", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "nemoclaw-ollama-host-rebinding-"));
    try {
      persistResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL, stateRoot);
      resetOllamaHostCache();
      const capture = vi.fn((command: readonly string[]) => {
        const rendered = command.join(" ");
        return rendered.includes("Get-NetTCPConnection")
          ? "127.0.0.1"
          : command.includes("Host: rebinding.invalid")
            ? "200"
            : rendered.includes("host.docker.internal:11434/api/tags")
              ? JSON.stringify({ models: [] })
              : "";
      });

      expect(
        findReachableOllamaHost(capture, { isWsl: true }, stateRoot, {
          runtime: "docker-desktop",
          prepareDockerEnvironment: isolatedDockerEnvironment,
        }),
      ).toBeNull();
      expect(
        capture.mock.calls.some(([command]) => command.includes("Host: rebinding.invalid")),
      ).toBe(true);
      expect(loadPersistedOllamaHost(stateRoot)).toBeNull();
      expect(getResolvedOllamaHost()).toBe("127.0.0.1");
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("rejects and clears a Windows route with a non-loopback Ollama listener", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "nemoclaw-ollama-host-listener-"));
    try {
      persistResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL, stateRoot);
      resetOllamaHostCache();
      const capture = vi.fn((command: readonly string[]) => {
        const rendered = command.join(" ");
        return rendered.includes("Get-NetTCPConnection")
          ? "127.0.0.1\n192.168.1.10"
          : command.includes("Host: rebinding.invalid")
            ? "403"
            : rendered.includes("host.docker.internal:11434/api/tags")
              ? JSON.stringify({ models: [] })
              : "";
      });

      expect(
        findReachableOllamaHost(capture, { isWsl: true }, stateRoot, {
          runtime: "docker-desktop",
          prepareDockerEnvironment: isolatedDockerEnvironment,
        }),
      ).toBeNull();
      expect(loadPersistedOllamaHost(stateRoot)).toBeNull();
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("classifies a mirrored-loopback response as a protected Windows route", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "nemoclaw-ollama-host-mirrored-"));
    try {
      const capture = vi.fn((command: readonly string[]) => {
        const rendered = command.join(" ");
        return command[0] === "wslinfo"
          ? "mirrored"
          : rendered.includes("Get-NetTCPConnection")
            ? "127.0.0.1"
            : command.includes("Host: rebinding.invalid")
              ? "403"
              : rendered.includes("11434/api/tags")
                ? JSON.stringify({ models: [] })
                : "";
      });

      expect(
        findReachableOllamaHost(capture, { isWsl: true }, stateRoot, {
          runtime: "docker-desktop",
          readTextFile: () => "sl local_address rem_address st\n",
          prepareDockerEnvironment: isolatedDockerEnvironment,
        }),
      ).toBe(OLLAMA_HOST_DOCKER_INTERNAL);
      expect(
        capture.mock.calls.some(([command]) => command.includes("Host: rebinding.invalid")),
      ).toBe(true);
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when mirrored-loopback ownership is indeterminate", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "nemoclaw-ollama-host-ambiguous-"));
    try {
      const capture = vi.fn((command: readonly string[]) =>
        command[0] === "wslinfo"
          ? "mirrored"
          : command.some((argument) => argument === "http://127.0.0.1:11434/api/tags")
            ? JSON.stringify({ models: [] })
            : "",
      );

      expect(
        findReachableOllamaHost(capture, { isWsl: true }, stateRoot, {
          runtime: "docker-desktop",
          readTextFile: () => null,
          prepareDockerEnvironment: isolatedDockerEnvironment,
        }),
      ).toBeNull();
      expect(capture.mock.calls.some(([command]) => command[0] === "powershell.exe")).toBe(false);
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
        ollamaRunCaptureImpl: respondsOnlyThroughDockerDesktop(
          "/api/tags",
          JSON.stringify({ models: [] }),
        ),
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
    expect(capture).toHaveBeenCalledTimes(4);
  });

  it("returns no models when the Windows host reports an empty inventory", () => {
    setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
    const capture = respondsOnlyThroughDockerDesktop("/api/tags", JSON.stringify({ models: [] }));

    expect(getOllamaModelOptions(capture)).toEqual([]);
    expect(capture).toHaveBeenCalledTimes(4);
  });

  it("retries an invalid Windows-host inventory before returning installed models (#10259)", () => {
    setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
    const capture = respondsWithOllamaInventorySequence([
      "",
      "<html>proxy response</html>",
      JSON.stringify({ models: [{ name: "qwen3.5:9b" }] }),
    ]);
    const sleeps: number[] = [];

    expect(getOllamaModelOptions(capture, (milliseconds) => sleeps.push(milliseconds))).toEqual([
      "qwen3.5:9b",
    ]);
    expect(
      capture.mock.calls.filter(
        ([command, options]) =>
          command.some((argument) => argument.endsWith("/api/tags")) && options?.timeout !== 10_000,
      ),
    ).toHaveLength(3);
    expect(sleeps).toEqual([500, 1_000]);
  });

  it("rejects an invalid Windows-host inventory after bounded retries (#10259)", () => {
    setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
    const capture = respondsWithOllamaInventorySequence(["", "", ""]);
    const sleeps: number[] = [];

    expect(() =>
      getOllamaModelOptions(capture, (milliseconds) => sleeps.push(milliseconds)),
    ).toThrow(/Could not read Ollama models from host\.docker\.internal:11434 after 3 attempts/);
    expect(
      capture.mock.calls.filter(
        ([command, options]) =>
          command.some((argument) => argument.endsWith("/api/tags")) && options?.timeout !== 10_000,
      ),
    ).toHaveLength(3);
    expect(sleeps).toEqual([500, 1_000]);
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
      const rendered = command.join(" ");
      const usesDockerDesktop =
        command[0] === "docker" &&
        command[1] === "run" &&
        command[2] === "--rm" &&
        command.includes(CONTAINER_REACHABILITY_IMAGE);
      const endpoint = command.find((argument) => argument.startsWith("http://"));
      return rendered.includes("Get-NetTCPConnection")
        ? "127.0.0.1"
        : command.includes("Host: rebinding.invalid")
          ? "403"
          : usesDockerDesktop &&
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
    const capture = vi.fn((command: readonly string[]) => {
      const rendered = command.join(" ");
      return rendered.includes("Get-NetTCPConnection")
        ? "127.0.0.1"
        : command.includes("Host: rebinding.invalid")
          ? "403"
          : command.some((argument) => argument === "http://host.docker.internal:11434/api/tags")
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
    expect(capture).toHaveBeenCalledTimes(4);
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
    expect(capture).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["DOCKER_CONTEXT", "remote-builders"],
    ["DOCKER_HOST", "tcp://remote.example:2376"],
  ])("rejects a cached Windows route when %s changes before a model probe", (name, value) => {
    const stateRoot = mkdtempSync(join(tmpdir(), "nemoclaw-ollama-context-switch-"));
    try {
      const discoveryCapture = vi.fn((command: readonly string[]) => {
        const rendered = command.join(" ");
        return rendered.includes("Get-NetTCPConnection")
          ? "127.0.0.1"
          : command.includes("Host: rebinding.invalid")
            ? "403"
            : rendered.includes("host.docker.internal:11434/api/tags")
              ? JSON.stringify({ models: [] })
              : "";
      });

      expect(
        findReachableOllamaHost(discoveryCapture, { isWsl: true }, stateRoot, {
          runtime: "docker-desktop",
          prepareDockerEnvironment: isolatedDockerEnvironment,
        }),
      ).toBe(OLLAMA_HOST_DOCKER_INTERNAL);
      expect(getResolvedOllamaHost()).toBe(OLLAMA_HOST_DOCKER_INTERNAL);

      vi.stubEnv(name, value);
      const requestCapture = vi.fn(() => JSON.stringify({ capabilities: ["tools"] }));
      expect(probeOllamaModelCapabilities("qwen3.5:9b", requestCapture)).toMatchObject({
        source: "unknown",
        supportsTools: null,
      });
      expect(requestCapture).not.toHaveBeenCalled();
      expect(getResolvedOllamaHost()).toBe("127.0.0.1");
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("rejects a cached Windows route when Host validation changes before a model probe", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "nemoclaw-ollama-protection-change-"));
    let hostValidationEnabled = true;
    const capture = vi.fn<RunCaptureFn>((command) => {
      const rendered = command.join(" ");
      switch (true) {
        case rendered.includes("Get-NetTCPConnection"):
          return "127.0.0.1";
        case command.includes("Host: rebinding.invalid"):
          return hostValidationEnabled ? "403" : "200";
        case rendered.includes("host.docker.internal:11434/api/tags"):
          return JSON.stringify({ models: [] });
        case rendered.includes("host.docker.internal:11434/api/show"):
          return JSON.stringify({ capabilities: ["tools"] });
        default:
          return "";
      }
    });

    try {
      expect(
        findReachableOllamaHost(capture, { isWsl: true }, stateRoot, {
          runtime: "docker-desktop",
          prepareDockerEnvironment: isolatedDockerEnvironment,
        }),
      ).toBe(OLLAMA_HOST_DOCKER_INTERNAL);
      hostValidationEnabled = false;
      capture.mockClear();

      expect(probeOllamaModelCapabilities("qwen3.5:9b", capture)).toMatchObject({
        source: "unknown",
        supportsTools: null,
      });
      expect(
        capture.mock.calls.some(([command]) =>
          command.some((argument) => argument.endsWith("/api/show")),
        ),
      ).toBe(false);
      expect(getResolvedOllamaHost()).toBe("127.0.0.1");
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("isolates Docker credentials for Windows-host API requests", () => {
    const cleanup = vi.fn(() => ({ ok: true as const }));
    const capture = vi.fn((command: readonly string[], options?: { env?: NodeJS.ProcessEnv }) =>
      command.join(" ").includes("Get-NetTCPConnection")
        ? "127.0.0.1"
        : command.includes("Host: rebinding.invalid")
          ? "403"
          : options?.env?.DOCKER_CONFIG === "/tmp/credential-free-docker"
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
      {
        env: expect.objectContaining({
          DOCKER_CONFIG: "/tmp/credential-free-docker",
          DOCKER_CONTEXT: "default",
        }),
      },
    );
    expect(cleanup).toHaveBeenCalledTimes(3);
  });

  it("runs Windows-host warm-up with an isolated Docker client", () => {
    setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
    const cleanup = vi.fn(() => ({ ok: true as const }));
    const run = vi.fn();
    const protectionCapture = respondsOnlyThroughDockerDesktop(
      "/api/tags",
      JSON.stringify({ models: [] }),
    );

    runOllamaWarmup(
      "qwen3.5:9b",
      run,
      () => ({
        env: { DOCKER_CONFIG: "/tmp/credential-free-docker" },
        isolatedCredentialConfig: true,
        cleanup,
      }),
      protectionCapture,
    );

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
