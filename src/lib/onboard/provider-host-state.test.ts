// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { MIN_OLLAMA_VERSION } from "../inference/ollama-version";
import { getWindowsHostOllamaDockerRequirement } from "./local-inference-topology";
import {
  type DetectInferenceProviderHostStateDeps,
  detectLocalTcpListener,
  detectInferenceProviderHostState,
  type InferenceProviderHostGpu,
} from "./provider-host-state";

const WINDOWS_OLLAMA_TAGS_URL = "http://host.docker.internal:11434/api/tags";
const VALID_OLLAMA_TAGS_BODY = '{"models": [{"name": "llama3.2:latest"}]}';

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
      hostCommandExists: vi.fn((command) => command === "ollama"),
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
    const dockerCapture = vi.fn((command: string[]) =>
      command.at(-1) === WINDOWS_OLLAMA_TAGS_URL ? VALID_OLLAMA_TAGS_BODY : "",
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
      dockerCapture,
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
    expect(dockerCapture).toHaveBeenCalledWith(
      [
        "run",
        "--rm",
        "curlimages/curl:8.10.1",
        "-sf",
        "--connect-timeout",
        "2",
        "--max-time",
        "5",
        WINDOWS_OLLAMA_TAGS_URL,
      ],
      { ignoreError: true },
    );
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
        loopbackOnly: false,
      })),
      runCapture: vi.fn((command) => {
        const joined = command.join(" ");
        if (joined.includes("wslinfo --networking-mode")) return "mirrored\n";
        return "";
      }),
      dockerCapture: vi.fn((command) =>
        command.at(-1) === WINDOWS_OLLAMA_TAGS_URL ? VALID_OLLAMA_TAGS_BODY : "",
      ),
      detectLocalTcpListener: vi.fn(() => false),
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
        command.join(" ").includes("wslinfo --networking-mode") ? "mirrored\n" : "",
      ),
      dockerCapture: vi.fn((command) =>
        command.at(-1) === WINDOWS_OLLAMA_TAGS_URL ? VALID_OLLAMA_TAGS_BODY : "",
      ),
      detectLocalTcpListener: vi.fn(() => true),
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
  });

  it("fails closed when mirrored listener identity is unavailable (#9300)", () => {
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
    });

    const state = detectWithDeps(deps);

    expect(state.isWindowsHostOllama).toBe(false);
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

  it("probes Docker reachability when WSL can reach Windows-host Ollama (#10100)", () => {
    const runCapture = vi.fn<DetectInferenceProviderHostStateDeps["runCapture"]>(() => "");
    const dockerCapture = vi.fn<DetectInferenceProviderHostStateDeps["dockerCapture"]>(() => "");
    const deps = buildDeps({
      isWsl: vi.fn(() => true),
      findReachableOllamaHost: vi.fn(() => "host.docker.internal"),
      detectWindowsHostOllama: vi.fn(() => ({
        installed: true,
        installedPath: "C:\\Ollama\\ollama.exe",
        loopbackOnly: true,
      })),
      runCapture,
      dockerCapture,
    });

    const state = detectWithDeps(deps);

    expect(state.isWindowsHostOllama).toBe(true);
    expect(state.windowsOllamaReachable).toBe(false);
    expect(dockerCapture).toHaveBeenCalledWith(
      expect.arrayContaining([WINDOWS_OLLAMA_TAGS_URL]),
      { ignoreError: true },
    );
  });

  it("reuses Windows-host Ollama only after Docker reachability succeeds (#10100)", () => {
    const dockerCapture = vi.fn<DetectInferenceProviderHostStateDeps["dockerCapture"]>(
      (command) => (command.at(-1) === WINDOWS_OLLAMA_TAGS_URL ? VALID_OLLAMA_TAGS_BODY : ""),
    );
    const deps = buildDeps({
      isWsl: vi.fn(() => true),
      findReachableOllamaHost: vi.fn(() => "host.docker.internal"),
      detectWindowsHostOllama: vi.fn(() => ({
        installed: true,
        installedPath: "C:\\Ollama\\ollama.exe",
        loopbackOnly: false,
      })),
      dockerCapture,
    });

    const state = detectWithDeps(deps);

    expect(state.isWindowsHostOllama).toBe(true);
    expect(state.windowsOllamaReachable).toBe(true);
    expect(dockerCapture).toHaveBeenCalledWith(
      expect.arrayContaining([WINDOWS_OLLAMA_TAGS_URL]),
      { ignoreError: true },
    );
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
