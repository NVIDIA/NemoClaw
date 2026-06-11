// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  detectInferenceProviderHostState,
  type DetectInferenceProviderHostStateDeps,
  type InferenceProviderHostGpu,
} from "../../../dist/lib/onboard/provider-host-state";

const SUPPORTED_WINDOWS_OLLAMA = {
  supported: true,
  detectedRuntime: "Docker Desktop",
  installLabel: "Install Ollama on Windows host (recommended)",
  startLabel: ({ reachable }: { reachable: boolean; loopbackOnly: boolean }) =>
    reachable ? "Use Ollama on Windows host - running (suggested)" : "Start Ollama on Windows host",
} as const;

function buildDeps(
  overrides: Partial<DetectInferenceProviderHostStateDeps> = {},
): DetectInferenceProviderHostStateDeps {
  return {
    runCapture: vi.fn(() => ""),
    dockerCapture: vi.fn(() => ""),
    hostCommandExists: vi.fn(() => false),
    findReachableOllamaHost: vi.fn(() => null),
    isWsl: vi.fn(() => false),
    getContainerRuntime: vi.fn<DetectInferenceProviderHostStateDeps["getContainerRuntime"]>(
      () => "docker-desktop",
    ),
    detectWindowsHostOllama: vi.fn(() => ({
      installed: false,
      installedPath: "",
      loopbackOnly: false,
    })),
    getWindowsHostOllamaDockerRequirement: vi.fn(() => SUPPORTED_WINDOWS_OLLAMA),
    detectVllmProfile: vi.fn(() => null),
    ...overrides,
  };
}

function detectWithDeps(
  deps: DetectInferenceProviderHostStateDeps,
  gpu: InferenceProviderHostGpu | null = null,
) {
  return detectInferenceProviderHostState({
    gpu,
    experimental: true,
    platform: "linux",
    env: {},
    log: () => {},
    installedOllamaVersion: "0.24.0",
    runningOllamaVersion: "0.24.0",
    deps,
  });
}

describe("detectInferenceProviderHostState", () => {
  it("collects local Ollama and vLLM state into one provider host snapshot", () => {
    const deps = buildDeps({
      hostCommandExists: vi.fn((command) => command === "ollama"),
      findReachableOllamaHost: vi.fn(() => "127.0.0.1"),
      runCapture: vi.fn((command) =>
        command.join(" ").includes(`http://127.0.0.1:8000/v1/models`) ? "{}" : "",
      ),
      dockerCapture: vi.fn(() => "sha256:cached-image\n"),
      detectVllmProfile: vi.fn<DetectInferenceProviderHostStateDeps["detectVllmProfile"]>(() => ({
        name: "Linux + NVIDIA GPU",
        platform: "linux" as const,
        image: "nvcr.io/nvidia/vllm:test",
        defaultModel: {} as never,
        containerName: "nemoclaw-vllm",
        dockerRunFlags: [],
        pullTimeoutSec: 1,
        loadTimeoutSec: 1,
      })),
    });

    const state = detectWithDeps(deps, { nimCapable: true, type: "nvidia", platform: "linux" });

    expect(state.hasOllama).toBe(true);
    expect(state.ollamaRunning).toBe(true);
    expect(state.ollamaHost).toBe("127.0.0.1");
    expect(state.isWindowsHostOllama).toBe(false);
    expect(state.vllmRunning).toBe(true);
    expect(state.hasVllmImage).toBe(true);
    expect(state.vllmEntries.map((entry) => entry.key)).toEqual(["vllm"]);
    expect(state.gpuNimCapable).toBe(true);
    expect(state.ollamaInstallMenu.entry).toBeNull();
    expect(deps.getWindowsHostOllamaDockerRequirement).toHaveBeenCalledWith(null);
  });

  it("detects a reachable Windows-host Ollama beside WSL-local Ollama and warns outside mirrored networking", () => {
    const logs: string[] = [];
    const deps = buildDeps({
      isWsl: vi.fn(() => true),
      findReachableOllamaHost: vi.fn(() => "127.0.0.1"),
      detectWindowsHostOllama: vi.fn(() => ({
        installed: true,
        installedPath: "C:\\Users\\me\\AppData\\Local\\Programs\\Ollama\\ollama.exe",
        loopbackOnly: false,
      })),
      runCapture: vi.fn((command) => {
        const joined = command.join(" ");
        if (joined.includes("host.docker.internal:11434/api/tags")) return "{}";
        if (joined.includes("wslinfo --networking-mode")) return "nat\n";
        return "";
      }),
    });

    const state = detectInferenceProviderHostState({
      gpu: null,
      experimental: false,
      platform: "linux",
      env: {},
      log: (message = "") => logs.push(message),
      installedOllamaVersion: "0.24.0",
      runningOllamaVersion: "0.24.0",
      deps,
    });

    expect(state.isWsl).toBe(true);
    expect(state.hasWindowsOllama).toBe(true);
    expect(state.windowsOllamaReachable).toBe(true);
    expect(state.winOllamaInstalledPath).toMatch(/ollama\.exe$/);
    expect(logs.join("\n")).toContain("Ollama is running on both WSL and the Windows host");
    expect(deps.getWindowsHostOllamaDockerRequirement).toHaveBeenCalledWith("docker-desktop");
  });

  it("passes injected platform and env through WSL detection", () => {
    const env = { WSL_DISTRO_NAME: "Ubuntu" } as NodeJS.ProcessEnv;
    const isWsl = vi.fn<DetectInferenceProviderHostStateDeps["isWsl"]>(() => true);
    const deps = buildDeps({ isWsl });

    const state = detectInferenceProviderHostState({
      gpu: null,
      experimental: false,
      platform: "linux",
      env,
      log: () => {},
      installedOllamaVersion: "0.24.0",
      runningOllamaVersion: "0.24.0",
      deps,
    });

    expect(state.isWsl).toBe(true);
    expect(isWsl).toHaveBeenCalledWith({ platform: "linux", env });
  });

  it("suppresses the duplicate-daemon warning when WSL mirrored networking makes the probes equivalent", () => {
    const logs: string[] = [];
    const deps = buildDeps({
      isWsl: vi.fn(() => true),
      findReachableOllamaHost: vi.fn(() => "127.0.0.1"),
      detectWindowsHostOllama: vi.fn(() => ({
        installed: true,
        installedPath: "C:\\Ollama\\ollama.exe",
        loopbackOnly: false,
      })),
      runCapture: vi.fn((command) => {
        const joined = command.join(" ");
        if (joined.includes("host.docker.internal:11434/api/tags")) return "{}";
        if (joined.includes("wslinfo --networking-mode")) return "mirrored\n";
        return "";
      }),
    });

    const state = detectInferenceProviderHostState({
      gpu: null,
      experimental: false,
      platform: "linux",
      env: {},
      log: (message = "") => logs.push(message),
      installedOllamaVersion: "0.24.0",
      runningOllamaVersion: "0.24.0",
      deps,
    });

    expect(state.windowsOllamaReachable).toBe(true);
    expect(logs).toEqual([]);
  });

  it("does not probe the Windows-host switch path when running Ollama already resolves to the Windows host", () => {
    const runCapture = vi.fn<DetectInferenceProviderHostStateDeps["runCapture"]>(() => "");
    const deps = buildDeps({
      isWsl: vi.fn(() => true),
      findReachableOllamaHost: vi.fn(() => "host.docker.internal"),
      detectWindowsHostOllama: vi.fn(() => ({
        installed: true,
        installedPath: "C:\\Ollama\\ollama.exe",
        loopbackOnly: true,
      })),
      runCapture,
    });

    const state = detectWithDeps(deps);

    expect(state.isWindowsHostOllama).toBe(true);
    expect(state.windowsOllamaReachable).toBe(false);
    expect(
      runCapture.mock.calls.some(([command]) =>
        command.join(" ").includes("host.docker.internal:11434/api/tags"),
      ),
    ).toBe(false);
  });
});
