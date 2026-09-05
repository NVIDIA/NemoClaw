// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
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
  launchStatuses?: number[];
  readinessResults?: boolean[];
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
  const launchStatuses = options.launchStatuses ?? [1, 1, 1];
  const readinessResults = options.readinessResults ?? [];
  const rollbackStatus = options.rollbackStatus ?? 0;
  let launchIndex = 0;
  let readinessIndex = 0;
  let interruptHandler = (_signal: "SIGINT" | "SIGTERM") => {};
  const operations = {
    captureSnapshot: vi.fn(() => {
      state.events.push("snapshot");
      return snapshot;
    }),
    persistBinding: vi.fn(() => {
      state.events.push("persist");
      state.userHost = "127.0.0.1:11434";
      return true;
    }),
    stopProcesses: vi.fn(() => {
      state.events.push("stop-existing");
      state.watcherRunning = false;
      state.daemonRunning = false;
    }),
    wait: vi.fn(),
    launchOperations: {
      runAttempt: vi.fn((attempt: { kind: "watcher" | "installed" | "path" }) => {
        const status = launchStatuses[launchIndex] ?? 1;
        launchIndex += 1;
        state.events.push(`launch:${attempt.kind}`);
        state.daemonRunning = status === 0;
        options.interruptSignal ? interruptHandler(options.interruptSignal) : undefined;
        return status === 0
          ? successfulRun()
          : { status, stderr: `${attempt.kind} launch unavailable` };
      }),
      awaitReady: vi.fn(() => {
        const ready = readinessResults[readinessIndex] ?? false;
        readinessIndex += 1;
        state.events.push("readiness");
        ready
          ? require(LOCAL_INFERENCE_PATH).setResolvedOllamaHost("host.docker.internal")
          : undefined;
        return ready;
      }),
      stopProcesses: vi.fn(() => {
        state.events.push("stop-launch-attempt");
        state.watcherRunning = false;
        state.daemonRunning = false;
      }),
      wait: vi.fn(),
    },
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
  return {
    operations,
    state,
    triggerInterrupt: (signal: "SIGINT" | "SIGTERM") => interruptHandler(signal),
  };
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
  const originalSpawn = childProcess.spawn;
  const originalRun = runner.run;
  const originalRunCapture = runner.runCapture;
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

function createMockChildProcess() {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(() => true),
  });
}

function captureDefaultWindowsRollbackInvocation(userHost: string | null) {
  const watcherPath = "C:\\Users\\tester\\Ollama\\ollama app.exe";
  const daemonPath = "C:\\Users\\tester\\Ollama\\ollama.exe";
  const launchFailure = { status: 1, stdout: "", stderr: "launch unavailable" };
  const runResults = [
    hostSnapshotRun(userHost, watcherPath, daemonPath),
    launchFailure,
    launchFailure,
    launchFailure,
    successfulRun(),
  ];
  const run = vi.fn(
    (_command: string | string[], _options?: { env?: NodeJS.ProcessEnv }) =>
      runResults.shift() ?? successfulRun(),
  );
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const { windows, restore } = loadWindowsOllamaWithMocks(
    run,
    vi.fn((command: string | string[]) =>
      commandText(command).includes("SetEnvironmentVariable('OLLAMA_HOST'")
        ? "127.0.0.1:11434"
        : "",
    ),
  );

  try {
    expect(windows.setupWindowsOllamaLoopbackBinding({ installedPath: daemonPath })).toEqual({
      ok: false,
      reason: "readiness",
    });
  } finally {
    restore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }

  return { daemonPath, run, watcherPath };
}

function createWindowsInstallBoundary(options: {
  userHost: string | null;
  watcherPath: string | null;
  daemonPath: string | null;
  installedPath?: string;
  initialReady?: boolean;
  launchStatuses?: number[];
  readinessResults?: boolean[];
  rollbackStatus?: number;
  installerInterrupt?: "SIGINT" | "SIGTERM";
  cancelInstaller?: () => Promise<void>;
}) {
  const boundary = createWindowsSetupBoundary(options);
  const cancelInstaller = vi.fn(async () => {
    boundary.state.events.push("cancel-installer");
    await options.cancelInstaller?.();
  });
  const completion = options.installerInterrupt
    ? Promise.resolve().then(() => boundary.triggerInterrupt(options.installerInterrupt!))
    : Promise.resolve();
  const operations = {
    ...boundary.operations,
    startInstaller: vi.fn(() => {
      boundary.state.events.push("install");
      boundary.state.userHost = "127.0.0.1:11434";
      boundary.state.watcherRunning = true;
      boundary.state.daemonRunning = true;
      return { completion, cancelAndWait: cancelInstaller };
    }),
    resolveInstalledPath: vi.fn(() => {
      boundary.state.events.push("resolve-path");
      return options.installedPath ?? "C:\\Users\\tester\\Ollama\\ollama.exe";
    }),
    awaitReady: vi.fn(() => {
      boundary.state.events.push("installer-readiness");
      return options.initialReady ?? false;
    }),
  };
  return { ...boundary, cancelInstaller, operations };
}

describe("Windows Ollama helper", () => {
  beforeEach(() => {
    vi.stubEnv("DOCKER_CONTEXT", "default");
    vi.stubEnv("DOCKER_HOST", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("terminates the PowerShell wrapper when cancellation precedes the PID sentinel", async () => {
    const child = createMockChildProcess();
    const spawnProcess = vi.fn(() => child);
    const { windows, restore } = loadWindowsOllamaWithMocks(
      vi.fn(),
      vi.fn(),
      spawnProcess,
    );

    try {
      const installer = windows.startWindowsOllamaInstaller();
      const cancellation = installer.cancelAndWait();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");

      child.emit("close", null);
      await expect(cancellation).resolves.toBeUndefined();
    } finally {
      restore();
    }
  });

  it("terminates the reported Windows installer process tree", async () => {
    const installerChild = createMockChildProcess();
    const taskkillChild = createMockChildProcess();
    const spawnProcess = vi.fn((command: string) =>
      command === "taskkill.exe" ? taskkillChild : installerChild,
    );
    const { windows, restore } = loadWindowsOllamaWithMocks(
      vi.fn(),
      vi.fn(),
      spawnProcess,
    );

    try {
      const installer = windows.startWindowsOllamaInstaller();
      installerChild.stdout.emit(
        "data",
        Buffer.from("__NEMOCLAW_WINDOWS_INSTALLER_PID__:4321\n"),
      );
      const cancellation = installer.cancelAndWait();
      expect(installerChild.kill).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(spawnProcess).toHaveBeenLastCalledWith(
          "taskkill.exe",
          ["/PID", "4321", "/T", "/F"],
          { stdio: "ignore" },
        ),
      );

      taskkillChild.emit("close", 0);
      installerChild.emit("close", null);
      await expect(cancellation).resolves.toBeUndefined();
    } finally {
      restore();
    }
  });

  it("describes Docker-client isolation in Windows Ollama timeout diagnostics", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { windows, restore } = loadWindowsOllamaWithMocks(vi.fn(), vi.fn());

    try {
      windows.printWindowsOllamaTimeoutDiagnostics();
    } finally {
      restore();
    }

    const diagnostic = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
    errorSpy.mockRestore();
    expect(diagnostic).toContain("nemoclaw onboard");
    expect(diagnostic).toContain("isolated Docker client configuration");
    expect(diagnostic).toContain("removes that temporary configuration afterward");
    expect(diagnostic).toContain("docker run");
    expect(diagnostic).toContain(REBINDING_PROBE_HOST_HEADER);
  });

  it("describes a snapshot inspection failure without claiming a startup timeout", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { windows, restore } = loadWindowsOllamaWithMocks(vi.fn(), vi.fn());

    try {
      windows.printWindowsOllamaSnapshotDiagnostics();
    } finally {
      restore();
    }

    const diagnostic = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
    errorSpy.mockRestore();
    expect(diagnostic).toContain("User-scope OLLAMA_HOST");
    expect(diagnostic).toContain("existing Ollama processes");
    expect(diagnostic).toContain("nemoclaw onboard");
    expect(diagnostic).not.toContain("Timed out waiting for Ollama to start");
  });

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
    const runCapture = vi.fn((command: string | string[]) => {
      return commandText(command).includes("Get-NetTCPConnection")
        ? "127.0.0.1"
        : Array.isArray(command) && command.includes(REBINDING_PROBE_HOST_HEADER)
          ? "403"
          : isDockerTagsRequest(command)
            ? invalidResponseServed
              ? serveValidResponse()
              : serveInvalidResponse()
            : "";
    });
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

  it("rejects readiness when the active runtime changes away from Docker Desktop", () => {
    const detectContainerRuntimeFromDockerInfo = vi.fn(() => "docker");
    const currentIsWsl = vi.fn(() => true);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { windows, restore } = loadWindowsOllamaWithMocks(vi.fn(), vi.fn(), undefined, {
      detectContainerRuntimeFromDockerInfo,
      isWsl: currentIsWsl,
    });

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
    } finally {
      restore();
      logSpy.mockRestore();
    }

    expect(detectContainerRuntimeFromDockerInfo).toHaveBeenCalledTimes(15);
    expect(currentIsWsl).toHaveBeenCalledTimes(15);
  });

  it("rejects a reachable daemon that accepts a rebinding Host header", () => {
    const runCapture = vi.fn((command: string | string[]) => {
      return commandText(command).includes("Get-NetTCPConnection")
        ? "127.0.0.1"
        : Array.isArray(command) && command.includes(REBINDING_PROBE_HOST_HEADER)
          ? "200"
          : isDockerTagsRequest(command)
            ? JSON.stringify({ models: [] })
            : "";
    });
    const localInference = require(LOCAL_INFERENCE_PATH);
    localInference.resetOllamaHostCache();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { windows, restore } = loadWindowsOllamaWithMocks(vi.fn(), runCapture);

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

  it("falls back from a stale watcher to the verified executable and selects Windows route", () => {
    const watcherPath = "C:\\Users\\tester\\AppData\\Local\\Programs\\Ollama\\ollama app.exe";
    const installedPath = "C:\\Users\\tester\\AppData\\Local\\Programs\\Ollama\\ollama.exe";
    const boundary = createWindowsSetupBoundary({
      userHost: "127.0.0.1:11434",
      watcherPath,
      daemonPath: installedPath,
      launchStatuses: [1, 0],
      readinessResults: [true],
    });
    const localInference = require(LOCAL_INFERENCE_PATH);
    localInference.resetOllamaHostCache();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { windows, restore } = loadWindowsOllamaWithMocks(vi.fn(), vi.fn());

    try {
      const result = windows.setupWindowsOllamaLoopbackBinding(
        { installedPath },
        boundary.operations,
      );
      expect(result.ok).toBe(true);
      result.commit();
      expect(boundary.state.events).toEqual([
        "snapshot",
        "persist",
        "stop-existing",
        "launch:watcher",
        "stop-launch-attempt",
        "launch:installed",
        "readiness",
      ]);
      expect(localInference.getResolvedOllamaHost()).toBe("host.docker.internal");
    } finally {
      localInference.resetOllamaHostCache();
      restore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
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
        windows.setupWindowsOllamaLoopbackBinding(
          { installedPath: daemonPath },
          boundary.operations,
        ),
      ).toEqual({ ok: false, reason: "readiness" });
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
      expect(windows.setupWindowsOllamaLoopbackBinding({}, boundary.operations)).toEqual({
        ok: false,
        reason: "readiness",
      });
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

  it("keeps a credential-bearing prior binding out of Windows rollback argv", () => {
    const priorHost = "https://operator:private-token@ollama.example:11434";
    const { daemonPath, run, watcherPath } = captureDefaultWindowsRollbackInvocation(priorHost);
    expect(run).toHaveBeenCalledTimes(5);
    const rollbackCall = run.mock.calls.at(-1);
    expect(rollbackCall).toBeDefined();
    const [rollbackCommand, rollbackOptions] = rollbackCall!;
    const argv = commandText(rollbackCommand);

    expect(argv).toContain("$env:NEMOCLAW_OLLAMA_RESTORE_HOST");
    expect(argv).toContain("Remove-Item Env:NEMOCLAW_OLLAMA_RESTORE_HOST");
    expect(argv).not.toContain(priorHost);
    expect(argv).not.toContain(Buffer.from(priorHost, "utf8").toString("base64"));
    expect(argv).not.toContain(watcherPath);
    expect(argv).not.toContain(daemonPath);
    expect(rollbackOptions?.env).toMatchObject({
      NEMOCLAW_OLLAMA_RESTORE_HOST: priorHost,
      NEMOCLAW_OLLAMA_RESTORE_HOST_PRESENT: "1",
      NEMOCLAW_OLLAMA_RESTORE_WATCHER: watcherPath,
      NEMOCLAW_OLLAMA_RESTORE_DAEMON: daemonPath,
    });
  });

  it("preserves a missing prior binding distinctly during Windows rollback", () => {
    const { run } = captureDefaultWindowsRollbackInvocation(null);
    const rollbackCall = run.mock.calls.at(-1);
    expect(rollbackCall).toBeDefined();
    const [, rollbackOptions] = rollbackCall!;

    expect(rollbackOptions?.env).toMatchObject({
      NEMOCLAW_OLLAMA_RESTORE_HOST: "",
      NEMOCLAW_OLLAMA_RESTORE_HOST_PRESENT: "0",
    });
  });

  it("restores the prior Windows state when install cannot resolve ollama.exe", async () => {
    const priorHost = "127.0.0.1:11434";
    const watcherPath = "C:\\Users\\tester\\Ollama\\ollama app.exe";
    const boundary = createWindowsInstallBoundary({
      userHost: priorHost,
      watcherPath,
      daemonPath: null,
      installedPath: "",
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { windows, restore } = loadWindowsOllamaWithMocks(vi.fn(), vi.fn());

    try {
      await expect(windows.installOllamaOnWindowsHost({}, boundary.operations)).resolves.toEqual({
        ok: false,
        path: "",
        reason: "install",
      });
    } finally {
      restore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(boundary.state.userHost).toBe(priorHost);
    expect(boundary.state.watcherRunning).toBe(true);
    expect(boundary.state.daemonRunning).toBe(false);
    expect(boundary.state.events).toEqual([
      "snapshot",
      "persist",
      "install",
      "resolve-path",
      "stop-replacement",
      "restore",
    ]);
  });

  it("restores the prior Windows state when installed Ollama remains unreachable", async () => {
    const priorHost = "127.0.0.1:11434";
    const daemonPath = "C:\\Users\\tester\\Ollama\\ollama.exe";
    const boundary = createWindowsInstallBoundary({
      userHost: priorHost,
      watcherPath: null,
      daemonPath,
      launchStatuses: [1, 1],
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { windows, restore } = loadWindowsOllamaWithMocks(vi.fn(), vi.fn());

    try {
      await expect(windows.installOllamaOnWindowsHost({}, boundary.operations)).resolves.toEqual({
        ok: false,
        path: daemonPath,
        reason: "readiness",
      });
    } finally {
      restore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(boundary.state.userHost).toBe(priorHost);
    expect(boundary.state.watcherRunning).toBe(false);
    expect(boundary.state.daemonRunning).toBe(true);
    expect(boundary.state.events.at(-2)).toBe("stop-replacement");
    expect(boundary.state.events.at(-1)).toBe("restore");
  });

  it("cancels install and restores prior Windows state before preserving SIGTERM", async () => {
    const priorHost = "127.0.0.1:11434";
    const watcherPath = "C:\\Users\\tester\\Ollama\\ollama app.exe";
    let finishProcessTreeCancellation = () => {};
    const processTreeDrained = new Promise<void>((resolve) => {
      finishProcessTreeCancellation = resolve;
    });
    const boundary = createWindowsInstallBoundary({
      userHost: priorHost,
      watcherPath,
      daemonPath: null,
      installerInterrupt: "SIGTERM",
      cancelInstaller: () => processTreeDrained,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { windows, restore } = loadWindowsOllamaWithMocks(vi.fn(), vi.fn());

    try {
      const installation = windows.installOllamaOnWindowsHost({}, boundary.operations);
      await vi.waitFor(() => expect(boundary.cancelInstaller).toHaveBeenCalledOnce());
      expect(boundary.state.events).toEqual(["snapshot", "persist", "install", "cancel-installer"]);
      expect(boundary.operations.rollbackSnapshot).not.toHaveBeenCalled();
      expect(boundary.operations.preserveInterrupt).not.toHaveBeenCalled();

      finishProcessTreeCancellation();
      await expect(installation).rejects.toThrow(PreservedWindowsInterrupt);
    } finally {
      restore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(boundary.state.events).toEqual([
      "snapshot",
      "persist",
      "install",
      "cancel-installer",
      "stop-replacement",
      "restore",
      "signal:SIGTERM",
    ]);
    expect(boundary.state.userHost).toBe(priorHost);
    expect(boundary.state.watcherRunning).toBe(true);
    expect(boundary.cancelInstaller).toHaveBeenCalledOnce();
  });

  it("does not restore mutable Windows state when installer tree cancellation fails", async () => {
    const boundary = createWindowsInstallBoundary({
      userHost: "127.0.0.1:11434",
      watcherPath: "C:\\Users\\tester\\Ollama\\ollama app.exe",
      daemonPath: null,
      installerInterrupt: "SIGINT",
      cancelInstaller: async () => {
        throw new Error("taskkill tree termination failed");
      },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { windows, restore } = loadWindowsOllamaWithMocks(vi.fn(), vi.fn());

    try {
      await expect(windows.installOllamaOnWindowsHost({}, boundary.operations)).rejects.toThrow(
        "taskkill tree termination failed",
      );
    } finally {
      restore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(boundary.cancelInstaller).toHaveBeenCalledOnce();
    expect(boundary.operations.rollbackSnapshot).not.toHaveBeenCalled();
    expect(boundary.operations.preserveInterrupt).not.toHaveBeenCalled();
    expect(boundary.state.events).toEqual(["snapshot", "persist", "install", "cancel-installer"]);
  });

  it("reports manual recovery when install rollback fails", async () => {
    const boundary = createWindowsInstallBoundary({
      userHost: "127.0.0.1:11434",
      watcherPath: null,
      daemonPath: null,
      installedPath: "",
      rollbackStatus: 1,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { windows, restore } = loadWindowsOllamaWithMocks(vi.fn(), vi.fn());

    try {
      await windows.installOllamaOnWindowsHost({}, boundary.operations);
    } finally {
      restore();
      logSpy.mockRestore();
    }

    const diagnostic = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
    errorSpy.mockRestore();
    expect(diagnostic).toContain("Failed to restore the previous Windows Ollama state");
    expect(diagnostic).toContain("restore your previous User-scope OLLAMA_HOST value");
  });

  it("stops a final unready replacement before restoring the prior Windows state", () => {
    const priorHost = "127.0.0.1:11434";
    const watcherPath = "C:\\Users\\tester\\Ollama\\ollama app.exe";
    const daemonPath = "C:\\Users\\tester\\Ollama\\ollama.exe";
    const boundary = createWindowsSetupBoundary({
      userHost: priorHost,
      watcherPath,
      daemonPath,
      launchStatuses: [1, 1, 0],
      readinessResults: [false],
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { windows, restore } = loadWindowsOllamaWithMocks(vi.fn(), vi.fn());

    try {
      expect(
        windows.setupWindowsOllamaLoopbackBinding(
          { installedPath: daemonPath },
          boundary.operations,
        ),
      ).toEqual({ ok: false, reason: "readiness" });
    } finally {
      restore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    const finalLaunch = boundary.state.events.lastIndexOf("launch:path");
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
        launchStatuses: [0],
        interruptSignal: signal,
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { windows, restore } = loadWindowsOllamaWithMocks(vi.fn(), vi.fn());

      try {
        expect(() =>
          windows.setupWindowsOllamaLoopbackBinding(
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
        "launch:watcher",
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
    const runCapture = vi.fn(
      (command: string | string[], options?: { env?: NodeJS.ProcessEnv }) => {
        return commandText(command).includes("Get-NetTCPConnection")
          ? "127.0.0.1"
          : !Array.isArray(command) ||
              options?.env?.DOCKER_CONFIG !== "/tmp/credential-free-docker"
            ? ""
            : command.includes(REBINDING_PROBE_HOST_HEADER)
              ? "403"
              : isDockerTagsRequest(command)
                ? JSON.stringify({ models: [] })
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
});
