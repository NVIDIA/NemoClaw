// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { detectLocalTcpListener } from "../inference/local";
import { MIN_OLLAMA_VERSION } from "../inference/ollama-version";
import { getWindowsHostOllamaDockerRequirement } from "./local-inference-topology";
import {
  type DetectInferenceProviderHostStateDeps,
  detectInferenceProviderHostState,
  type InferenceProviderHostGpu,
} from "./provider-host-state";

const WINDOWS_OLLAMA_TAGS_URL = "http://host.docker.internal:11434/api/tags";
const VALID_OLLAMA_TAGS_BODY = '{"models": [{"name": "llama3.2:latest"}]}';
const REBINDING_PROBE_HOST_HEADER = "Host: rebinding.invalid";

function windowsRouteProtection(
  overrides: Partial<
    ReturnType<DetectInferenceProviderHostStateDeps["probeWindowsHostOllamaRouteProtection"]>
  > = {},
) {
  return {
    loopbackOnly: false,
    reachable: false,
    hostValidationEnabled: false,
    protected: false,
    ...overrides,
  };
}

function secureWindowsOllamaDockerCapture(command: readonly string[]): string {
  return command.includes(REBINDING_PROBE_HOST_HEADER)
    ? "403"
    : command.at(-1) === WINDOWS_OLLAMA_TAGS_URL
      ? VALID_OLLAMA_TAGS_BODY
      : "";
}

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
    getLocalProviderAvailabilityEndpoint: vi.fn(() => "http://127.0.0.1:8000/v1/models"),
    detectLocalTcpListener: vi.fn(() => null),
    probeWindowsHostOllamaRouteProtection: vi.fn(() => windowsRouteProtection()),
    resetOllamaHostCache: vi.fn(),
    ...overrides,
  };
}

function detectWithDeps(
  deps: DetectInferenceProviderHostStateDeps,
  gpu: InferenceProviderHostGpu | null = null,
  env: NodeJS.ProcessEnv = {},
) {
  return detectInferenceProviderHostState({
    gpu,
    experimental: true,
    platform: "linux",
    env,
    log: () => {},
    installedOllamaVersion: MIN_OLLAMA_VERSION,
    runningOllamaVersion: MIN_OLLAMA_VERSION,
    deps,
  });
}

describe("detectInferenceProviderHostState", () => {
  it("suppresses local and Windows-host Ollama probes when provider discovery disables them (#6315, #9604)", () => {
    const runCapture = vi.fn<DetectInferenceProviderHostStateDeps["runCapture"]>(() => "{}");
    const findReachableOllamaHost = vi.fn(() => "127.0.0.1");
    const detectWindowsHostOllama = vi.fn(() => ({
      installed: true,
      installedPath: "C:\\Ollama\\ollama.exe",
      loopbackOnly: false,
    }));
    const deps = buildDeps({
      runCapture,
      findReachableOllamaHost,
      isWsl: vi.fn(() => true),
      detectWindowsHostOllama,
    });

    const state = detectInferenceProviderHostState({
      gpu: null,
      experimental: false,
      probeOllama: false,
      probeVllm: false,
      platform: "linux",
      env: {},
      log: () => {},
      deps,
    });

    expect(findReachableOllamaHost).not.toHaveBeenCalled();
    expect(detectWindowsHostOllama).not.toHaveBeenCalled();
    expect(state.ollamaRunning).toBe(false);
    expect(state.vllmRunning).toBe(false);
    expect(state.windowsOllamaReachable).toBe(false);
    expect(
      runCapture.mock.calls.some(([command]) =>
        command.join(" ").match(/\/v1\/models|\/api\/tags/),
      ),
    ).toBe(false);
  });

  it("collects local Ollama and vLLM state into one provider host snapshot", () => {
    const dockerCapture = vi.fn(() => "sha256:cached-image\n");
    const deps = buildDeps({
      hostCommandExists: vi.fn((command) => command === "ollama" || command === "docker"),
      findReachableOllamaHost: vi.fn(() => "127.0.0.1"),
      runCapture: vi.fn((command) =>
        command.join(" ").includes(`http://127.0.0.1:8000/v1/models`) ? "{}" : "",
      ),
      dockerCapture,
      detectVllmProfile: vi.fn<DetectInferenceProviderHostStateDeps["detectVllmProfile"]>(() => ({
        name: "Linux + NVIDIA GPU",
        platform: "linux" as const,
        image: "nvcr.io/nvidia/vllm:test",
        imageDownloadSizeBytes: 1,
        defaultModel: {} as never,
        containerName: "nemoclaw-vllm",
        dockerRunFlags: [],
        pullTimeoutSec: 1,
        loadTimeoutSec: 1,
      })),
    });

    const state = detectWithDeps(
      deps,
      { nimCapable: true, type: "nvidia", platform: "linux" },
      {
        DOCKER_CONTEXT: "remote-builder",
        DOCKER_HOST: "ssh://fallback.example.test",
      },
    );

    expect(state.hasOllama).toBe(true);
    expect(state.ollamaRunning).toBe(true);
    expect(state.ollamaHost).toBe("127.0.0.1");
    expect(state.isWindowsHostOllama).toBe(false);
    expect(state.vllmRunning).toBe(true);
    expect(state.hasVllmImage).toBe(true);
    expect(state.vllmEntries.map((entry) => entry.key)).toEqual(["vllm"]);
    expect(deps.hostCommandExists).toHaveBeenCalledWith("docker");
    expect(state.gpuNimCapable).toBe(true);
    expect(state.ollamaInstallMenu.entry).toBeNull();
    expect(deps.getWindowsHostOllamaDockerRequirement).toHaveBeenCalledWith(null);
    expect(dockerCapture).toHaveBeenCalledWith(
      ["image", "inspect", "--format", "{{.Id}}", "nvcr.io/nvidia/vllm:test"],
      expect.objectContaining({
        env: expect.objectContaining({
          DOCKER_CONTEXT: "remote-builder",
          DOCKER_HOST: "ssh://fallback.example.test",
        }),
        ignoreError: true,
        timeout: 10_000,
      }),
    );
  });

  it("keeps Docker-less hosts out of managed vLLM at the host-state boundary (#10891)", () => {
    const logs: string[] = [];
    const deps = buildDeps({
      detectVllmProfile: vi.fn<DetectInferenceProviderHostStateDeps["detectVllmProfile"]>(
        () => ({
          name: "DGX Spark",
          platform: "spark" as const,
          image: "nvcr.io/nvidia/vllm:test",
          imageDownloadSizeBytes: 1,
          defaultModel: {} as never,
          containerName: "nemoclaw-vllm",
          dockerRunFlags: [],
          pullTimeoutSec: 1,
          loadTimeoutSec: 1,
        }),
      ),
    });
    const gpu = { nimCapable: false, type: "nvidia" as const, platform: "spark" as const };

    const interactiveState = detectWithDeps(deps, gpu);
    const explicitState = detectInferenceProviderHostState({
      gpu,
      experimental: true,
      platform: "linux",
      env: { NEMOCLAW_PROVIDER: "install-vllm" },
      log: (message = "") => logs.push(message),
      installedOllamaVersion: MIN_OLLAMA_VERSION,
      runningOllamaVersion: MIN_OLLAMA_VERSION,
      deps,
    });

    expect(interactiveState.hasVllmImage).toBe(false);
    expect(interactiveState.vllmEntries).toEqual([]);
    expect(explicitState.hasVllmImage).toBe(false);
    expect(explicitState.vllmEntries).toEqual([]);
    expect(logs).toContain("  Managed vLLM install/start requires Docker on PATH.");
    expect(deps.hostCommandExists).toHaveBeenCalledWith("docker");
    expect(deps.dockerCapture).not.toHaveBeenCalled();
  });

  it("does not treat curl connection status 000 as a running vLLM", () => {
    const state = detectWithDeps(
      buildDeps({
        runCapture: vi.fn((command) =>
          command.join(" ").includes("127.0.0.1:8000/v1/models") ? "000" : "",
        ),
      }),
    );

    expect(state.vllmRunning).toBe(false);
  });

  it("fails the vLLM running probe closed when managed endpoint resolution fails", () => {
    const runCapture = vi.fn(() => "200");
    const state = detectWithDeps(
      buildDeps({
        runCapture,
        getLocalProviderAvailabilityEndpoint: () => {
          throw new Error("managed state unavailable");
        },
      }),
    );

    expect(state.vllmRunning).toBe(false);
    expect(runCapture).not.toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining("8000")]),
      expect.anything(),
    );
  });

  it("detects Windows-host Ollama from Docker Desktop when WSL cannot reach it (#8127)", () => {
    const logs: string[] = [];
    const probeWindowsHostOllamaRouteProtection = vi.fn(() =>
      windowsRouteProtection({ reachable: true, hostValidationEnabled: true }),
    );
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
        if (joined.includes("wslinfo --networking-mode")) return "nat\n";
        return "";
      }),
      probeWindowsHostOllamaRouteProtection,
    });

    const state = detectInferenceProviderHostState({
      gpu: null,
      experimental: false,
      platform: "linux",
      env: {},
      log: (message = "") => logs.push(message),
      installedOllamaVersion: MIN_OLLAMA_VERSION,
      runningOllamaVersion: MIN_OLLAMA_VERSION,
      deps,
    });

    expect(state.isWsl).toBe(true);
    expect(state.hasWindowsOllama).toBe(true);
    expect(state.windowsOllamaReachable).toBe(true);
    expect(state.winOllamaInstalledPath).toMatch(/ollama\.exe$/);
    expect(logs.join("\n")).toContain("Ollama is running on both WSL and the Windows host");
    expect(deps.getWindowsHostOllamaDockerRequirement).toHaveBeenCalledWith("docker-desktop");
    expect(probeWindowsHostOllamaRouteProtection).toHaveBeenCalledOnce();
  });

  it("keeps WSL-local install available when Docker Desktop cannot reach Windows-host Ollama (#8199)", () => {
    const deps = buildDeps({
      isWsl: vi.fn(() => true),
      getContainerRuntime: vi.fn<DetectInferenceProviderHostStateDeps["getContainerRuntime"]>(
        () => "docker-desktop",
      ),
      detectWindowsHostOllama: vi.fn(() => ({
        installed: true,
        installedPath: "C:\\Users\\me\\AppData\\Local\\Programs\\Ollama\\ollama.exe",
        loopbackOnly: false,
      })),
    });

    const state = detectWithDeps(deps);

    expect(state.hasWindowsOllama).toBe(true);
    expect(state.windowsHostOllamaDockerRequirement.supported).toBe(true);
    expect(state.windowsOllamaReachable).toBe(false);
    expect(state.ollamaInstallMenu.entry?.key).toBe("install-ollama");
    expect(state.ollamaInstallMenu.entry?.label).toBe("Install Ollama (WSL Linux)");
  });

  it.each([
    ["an HTML response", "<html>captive portal</html>"],
    ["a null model entry", '{"models":[null]}'],
    ["a primitive model entry", '{"models":[1]}'],
    ["a nested-array model entry", '{"models":[[]]}'],
  ])("does not treat %s as a live Windows daemon (#9348)", (_label, body) => {
    const deps = buildDeps({
      isWsl: vi.fn(() => true),
      getContainerRuntime: vi.fn<DetectInferenceProviderHostStateDeps["getContainerRuntime"]>(
        () => "docker-desktop",
      ),
      detectWindowsHostOllama: vi.fn(() => ({
        installed: true,
        installedPath: "C:\\Users\\me\\AppData\\Local\\Programs\\Ollama\\ollama.exe",
        loopbackOnly: false,
      })),
      dockerCapture: vi.fn<DetectInferenceProviderHostStateDeps["dockerCapture"]>(() => body),
    });

    const state = detectWithDeps(deps);

    expect(state.hasWindowsOllama).toBe(true);
    expect(state.windowsOllamaReachable).toBe(false);
    expect(state.ollamaInstallMenu.entry?.key).toBe("install-ollama");
  });

  it("does not run the Windows-host probe without Docker Desktop WSL integration (#8127)", () => {
    const dockerCapture = vi.fn<DetectInferenceProviderHostStateDeps["dockerCapture"]>(() => "{}");
    const deps = buildDeps({
      isWsl: vi.fn(() => true),
      dockerCapture,
      getWindowsHostOllamaDockerRequirement: vi.fn(() =>
        getWindowsHostOllamaDockerRequirement("docker"),
      ),
    });

    const state = detectWithDeps(deps);

    expect(state.windowsOllamaReachable).toBe(false);
    expect(dockerCapture).not.toHaveBeenCalled();
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
      installedOllamaVersion: MIN_OLLAMA_VERSION,
      runningOllamaVersion: MIN_OLLAMA_VERSION,
      deps,
    });

    expect(state.isWsl).toBe(true);
    expect(isWsl).toHaveBeenCalledWith({ platform: "linux", env });
  });

  it("classifies a mirrored loopback daemon as Windows-host Ollama (#9300)", () => {
    const logs: string[] = [];
    const deps = buildDeps({
      isWsl: vi.fn(() => true),
      findReachableOllamaHost: vi.fn(() => "127.0.0.1"),
      detectWindowsHostOllama: vi.fn(() => ({
        installed: true,
        installedPath: "C:\\Ollama\\ollama.exe",
        loopbackOnly: true,
      })),
      runCapture: vi.fn((command) => {
        const joined = command.join(" ");
        if (joined.includes("wslinfo --networking-mode")) return "mirrored\n";
        return "";
      }),
      dockerCapture: vi.fn(secureWindowsOllamaDockerCapture),
      detectLocalTcpListener: vi.fn(() => false),
      probeWindowsHostOllamaRouteProtection: vi.fn(() =>
        windowsRouteProtection({
          loopbackOnly: true,
          reachable: true,
          hostValidationEnabled: true,
          protected: true,
        }),
      ),
    });

    const state = detectInferenceProviderHostState({
      gpu: null,
      experimental: false,
      platform: "linux",
      env: {},
      log: (message = "") => logs.push(message),
      installedOllamaVersion: MIN_OLLAMA_VERSION,
      runningOllamaVersion: MIN_OLLAMA_VERSION,
      deps,
    });

    expect(state.windowsOllamaReachable).toBe(true);
    expect(state.isWindowsHostOllama).toBe(true);
    expect(state.ollamaInstallMenu.entry).toBeNull();
    expect(logs).toEqual([]);
  });

  it("keeps a mirrored WSL-local daemon on the Linux upgrade path (#9300)", () => {
    const logs: string[] = [];
    const runCapture = vi.fn((command: readonly string[]) =>
      command.join(" ").includes("wslinfo --networking-mode") ? "mirrored\n" : "",
    );
    const deps = buildDeps({
      isWsl: vi.fn(() => true),
      hostCommandExists: vi.fn((command) => command === "ollama"),
      findReachableOllamaHost: vi.fn(() => "127.0.0.1"),
      detectWindowsHostOllama: vi.fn(() => ({
        installed: true,
        installedPath: "C:\\Ollama\\ollama.exe",
        loopbackOnly: false,
      })),
      runCapture,
      dockerCapture: vi.fn((command) =>
        command.at(-1) === WINDOWS_OLLAMA_TAGS_URL ? VALID_OLLAMA_TAGS_BODY : "",
      ),
      detectLocalTcpListener: vi.fn(() => true),
      probeWindowsHostOllamaRouteProtection: vi.fn(() =>
        windowsRouteProtection({ reachable: true, hostValidationEnabled: true }),
      ),
    });

    const state = detectInferenceProviderHostState({
      gpu: null,
      experimental: false,
      platform: "linux",
      env: {},
      log: (message = "") => logs.push(message),
      installedOllamaVersion: "0.32.5",
      runningOllamaVersion: "0.32.5",
      deps,
    });

    expect(state.windowsOllamaReachable).toBe(true);
    expect(state.isWindowsHostOllama).toBe(false);
    expect(state.ollamaInstallMenu.entry?.key).toBe("install-ollama");
    expect(state.ollamaInstallMenu.hasUpgradableOllama).toBe(true);
    expect(logs.join("\n")).toContain("Ollama is running on both WSL and the Windows host");
    expect(runCapture).toHaveBeenCalledWith(["wslinfo", "--networking-mode"], {
      ignoreError: true,
      timeout: 5_000,
    });
  });

  it("fails closed when mirrored listener identity is unavailable (#9300)", () => {
    const resetOllamaHostCache = vi.fn();
    const deps = buildDeps({
      isWsl: vi.fn(() => true),
      findReachableOllamaHost: vi.fn(() => "127.0.0.1"),
      detectWindowsHostOllama: vi.fn(() => ({
        installed: true,
        installedPath: "C:\\Ollama\\ollama.exe",
        loopbackOnly: false,
      })),
      runCapture: vi.fn((command) =>
        command.join(" ").includes("wslinfo --networking-mode") ? "mirrored\n" : "",
      ),
      dockerCapture: vi.fn((command) =>
        command.at(-1) === WINDOWS_OLLAMA_TAGS_URL ? VALID_OLLAMA_TAGS_BODY : "",
      ),
      detectLocalTcpListener: vi.fn(() => null),
      probeWindowsHostOllamaRouteProtection: vi.fn(() =>
        windowsRouteProtection({ reachable: true }),
      ),
      resetOllamaHostCache,
    });

    const state = detectWithDeps(deps);

    expect(state.isWindowsHostOllama).toBe(false);
    expect(state.ollamaHost).toBeNull();
    expect(state.ollamaRunning).toBe(false);
    expect(resetOllamaHostCache).toHaveBeenCalledOnce();
  });

  it("keeps an unrecognized WSL networking mode on the Linux upgrade path (#9300)", () => {
    const detectLocalTcpListener = vi.fn(() => false);
    const deps = buildDeps({
      isWsl: vi.fn(() => true),
      hostCommandExists: vi.fn((command) => command === "ollama"),
      findReachableOllamaHost: vi.fn(() => "127.0.0.1"),
      detectWindowsHostOllama: vi.fn(() => ({
        installed: true,
        installedPath: "C:\\Ollama\\ollama.exe",
        loopbackOnly: false,
      })),
      runCapture: vi.fn((command) =>
        command.join(" ").includes("wslinfo --networking-mode") ? "future-mode\n" : "",
      ),
      dockerCapture: vi.fn((command) =>
        command.at(-1) === WINDOWS_OLLAMA_TAGS_URL ? VALID_OLLAMA_TAGS_BODY : "",
      ),
      detectLocalTcpListener,
    });

    const state = detectInferenceProviderHostState({
      gpu: null,
      experimental: false,
      platform: "linux",
      env: {},
      log: () => undefined,
      installedOllamaVersion: "0.32.5",
      runningOllamaVersion: "0.32.5",
      deps,
    });

    expect(state.isWindowsHostOllama).toBe(false);
    expect(state.ollamaInstallMenu.entry?.key).toBe("install-ollama");
    expect(state.ollamaInstallMenu.hasUpgradableOllama).toBe(true);
    expect(detectLocalTcpListener).not.toHaveBeenCalled();
  });

  it("rejects Windows-host Ollama when the shared protection probe cannot reach it (#10100)", () => {
    const runCapture = vi.fn<DetectInferenceProviderHostStateDeps["runCapture"]>(() => "");
    const probeWindowsHostOllamaRouteProtection = vi.fn(() =>
      windowsRouteProtection({ loopbackOnly: true }),
    );
    const deps = buildDeps({
      isWsl: vi.fn(() => true),
      findReachableOllamaHost: vi.fn(() => "host.docker.internal"),
      detectWindowsHostOllama: vi.fn(() => ({
        installed: true,
        installedPath: "C:\\Ollama\\ollama.exe",
        loopbackOnly: true,
      })),
      runCapture,
      probeWindowsHostOllamaRouteProtection,
    });

    const state = detectWithDeps(deps);

    expect(state.isWindowsHostOllama).toBe(false);
    expect(state.windowsOllamaReachable).toBe(false);
    expect(state.ollamaHost).toBeNull();
    expect(deps.resetOllamaHostCache).toHaveBeenCalledOnce();
    expect(probeWindowsHostOllamaRouteProtection).toHaveBeenCalledWith(runCapture, {
      runtime: "docker-desktop",
      wslDetection: { isWsl: true },
      env: {},
      loopbackOnly: true,
    });
  });

  it("reuses Windows-host Ollama only after Docker reachability succeeds (#10100)", () => {
    const probeWindowsHostOllamaRouteProtection = vi.fn(() =>
      windowsRouteProtection({
        loopbackOnly: true,
        reachable: true,
        hostValidationEnabled: true,
        protected: true,
      }),
    );
    const deps = buildDeps({
      isWsl: vi.fn(() => true),
      findReachableOllamaHost: vi.fn(() => "host.docker.internal"),
      detectWindowsHostOllama: vi.fn(() => ({
        installed: true,
        installedPath: "C:\\Ollama\\ollama.exe",
        loopbackOnly: true,
      })),
      probeWindowsHostOllamaRouteProtection,
    });

    const state = detectWithDeps(deps);

    expect(state.isWindowsHostOllama).toBe(true);
    expect(state.windowsOllamaReachable).toBe(true);
    expect(probeWindowsHostOllamaRouteProtection).toHaveBeenCalledOnce();
  });

  it("reuses a protected Windows route when its executable path is unavailable", () => {
    const probeWindowsHostOllamaRouteProtection = vi.fn(
      (_capture, options) =>
        options.loopbackOnly === false
          ? windowsRouteProtection({ reachable: true, hostValidationEnabled: true })
          : windowsRouteProtection({
              loopbackOnly: true,
              reachable: true,
              hostValidationEnabled: true,
              protected: true,
            }),
    );
    const deps = buildDeps({
      isWsl: vi.fn(() => true),
      findReachableOllamaHost: vi.fn(() => "host.docker.internal"),
      detectWindowsHostOllama: vi.fn(() => ({
        installed: false,
        installedPath: "",
        loopbackOnly: false,
      })),
      probeWindowsHostOllamaRouteProtection,
    });

    const state = detectWithDeps(deps);

    expect(state.hasWindowsOllama).toBe(false);
    expect(state.isWindowsHostOllama).toBe(true);
    expect(state.ollamaHost).toBe("host.docker.internal");
    expect(state.ollamaRunning).toBe(true);
    expect(state.ollamaInstallMenu.entry).toBeNull();
  });

  it("rejects a wildcard-bound Windows-host Ollama route even when Docker can reach it", () => {
    const resetOllamaHostCache = vi.fn();
    const deps = buildDeps({
      isWsl: vi.fn(() => true),
      findReachableOllamaHost: vi.fn(() => "host.docker.internal"),
      detectWindowsHostOllama: vi.fn(() => ({
        installed: true,
        installedPath: "C:\\Ollama\\ollama.exe",
        loopbackOnly: false,
      })),
      dockerCapture: vi.fn(secureWindowsOllamaDockerCapture),
      probeWindowsHostOllamaRouteProtection: vi.fn(() =>
        windowsRouteProtection({ reachable: true, hostValidationEnabled: true }),
      ),
      resetOllamaHostCache,
    });

    const state = detectWithDeps(deps);

    expect(state.isWindowsHostOllama).toBe(false);
    expect(state.ollamaHost).toBeNull();
    expect(state.ollamaRunning).toBe(false);
    expect(state.ollamaInstallMenu.entry?.key).toBe("install-ollama");
    expect(resetOllamaHostCache).toHaveBeenCalledOnce();
  });

  it("rejects Windows-host Ollama when a hostile Host header is accepted", () => {
    const resetOllamaHostCache = vi.fn();
    const probeWindowsHostOllamaRouteProtection = vi.fn(() =>
      windowsRouteProtection({ loopbackOnly: true, reachable: true }),
    );
    const deps = buildDeps({
      isWsl: vi.fn(() => true),
      findReachableOllamaHost: vi.fn(() => "host.docker.internal"),
      detectWindowsHostOllama: vi.fn(() => ({
        installed: true,
        installedPath: "C:\\Ollama\\ollama.exe",
        loopbackOnly: true,
      })),
      probeWindowsHostOllamaRouteProtection,
      resetOllamaHostCache,
    });

    const state = detectWithDeps(deps);

    expect(state.isWindowsHostOllama).toBe(false);
    expect(state.ollamaHost).toBeNull();
    expect(state.ollamaInstallMenu.entry?.key).toBe("install-ollama");
    expect(probeWindowsHostOllamaRouteProtection).toHaveBeenCalledOnce();
    expect(resetOllamaHostCache).toHaveBeenCalledOnce();
  });
});

describe("detectLocalTcpListener", () => {
  it("distinguishes Linux listeners from an empty procfs socket table (#9300)", () => {
    const header = "  sl  local_address rem_address   st\n";
    const listener = `${header}   0: 0100007F:2CAA 00000000:0000 0A\n`;

    expect(detectLocalTcpListener(11434, () => listener)).toBe(true);
    expect(detectLocalTcpListener(11434, () => header)).toBe(false);
  });

  it("fails closed when procfs is unavailable or malformed (#9300)", () => {
    expect(detectLocalTcpListener(11434, () => null)).toBeNull();
    expect(detectLocalTcpListener(11434, () => "header\nmalformed\n")).toBeNull();
    expect(
      detectLocalTcpListener(11434, (filePath) =>
        filePath.endsWith("tcp") ? "  sl  local_address rem_address   st\n" : null,
      ),
    ).toBeNull();
    expect(detectLocalTcpListener(0, () => "unused")).toBeNull();
  });
});
