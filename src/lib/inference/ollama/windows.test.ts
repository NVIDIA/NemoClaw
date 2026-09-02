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

function isDockerTagsRequest(command: string | string[]): boolean {
  return (
    Array.isArray(command) && command[0] === "docker" && command.includes(WINDOWS_OLLAMA_TAGS_URL)
  );
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
  it("continues probing after a nonempty invalid Docker readiness response (#10100)", () => {
    const run = vi.fn();
    const localInference = require(LOCAL_INFERENCE_PATH);
    let invalidResponseServed = false;
    let validResponseServed = false;
    const serveInvalidResponse = () => {
      invalidResponseServed = true;
      return "<html>proxy response</html>";
    };
    const serveValidResponse = () => {
      validResponseServed = true;
      return JSON.stringify({ models: [] });
    };
    const runCapture = vi.fn((command: string | string[]) =>
      isDockerTagsRequest(command)
        ? invalidResponseServed
          ? serveValidResponse()
          : serveInvalidResponse()
        : "",
    );
    localInference.resetOllamaHostCache();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { windows, restore } = loadWindowsOllamaWithMocks(run, runCapture);

    try {
      expect(
        windows.awaitWindowsOllamaReady({
          prepareDockerEnvironment: () => ({
            env: {},
            isolatedCredentialConfig: false,
            cleanup: () => ({ ok: true }),
          }),
        }),
      ).toBe(true);
      expect(invalidResponseServed).toBe(true);
      expect(validResponseServed).toBe(true);
      expect(localInference.getResolvedOllamaHost()).toBe("host.docker.internal");
    } finally {
      localInference.resetOllamaHostCache();
      restore();
      logSpy.mockRestore();
    }
  });

  it("falls back from a stale watcher path and checks readiness from Docker Desktop (#8127)", () => {
    const watcherPath = "C:\\Users\\tester\\AppData\\Local\\Programs\\Ollama\\ollama app.exe";
    const installedPath = "C:\\Users\\tester\\AppData\\Local\\Programs\\Ollama\\ollama.exe";
    let watcherLaunchAttempted = false;
    let installedLaunchAttempted = false;
    let dockerReadinessObserved = false;

    const run = vi.fn((command: string[]) => {
      const launch = commandText(command);
      const isWatcherLaunch = launch.includes(watcherPath);
      const isInstalledLaunch = launch.includes(installedPath);
      watcherLaunchAttempted ||= isWatcherLaunch;
      installedLaunchAttempted ||= isInstalledLaunch;
      return isWatcherLaunch
        ? { status: 1, stderr: "stale watcher path" }
        : isInstalledLaunch
          ? { status: 0, stderr: "" }
          : { status: 1, stderr: "unexpected launch target" };
    });
    const runCapture = vi.fn((command: string | string[]) => {
      const cmd = commandText(command);
      const capturesWatcherPath =
        cmd.includes("Get-Process 'ollama app'") && cmd.includes("ExpandProperty Path");
      const probesDockerReadiness = isDockerTagsRequest(command);
      dockerReadinessObserved ||= probesDockerReadiness;
      return capturesWatcherPath
        ? watcherPath
        : probesDockerReadiness && installedLaunchAttempted
          ? JSON.stringify({ models: [] })
          : "";
    });
    const localInference = require(LOCAL_INFERENCE_PATH);
    localInference.resetOllamaHostCache();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { windows, restore } = loadWindowsOllamaWithMocks(run, runCapture);

    try {
      expect(windows.setupWindowsOllamaWith0000Binding({ installedPath })).toBe(true);
    } finally {
      localInference.resetOllamaHostCache();
      restore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(watcherLaunchAttempted).toBe(true);
    expect(installedLaunchAttempted).toBe(true);
    expect(dockerReadinessObserved).toBe(true);
  });

  it("isolates Docker credentials while waiting for the Windows-host daemon", () => {
    const run = vi.fn();
    const cleanup = vi.fn(() => ({ ok: true as const }));
    let credentialFreeDockerRequestObserved = false;
    const runCapture = vi.fn(
      (command: string | string[], options?: { env?: NodeJS.ProcessEnv }) => {
        credentialFreeDockerRequestObserved =
          isDockerTagsRequest(command) &&
          options?.env?.DOCKER_CONFIG === "/tmp/credential-free-docker";
        return credentialFreeDockerRequestObserved ? JSON.stringify({ models: [] }) : "";
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
      expect(credentialFreeDockerRequestObserved).toBe(true);
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      localInference.resetOllamaHostCache();
      restore();
      logSpy.mockRestore();
    }
  });
});
