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

type WindowsSetupState = {
  userHost: string | null;
  watcherRunning: boolean;
  daemonRunning: boolean;
  events: string[];
};

class PreservedWindowsInterrupt extends Error {
  constructor(readonly signal: NodeJS.Signals) {
    super(`preserved ${signal}`);
  }
}

function createWindowsSetupBoundary(options: {
  userHost: string | null;
  watcherPath: string | null;
  daemonPath: string | null;
  replacementRemainsRunning?: boolean;
  rollbackStatus?: number;
  interruptSignal?: "SIGINT" | "SIGTERM";
}) {
  const snapshot = {
    userHost: options.userHost,
    watcherPath: options.watcherPath,
    daemonPath: options.daemonPath,
  };
  const state: WindowsSetupState = {
    userHost: snapshot.userHost,
    watcherRunning: Boolean(snapshot.watcherPath),
    daemonRunning: Boolean(snapshot.daemonPath),
    events: [],
  };
  const rollbackStatus = options.rollbackStatus ?? 0;
  let interruptHandler = (_signal: "SIGINT" | "SIGTERM") => {};
  const operations = {
    captureSnapshot: vi.fn(() => {
      state.events.push("snapshot");
      return snapshot;
    }),
    persistBinding: vi.fn(() => {
      state.events.push("persist");
      state.userHost = "0.0.0.0:11434";
      return true;
    }),
    stopProcesses: vi.fn(() => {
      state.events.push("stop-existing");
      state.watcherRunning = false;
      state.daemonRunning = false;
    }),
    wait: vi.fn(),
    launch: vi.fn(() => {
      state.events.push("launch");
      state.daemonRunning = options.replacementRemainsRunning ?? false;
      options.interruptSignal ? interruptHandler(options.interruptSignal) : undefined;
      return false;
    }),
    rollbackSnapshot: vi.fn(() => {
      state.events.push("stop-replacement", "restore");
      const restored = rollbackStatus === 0;
      state.userHost = restored ? snapshot.userHost : state.userHost;
      state.watcherRunning = restored ? Boolean(snapshot.watcherPath) : false;
      state.daemonRunning = restored
        ? Boolean(snapshot.daemonPath) && !snapshot.watcherPath
        : false;
      return restored;
    }),
    registerInterruptHandler: vi.fn((handler: (signal: "SIGINT" | "SIGTERM") => void) => {
      interruptHandler = handler;
      return vi.fn();
    }),
    preserveInterrupt: vi.fn((signal: "SIGINT" | "SIGTERM") => {
      state.events.push(`signal:${signal}`);
      throw new PreservedWindowsInterrupt(signal);
    }),
  };
  return { operations, state };
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
    const boundary = createWindowsSetupBoundary({
      userHost: priorHost,
      watcherPath,
      daemonPath,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { windows, restore } = loadWindowsOllamaWithMocks(vi.fn(), vi.fn());

    try {
      expect(
        windows.setupWindowsOllamaWith0000Binding(
          { installedPath: daemonPath },
          boundary.operations,
        ),
      ).toBe(false);
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

  it("redacts the prior binding from a failed Windows rollback diagnostic", () => {
    const priorHost = "https://operator:private-token@ollama.example:11434";
    const daemonPath = "C:\\Users\\tester\\Ollama\\ollama.exe";
    const boundary = createWindowsSetupBoundary({
      userHost: priorHost,
      watcherPath: null,
      daemonPath,
      rollbackStatus: 1,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { windows, restore } = loadWindowsOllamaWithMocks(vi.fn(), vi.fn());

    try {
      expect(windows.setupWindowsOllamaWith0000Binding({}, boundary.operations)).toBe(false);
    } finally {
      restore();
      logSpy.mockRestore();
    }

    const diagnostic = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
    errorSpy.mockRestore();
    expect(diagnostic).toContain("Failed to restore the previous Windows Ollama state");
    expect(diagnostic).toContain("restore your previous User-scope OLLAMA_HOST value");
    expect(diagnostic).toContain("relaunch the previous Ollama app or daemon");
    expect(diagnostic).not.toContain(priorHost);
    expect(diagnostic).not.toContain("private-token");
    expect(diagnostic).not.toContain(Buffer.from(priorHost, "utf8").toString("base64"));
  });

  it("stops a final unready replacement before restoring the prior Windows state", () => {
    const priorHost = "127.0.0.1:11434";
    const watcherPath = "C:\\Users\\tester\\Ollama\\ollama app.exe";
    const daemonPath = "C:\\Users\\tester\\Ollama\\ollama.exe";
    const boundary = createWindowsSetupBoundary({
      userHost: priorHost,
      watcherPath,
      daemonPath,
      replacementRemainsRunning: true,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { windows, restore } = loadWindowsOllamaWithMocks(vi.fn(), vi.fn());

    try {
      expect(
        windows.setupWindowsOllamaWith0000Binding(
          { installedPath: daemonPath },
          boundary.operations,
        ),
      ).toBe(false);
    } finally {
      restore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    const finalLaunch = boundary.state.events.lastIndexOf("launch");
    const finalStop = boundary.state.events.lastIndexOf("stop-replacement");
    const rollback = boundary.state.events.lastIndexOf("restore");
    expect(finalLaunch).toBeLessThan(finalStop);
    expect(finalStop).toBeLessThan(rollback);
    expect(boundary.state.userHost).toBe(priorHost);
    expect(boundary.state.watcherRunning).toBe(true);
    expect(boundary.state.daemonRunning).toBe(false);
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "restores the prior Windows state before preserving %s",
    (signal) => {
      const priorHost = "127.0.0.1:11434";
      const watcherPath = "C:\\Users\\tester\\Ollama\\ollama app.exe";
      const daemonPath = "C:\\Users\\tester\\Ollama\\ollama.exe";
      const boundary = createWindowsSetupBoundary({
        userHost: priorHost,
        watcherPath,
        daemonPath,
        replacementRemainsRunning: true,
        interruptSignal: signal,
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { windows, restore } = loadWindowsOllamaWithMocks(vi.fn(), vi.fn());

      try {
        expect(() =>
          windows.setupWindowsOllamaWith0000Binding(
            { installedPath: daemonPath },
            boundary.operations,
          ),
        ).toThrow(PreservedWindowsInterrupt);
      } finally {
        restore();
        logSpy.mockRestore();
        errorSpy.mockRestore();
      }

      expect(boundary.state.events).toEqual([
        "snapshot",
        "persist",
        "stop-existing",
        "launch",
        "stop-replacement",
        "restore",
        `signal:${signal}`,
      ]);
      expect(boundary.state.userHost).toBe(priorHost);
      expect(boundary.state.watcherRunning).toBe(true);
      expect(boundary.state.daemonRunning).toBe(false);
      expect(boundary.operations.preserveInterrupt).toHaveBeenCalledWith(signal);
    },
  );

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
