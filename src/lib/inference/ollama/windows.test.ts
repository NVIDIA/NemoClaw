// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const WINDOWS_DIST_PATH = require.resolve("./windows");
const RUNNER_PATH = require.resolve("../../runner");
const LOCAL_INFERENCE_PATH = require.resolve("../local");

function commandText(command: string | string[]): string {
  return Array.isArray(command) ? command.join(" ") : String(command);
}

function isWindowsOllamaTagsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.username === "" &&
      url.password === "" &&
      url.hostname === "host.docker.internal" &&
      url.port === "11434" &&
      url.pathname === "/api/tags" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function isDockerTagsRequest(command: string | string[]): boolean {
  return Array.isArray(command) && command[0] === "docker" && command.some(isWindowsOllamaTagsUrl);
}

function successfulRun(stdout = "") {
  return { status: 0, stdout, stderr: "" };
}

function hostSnapshotRun(
  userHost: string | null,
  watcherPath: string | null,
  daemonPath: string | null,
) {
  return successfulRun(JSON.stringify({ userHost, watcherPath, daemonPath }));
}

type WindowsPowerShellState = {
  userHost: string | null;
  watcherRunning: boolean;
  daemonRunning: boolean;
  events: string[];
};

function createWindowsPowerShellBoundary(options: {
  userHost: string | null;
  watcherPath: string | null;
  daemonPath: string | null;
  launchStatuses?: number[];
  readinessResponse?: string;
  rollbackStatus?: number;
}) {
  const original = {
    userHost: options.userHost,
    watcherPath: options.watcherPath,
    daemonPath: options.daemonPath,
  };
  const state: WindowsPowerShellState = {
    userHost: original.userHost,
    watcherRunning: Boolean(original.watcherPath),
    daemonRunning: Boolean(original.daemonPath),
    events: [],
  };
  const launchStatuses = options.launchStatuses ?? [1, 1, 1];
  const rollbackStatus = options.rollbackStatus ?? 0;
  let launchIndex = 0;
  const run = vi.fn((command: string[]) => {
    const script = commandText(command);
    const capturesHostSnapshot = script.includes("ConvertTo-Json -Compress");
    const persistsNewBinding = script.includes(
      "SetEnvironmentVariable('OLLAMA_HOST','0.0.0.0:11434','User')",
    );
    const restoresPriorState = script.includes("$previousHost =");
    const launchesReplacement = !restoresPriorState && script.includes("Start-Process");
    const rollbackStopsWatcher = restoresPriorState && script.includes("Get-Process 'ollama app'");
    const rollbackStopsDaemon = restoresPriorState && script.includes("Get-Process ollama -EA");
    const launchStatus = launchStatuses[launchIndex] ?? 1;
    const launchesWatcher =
      launchesReplacement &&
      Boolean(original.watcherPath) &&
      script.includes(String(original.watcherPath));
    const event = capturesHostSnapshot
      ? "snapshot"
      : persistsNewBinding
        ? "persist"
        : restoresPriorState
          ? "restore"
          : launchesReplacement
            ? "launch"
            : "unexpected";
    state.events.push(
      ...(restoresPriorState
        ? [
            ...(rollbackStopsWatcher ? ["stop-watcher"] : []),
            ...(rollbackStopsDaemon ? ["stop-daemon"] : []),
            "restore",
          ]
        : [event]),
    );
    state.watcherRunning = rollbackStopsWatcher ? false : state.watcherRunning;
    state.daemonRunning = rollbackStopsDaemon ? false : state.daemonRunning;
    state.userHost = persistsNewBinding
      ? "0.0.0.0:11434"
      : restoresPriorState && rollbackStatus === 0
        ? original.userHost
        : state.userHost;
    state.watcherRunning =
      restoresPriorState && rollbackStatus === 0
        ? Boolean(original.watcherPath)
        : launchesWatcher && launchStatus === 0
          ? true
          : state.watcherRunning;
    state.daemonRunning =
      restoresPriorState && rollbackStatus === 0
        ? Boolean(original.daemonPath) && !original.watcherPath
        : launchesReplacement && launchStatus === 0 && !launchesWatcher
          ? true
          : state.daemonRunning;
    launchIndex += launchesReplacement ? 1 : 0;
    return capturesHostSnapshot
      ? hostSnapshotRun(original.userHost, original.watcherPath, original.daemonPath)
      : persistsNewBinding
        ? successfulRun()
        : restoresPriorState
          ? rollbackStatus === 0
            ? successfulRun()
            : { status: rollbackStatus, stderr: "rollback denied" }
          : launchesReplacement
            ? launchStatus === 0
              ? successfulRun()
              : { status: launchStatus, stderr: "launch unavailable" }
            : { status: 1, stderr: "unexpected PowerShell operation" };
  });
  const runCapture = vi.fn((command: string | string[]) => {
    const script = commandText(command);
    const stopsWatcher = script.includes("Get-Process 'ollama app'");
    const stopsDaemon = script.includes("Get-Process ollama -EA");
    state.watcherRunning = stopsWatcher ? false : state.watcherRunning;
    state.daemonRunning = stopsDaemon ? false : state.daemonRunning;
    state.events.push(stopsWatcher ? "stop-watcher" : stopsDaemon ? "stop-daemon" : "probe");
    return isDockerTagsRequest(command) ? (options.readinessResponse ?? "") : "";
  });
  return { run, runCapture, state };
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
      const capturesHostSnapshot = launch.includes("ConvertTo-Json -Compress");
      const persistsNewBinding = launch.includes(
        "SetEnvironmentVariable('OLLAMA_HOST','0.0.0.0:11434','User')",
      );
      const isWatcherLaunch = launch.includes(watcherPath);
      const isInstalledLaunch = launch.includes(installedPath);
      watcherLaunchAttempted ||= isWatcherLaunch;
      installedLaunchAttempted ||= isInstalledLaunch;
      return capturesHostSnapshot
        ? hostSnapshotRun("127.0.0.1:11434", watcherPath, installedPath)
        : persistsNewBinding
          ? successfulRun()
          : isWatcherLaunch
            ? { status: 1, stderr: "stale watcher path" }
            : isInstalledLaunch
              ? successfulRun()
              : { status: 1, stderr: "unexpected launch target" };
    });
    const runCapture = vi.fn((command: string | string[]) => {
      const probesDockerReadiness = isDockerTagsRequest(command);
      dockerReadinessObserved ||= probesDockerReadiness;
      return probesDockerReadiness && installedLaunchAttempted
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

  it("restores the prior binding and watcher when every rebound launch fails", () => {
    const priorHost = "127.0.0.1:11434";
    const watcherPath = "C:\\Users\\tester\\Ollama\\ollama app.exe";
    const daemonPath = "C:\\Users\\tester\\Ollama\\ollama.exe";
    const boundary = createWindowsPowerShellBoundary({
      userHost: priorHost,
      watcherPath,
      daemonPath,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { windows, restore } = loadWindowsOllamaWithMocks(boundary.run, boundary.runCapture);

    try {
      expect(windows.setupWindowsOllamaWith0000Binding({ installedPath: daemonPath })).toBe(false);
    } finally {
      restore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(boundary.state.userHost).toBe(priorHost);
    expect(boundary.state.watcherRunning).toBe(true);
    expect(boundary.state.daemonRunning).toBe(false);
    expect(boundary.state.events.at(-1)).toBe("restore");
  });

  it("prints a direct recovery command when prior Windows state rollback fails", () => {
    const priorHost = "127.0.0.1:11434";
    const daemonPath = "C:\\Users\\tester\\Ollama\\ollama.exe";
    const boundary = createWindowsPowerShellBoundary({
      userHost: priorHost,
      watcherPath: null,
      daemonPath,
      rollbackStatus: 1,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { windows, restore } = loadWindowsOllamaWithMocks(boundary.run, boundary.runCapture);

    try {
      expect(windows.setupWindowsOllamaWith0000Binding()).toBe(false);
    } finally {
      restore();
      logSpy.mockRestore();
    }

    const diagnostic = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
    errorSpy.mockRestore();
    expect(diagnostic).toContain("Failed to restore the previous Windows Ollama state");
    expect(diagnostic).toContain(`Previous User-scope OLLAMA_HOST: ${JSON.stringify(priorHost)}`);
    expect(diagnostic).toContain("Restore it and relaunch the previous Ollama process with:");
    expect(diagnostic).toContain("powershell.exe -NoProfile -EncodedCommand");
  });

  it("stops a final unready replacement before restoring the prior Windows state", () => {
    const priorHost = "127.0.0.1:11434";
    const watcherPath = "C:\\Users\\tester\\Ollama\\ollama app.exe";
    const daemonPath = "C:\\Users\\tester\\Ollama\\ollama.exe";
    const boundary = createWindowsPowerShellBoundary({
      userHost: priorHost,
      watcherPath,
      daemonPath,
      launchStatuses: [1, 1, 0],
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { windows, restore } = loadWindowsOllamaWithMocks(boundary.run, boundary.runCapture);

    try {
      expect(windows.setupWindowsOllamaWith0000Binding({ installedPath: daemonPath })).toBe(false);
    } finally {
      restore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    const finalLaunch = boundary.state.events.lastIndexOf("launch");
    const finalStop = boundary.state.events.lastIndexOf("stop-daemon");
    const rollback = boundary.state.events.lastIndexOf("restore");
    expect(finalLaunch).toBeLessThan(finalStop);
    expect(finalStop).toBeLessThan(rollback);
    expect(boundary.state.userHost).toBe(priorHost);
    expect(boundary.state.watcherRunning).toBe(true);
    expect(boundary.state.daemonRunning).toBe(false);
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
