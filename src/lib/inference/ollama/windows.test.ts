// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const WINDOWS_DIST_PATH = require.resolve("./windows");
const RUNNER_PATH = require.resolve("../../runner");
const LOCAL_INFERENCE_PATH = require.resolve("../local");
const WINDOWS_OLLAMA_TAGS_URL = "http://host.docker.internal:11434/api/tags";

function commandText(command: string | string[]): string {
  return Array.isArray(command) ? command.join(" ") : String(command);
}

function loadWindowsOllamaWithMocks(
  run: ReturnType<typeof vi.fn>,
  runCapture: ReturnType<typeof vi.fn>,
) {
  const runner = require(RUNNER_PATH);
  const originalRun = runner.run;
  const originalRunCapture = runner.runCapture;
  // Stub the blocking wait so this test does not spend time on retry delays.
  const atomicsWaitStub = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");

  delete require.cache[WINDOWS_DIST_PATH];
  runner.run = run;
  runner.runCapture = runCapture;

  return {
    windows: require(WINDOWS_DIST_PATH),
    restore() {
      delete require.cache[WINDOWS_DIST_PATH];
      runner.run = originalRun;
      runner.runCapture = originalRunCapture;
      atomicsWaitStub.mockRestore();
    },
  };
}

describe("Windows Ollama helper", () => {
  it("rejects a nonempty invalid Docker readiness response (#10100)", () => {
    const run = vi.fn();
    const localInference = require(LOCAL_INFERENCE_PATH);
    const runCapture = vi.fn((command: string | string[]) => {
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

  it("falls back from a stale watcher path and checks readiness from Docker Desktop (#8127)", () => {
    const watcherPath = "C:\\Users\\tester\\AppData\\Local\\Programs\\Ollama\\ollama app.exe";
    const installedPath = "C:\\Users\\tester\\AppData\\Local\\Programs\\Ollama\\ollama.exe";
    const launchScripts: string[] = [];
    const stopCommands: string[] = [];

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
      if (cmd.includes("Get-Process 'ollama app'") && cmd.includes("ExpandProperty Path")) {
        return watcherPath;
      }
      if (cmd.includes("Stop-Process")) {
        stopCommands.push(cmd);
        return "";
      }
      if (Array.isArray(command) && command.at(-1) === WINDOWS_OLLAMA_TAGS_URL) {
        return command[0] === "docker" &&
          launchScripts.some((script) => script.includes(installedPath))
          ? JSON.stringify({ models: [] })
          : "";
      }
      return "";
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const delay = vi.fn();
    const { windows, restore } = loadWindowsOllamaWithMocks(run, runCapture);

    try {
      expect(windows.setupWindowsOllamaWith0000Binding({ installedPath, delay })).toBe(true);
    } finally {
      restore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(run).toHaveBeenCalledTimes(2);
    expect(launchScripts[0]).toContain(watcherPath);
    expect(launchScripts[1]).toContain(installedPath);
    expect(launchScripts[1]).toContain("-ArgumentList 'serve'");
    expect(
      launchScripts.some((script) => script.includes("Start-Process -FilePath ollama.exe")),
    ).toBe(false);
    expect(stopCommands[0]).toContain("Get-Process 'ollama app'");
    expect(stopCommands[1]).toContain("Get-Process ollama");
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

  it("isolates Docker credentials while waiting for the Windows-host daemon", () => {
    const run = vi.fn();
    const cleanup = vi.fn(() => ({ ok: true as const }));
    const runCapture = vi.fn((command: string | string[], options?: { env?: NodeJS.ProcessEnv }) =>
      Array.isArray(command) &&
      command[0] === "docker" &&
      command.at(-1) === WINDOWS_OLLAMA_TAGS_URL &&
      options?.env?.DOCKER_CONFIG === "/tmp/credential-free-docker"
        ? JSON.stringify({ models: [] })
        : "",
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
          env: { DOCKER_CONFIG: "/tmp/credential-free-docker" },
        }),
      );
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      localInference.resetOllamaHostCache();
      restore();
      logSpy.mockRestore();
    }
  });
});
