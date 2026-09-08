// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const WINDOWS_DIST_PATH = require.resolve("./windows");
const DOCKER_ADAPTER_PATH = require.resolve("../../adapters/docker/runtime");
const PLATFORM_PATH = require.resolve("../../platform");
const RUNNER_PATH = require.resolve("../../runner");
const LOCAL_INFERENCE_PATH = require.resolve("../local");
const WINDOWS_OLLAMA_TAGS_URL = "http://host.docker.internal:11434/api/tags";
const REBINDING_PROBE_HOST_HEADER = "Host: rebinding.invalid";

function commandText(command: string | string[]): string {
  return Array.isArray(command) ? command.join(" ") : String(command);
}

function loadWindowsOllamaWithMocks(
  run: ReturnType<typeof vi.fn>,
  runCapture: ReturnType<typeof vi.fn>,
  spawnImpl?: ReturnType<typeof vi.fn>,
  observerOverrides: {
    detectContainerRuntimeFromDockerInfo?: ReturnType<typeof vi.fn>;
    isWsl?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const dockerAdapter = require(DOCKER_ADAPTER_PATH);
  const platform = require(PLATFORM_PATH);
  const runner = require(RUNNER_PATH);
  const childProcess = require("child_process");
  const originalDetectContainerRuntimeFromDockerInfo =
    dockerAdapter.detectContainerRuntimeFromDockerInfo;
  const originalIsWsl = platform.isWsl;
  const originalRun = runner.run;
  const originalRunCapture = runner.runCapture;
  const originalSpawn = childProcess.spawn;
  // Stub the blocking wait so this test does not spend time on retry delays.
  const atomicsWaitStub = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");

  delete require.cache[WINDOWS_DIST_PATH];
  dockerAdapter.detectContainerRuntimeFromDockerInfo =
    observerOverrides.detectContainerRuntimeFromDockerInfo ?? vi.fn(() => "docker-desktop");
  platform.isWsl = observerOverrides.isWsl ?? vi.fn(() => true);
  runner.run = run;
  runner.runCapture = runCapture;
  childProcess.spawn = spawnImpl ?? originalSpawn;

  return {
    windows: require(WINDOWS_DIST_PATH),
    restore() {
      delete require.cache[WINDOWS_DIST_PATH];
      dockerAdapter.detectContainerRuntimeFromDockerInfo =
        originalDetectContainerRuntimeFromDockerInfo;
      platform.isWsl = originalIsWsl;
      runner.run = originalRun;
      runner.runCapture = originalRunCapture;
      childProcess.spawn = originalSpawn;
      atomicsWaitStub.mockRestore();
    },
  };
}

describe("Windows Ollama helper", () => {
  beforeEach(() => {
    vi.stubEnv("DOCKER_CONTEXT", "default");
    vi.stubEnv("DOCKER_HOST", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects a nonempty invalid Docker readiness response (#10100)", () => {
    const run = vi.fn();
    const localInference = require(LOCAL_INFERENCE_PATH);
    const runCapture = vi.fn((command: string | string[]) => {
      if (commandText(command).includes("Get-NetTCPConnection")) return "127.0.0.1";
      expect(command).toEqual(
        expect.arrayContaining([
          "docker",
          "run",
          "--rm",
          localInference.CONTAINER_REACHABILITY_IMAGE,
          WINDOWS_OLLAMA_TAGS_URL,
        ]),
      );
      expect(command.slice(0, 4)).toEqual([
        "docker",
        "run",
        "--rm",
        localInference.CONTAINER_REACHABILITY_IMAGE,
      ]);
      expect(command.at(-1)).toBe(WINDOWS_OLLAMA_TAGS_URL);
      return "<html>proxy response</html>";
    });
    localInference.resetOllamaHostCache();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { windows, restore } = loadWindowsOllamaWithMocks(run, runCapture);

    try {
      expect(
        windows.awaitWindowsOllamaReady({
          delay: vi.fn(),
          prepareDockerEnvironment: () => ({
            env: {},
            isolatedCredentialConfig: false,
            cleanup: () => ({ ok: true }),
          }),
        }),
      ).toBe(false);
      expect(runCapture.mock.calls.length).toBeGreaterThan(0);
      expect(localInference.getResolvedOllamaHost()).toBe("127.0.0.1");
    } finally {
      localInference.resetOllamaHostCache();
      restore();
      logSpy.mockRestore();
    }
  });

  it("rejects readiness when the active runtime changes away from Docker Desktop", () => {
    const run = vi.fn();
    const runCapture = vi.fn();
    const detectContainerRuntimeFromDockerInfo = vi.fn(() => "docker");
    const currentIsWsl = vi.fn(() => true);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { windows, restore } = loadWindowsOllamaWithMocks(run, runCapture, undefined, {
      detectContainerRuntimeFromDockerInfo,
      isWsl: currentIsWsl,
    });

    try {
      expect(windows.awaitWindowsOllamaReady({ delay: vi.fn() })).toBe(false);
    } finally {
      restore();
      logSpy.mockRestore();
    }

    expect(detectContainerRuntimeFromDockerInfo).toHaveBeenCalledTimes(15);
    expect(currentIsWsl).toHaveBeenCalledTimes(15);
    expect(runCapture).not.toHaveBeenCalled();
  });

  it("rejects a reachable daemon that accepts a rebinding Host header", () => {
    const run = vi.fn();
    const localInference = require(LOCAL_INFERENCE_PATH);
    const runCapture = vi.fn((command: string | string[]) => {
      if (commandText(command).includes("Get-NetTCPConnection")) return "127.0.0.1";
      return Array.isArray(command) && command.includes(REBINDING_PROBE_HOST_HEADER)
        ? "200"
        : Array.isArray(command) && command.at(-1) === WINDOWS_OLLAMA_TAGS_URL
          ? JSON.stringify({ models: [] })
          : "";
    });
    localInference.resetOllamaHostCache();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { windows, restore } = loadWindowsOllamaWithMocks(run, runCapture);

    try {
      expect(
        windows.awaitWindowsOllamaReady({
          delay: vi.fn(),
          prepareDockerEnvironment: () => ({
            env: {},
            isolatedCredentialConfig: false,
            cleanup: () => ({ ok: true }),
          }),
        }),
      ).toBe(false);
      expect(localInference.getResolvedOllamaHost()).toBe("127.0.0.1");
    } finally {
      localInference.resetOllamaHostCache();
      restore();
      logSpy.mockRestore();
    }
  });

  it("falls back from a stale watcher path and checks readiness from Docker Desktop (#8127)", () => {
    const watcherPath = "C:\\Users\\tester\\AppData\\Local\\Programs\\Ollama\\ollama app.exe";
    const installedPath = "C:\\Users\\tester\\AppData\\Local\\Programs\\Ollama\\ollama.exe";
    const launchScripts: string[] = [];
    const stopCommands: string[] = [];
    const persistedHostCommands: string[] = [];

    const run = vi.fn((command: string[]) => {
      const script = command[2] || "";
      launchScripts.push(script);
      if (script.includes(watcherPath)) {
        return { status: 1, stderr: "stale watcher path" };
      }
      return { status: 0, stderr: "" };
    });
    const runCapture = vi.fn((command: string | string[]) => {
      const cmd = commandText(command);
      switch (true) {
        case cmd.includes("Get-Process 'ollama app'") && cmd.includes("ExpandProperty Path"):
          return watcherPath;
        case cmd.includes("Stop-Process"):
          stopCommands.push(cmd);
          return "";
        case cmd.includes("SetEnvironmentVariable('OLLAMA_HOST'"):
          persistedHostCommands.push(cmd);
          return "127.0.0.1:11434";
        case cmd.includes("Get-NetTCPConnection"):
          return "127.0.0.1";
        case Array.isArray(command) && command.includes(REBINDING_PROBE_HOST_HEADER):
          return "403";
        case Array.isArray(command) && command.at(-1) === WINDOWS_OLLAMA_TAGS_URL:
          return command[0] === "docker" &&
            launchScripts.some((script) => script.includes(installedPath))
            ? JSON.stringify({ models: [] })
            : "";
        default:
          return "";
      }
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const delay = vi.fn();
    const { windows, restore } = loadWindowsOllamaWithMocks(run, runCapture);

    try {
      expect(windows.setupWindowsOllamaLoopbackBinding({ installedPath, delay })).toBe(true);
    } finally {
      restore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(run).toHaveBeenCalledTimes(2);
    expect(launchScripts[0]).toContain(watcherPath);
    expect(launchScripts[1]).toContain(installedPath);
    expect(launchScripts[1]).toContain("-ArgumentList 'serve'");
    expect(launchScripts.every((script) => !script.includes("0.0.0.0:11434"))).toBe(true);
    expect(launchScripts.some((script) => script.includes("127.0.0.1:11434"))).toBe(true);
    expect(
      launchScripts.some((script) => script.includes("Start-Process -FilePath ollama.exe")),
    ).toBe(false);
    expect(stopCommands[0]).toContain("Get-Process 'ollama app'");
    expect(stopCommands[1]).toContain("Get-Process ollama");
    expect(persistedHostCommands).toEqual([expect.stringContaining("'127.0.0.1:11434'")]);
    expect(persistedHostCommands[0]).toContain("GetEnvironmentVariable('OLLAMA_HOST','User')");
    expect(persistedHostCommands[0]).not.toContain("0.0.0.0:11434");
    expect(runCapture).toHaveBeenCalledWith(
      [
        "docker",
        "run",
        "--rm",
        "docker.io/curlimages/curl@sha256:d9b4541e214bcd85196d6e92e2753ac6d0ea699f0af5741f8c6cccbfcf00ef4b",
        "-sf",
        "--connect-timeout",
        "2",
        "--max-time",
        "5",
        "http://host.docker.internal:11434/api/tags",
      ],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(delay).toHaveBeenCalled();
    expect(delay.mock.calls.every(([seconds]) => seconds > 0 && seconds <= 2)).toBe(true);
  });

  it("explains recovery when every launch fails after persisting the loopback binding", () => {
    const watcherPath = "C:\\Users\\tester\\AppData\\Local\\Programs\\Ollama\\ollama app.exe";
    const installedPath = "C:\\Users\\tester\\AppData\\Local\\Programs\\Ollama\\ollama.exe";
    const run = vi.fn(() => ({ status: 1, stderr: "launch failed" }));
    const runCapture = vi.fn((command: string | string[]) => {
      const rendered = commandText(command);
      return rendered.includes("Get-Process 'ollama app'") &&
        rendered.includes("ExpandProperty Path")
        ? watcherPath
        : rendered.includes("SetEnvironmentVariable('OLLAMA_HOST'")
          ? "127.0.0.1:11434"
          : "";
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { windows, restore } = loadWindowsOllamaWithMocks(run, runCapture);
    let errors: string[] = [];

    try {
      expect(
        windows.setupWindowsOllamaLoopbackBinding({
          installedPath,
          delay: vi.fn(),
        }),
      ).toBe(false);
      errors = errorSpy.mock.calls.map(([message]) => String(message));
    } finally {
      restore();
      errorSpy.mockRestore();
    }

    expect(run).toHaveBeenCalledTimes(3);
    expect(errors).toContainEqual(
      expect.stringContaining("OLLAMA_HOST=127.0.0.1:11434 setting was persisted"),
    );
    expect(errors).toContainEqual(expect.stringContaining("Ollama may now be stopped"));
    expect(errors).toContainEqual(expect.stringContaining("rerun `nemoclaw onboard`"));
  });

  it("fails repair before stopping Ollama when the persistent loopback setting is rejected", () => {
    const run = vi.fn();
    const runCapture = vi.fn((command: string | string[]) =>
      commandText(command).includes("SetEnvironmentVariable('OLLAMA_HOST'") ? "0.0.0.0:11434" : "",
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { windows, restore } = loadWindowsOllamaWithMocks(run, runCapture);

    try {
      expect(windows.setupWindowsOllamaLoopbackBinding()).toBe(false);
    } finally {
      restore();
      errorSpy.mockRestore();
    }

    expect(run).not.toHaveBeenCalled();
    expect(
      runCapture.mock.calls.some(([command]) => commandText(command).includes("Stop-Process")),
    ).toBe(false);
  });

  it("fails fresh installation before spawning when the persistent loopback setting is rejected", async () => {
    const run = vi.fn();
    const runCapture = vi.fn((command: string | string[]) =>
      commandText(command).includes("SetEnvironmentVariable('OLLAMA_HOST'") ? "0.0.0.0:11434" : "",
    );
    const spawn = vi.fn();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { windows, restore } = loadWindowsOllamaWithMocks(run, runCapture, spawn);

    try {
      await expect(windows.installOllamaOnWindowsHost()).resolves.toEqual({ ok: false, path: "" });
    } finally {
      restore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(spawn).not.toHaveBeenCalled();
  });

  it("isolates Docker credentials while waiting for the Windows-host daemon", () => {
    const run = vi.fn();
    const cleanup = vi.fn(() => ({ ok: true as const }));
    const runCapture = vi.fn(
      (command: string | string[], options?: { env?: NodeJS.ProcessEnv }) => {
        if (commandText(command).includes("Get-NetTCPConnection")) return "127.0.0.1";
        return Array.isArray(command) &&
          command[0] === "docker" &&
          options?.env?.DOCKER_CONFIG === "/tmp/credential-free-docker"
          ? command.includes(REBINDING_PROBE_HOST_HEADER)
            ? "403"
            : command.at(-1) === WINDOWS_OLLAMA_TAGS_URL
              ? JSON.stringify({ models: [] })
              : ""
          : "";
      },
    );
    const localInference = require(LOCAL_INFERENCE_PATH);
    localInference.resetOllamaHostCache();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { windows, restore } = loadWindowsOllamaWithMocks(run, runCapture);

    try {
      expect(
        windows.awaitWindowsOllamaReady({
          prepareDockerEnvironment: () => ({
            env: { DOCKER_CONFIG: "/tmp/credential-free-docker" },
            isolatedCredentialConfig: true,
            cleanup,
          }),
        }),
      ).toBe(true);
      expect(localInference.getResolvedOllamaHost()).toBe("host.docker.internal");
      expect(runCapture).toHaveBeenCalledWith(
        expect.arrayContaining(["docker", "run", "--rm", WINDOWS_OLLAMA_TAGS_URL]),
        expect.objectContaining({
          ignoreError: true,
          env: expect.objectContaining({
            DOCKER_CONFIG: "/tmp/credential-free-docker",
            DOCKER_CONTEXT: "default",
          }),
        }),
      );
      expect(cleanup).toHaveBeenCalledTimes(2);
    } finally {
      localInference.resetOllamaHostCache();
      restore();
      logSpy.mockRestore();
    }
  });

  it("prints both Docker reachability and Host-validation timeout diagnostics", () => {
    const run = vi.fn();
    const runCapture = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { windows, restore } = loadWindowsOllamaWithMocks(run, runCapture);
    let diagnostics: string[] = [];

    try {
      windows.printWindowsOllamaTimeoutDiagnostics();
      diagnostics = errorSpy.mock.calls.map(([message]) => String(message));
    } finally {
      restore();
      errorSpy.mockRestore();
    }

    expect(diagnostics).toContainEqual(
      expect.stringContaining(
        `docker run --rm ${require(LOCAL_INFERENCE_PATH).CONTAINER_REACHABILITY_IMAGE} -sf`,
      ),
    );
    expect(diagnostics).toContainEqual(
      expect.stringContaining(
        `docker run --rm ${require(LOCAL_INFERENCE_PATH).CONTAINER_REACHABILITY_IMAGE} -sS --output /dev/null --write-out %{http_code}`,
      ),
    );
    expect(diagnostics).toContainEqual(expect.stringContaining(REBINDING_PROBE_HOST_HEADER));
    expect(diagnostics).toContainEqual(expect.stringContaining("Expected output: 403"));
  });
});
