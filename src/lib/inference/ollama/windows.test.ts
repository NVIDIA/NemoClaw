// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
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
  const atomicsWaitSpy = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
  // Prove the retired subprocess-sleep path stays unused: the module must not
  // call child_process.spawnSync for its fixed readiness delays.
  const originalSpawnSync = childProcess.spawnSync;
  const spawnSyncSpy = vi.fn(() => ({ status: 0 }));
  childProcess.spawnSync = spawnSyncSpy;

  delete require.cache[WINDOWS_DIST_PATH];
  runner.run = run;
  runner.runCapture = runCapture;

  return {
    windows: require(WINDOWS_DIST_PATH),
    atomicsWaitSpy,
    spawnSyncSpy,
    restore() {
      delete require.cache[WINDOWS_DIST_PATH];
      runner.run = originalRun;
      runner.runCapture = originalRunCapture;
      childProcess.spawnSync = originalSpawnSync;
      atomicsWaitSpy.mockRestore();
    },
  };
}

describe("Windows Ollama helper", () => {
  it("rejects a nonempty invalid Docker readiness response (#10100)", () => {
    const run = vi.fn();
    const runCapture = vi.fn((command: string | string[]) =>
      Array.isArray(command) && command.at(-1) === WINDOWS_OLLAMA_TAGS_URL
        ? "<html>proxy response</html>"
        : "",
    );
    const localInference = require(LOCAL_INFERENCE_PATH);
    localInference.resetOllamaHostCache();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { windows, restore, atomicsWaitSpy } = loadWindowsOllamaWithMocks(run, runCapture);

    try {
      expect(windows.awaitWindowsOllamaReady()).toBe(false);
      expect(atomicsWaitSpy).toHaveBeenCalledTimes(15);
      expect(runCapture).toHaveBeenCalledTimes(15);
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
    const { windows, restore, atomicsWaitSpy, spawnSyncSpy } = loadWindowsOllamaWithMocks(run, runCapture);

    try {
      expect(windows.setupWindowsOllamaWith0000Binding({ installedPath })).toBe(true);
      // The blocking wait settles for 1s after the kill, pauses 1s between
      // launch attempts, then polls readiness with a 2s delay.
      expect(atomicsWaitSpy).toHaveBeenCalledTimes(3);
      // The wait must target the module's shared backing store (a plain
      // ArrayBuffer would be rejected by Atomics.wait).
      atomicsWaitSpy.mock.calls.forEach(([array]) => {
        expect(array).toBeInstanceOf(Int32Array);
        expect(array.buffer).toBeInstanceOf(SharedArrayBuffer);
      });
      expect(atomicsWaitSpy).toHaveBeenNthCalledWith(1, expect.any(Int32Array), 0, 0, 1000);
      expect(atomicsWaitSpy).toHaveBeenNthCalledWith(2, expect.any(Int32Array), 0, 0, 1000);
      expect(atomicsWaitSpy).toHaveBeenNthCalledWith(3, expect.any(Int32Array), 0, 0, 2000);
      // The retired subprocess-sleep path must not be exercised.
      expect(spawnSyncSpy).not.toHaveBeenCalled();
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
        "curlimages/curl:8.10.1",
        "-sf",
        "--connect-timeout",
        "2",
        "--max-time",
        "5",
        "http://host.docker.internal:11434/api/tags",
      ],
      { ignoreError: true },
    );
  });

  it("skips the blocking wait for non-positive delays", () => {
    const run = vi.fn();
    const runCapture = vi.fn();
    const { windows, restore, atomicsWaitSpy, spawnSyncSpy } = loadWindowsOllamaWithMocks(run, runCapture);

    try {
      windows.sleep(0);
      windows.sleep(-1);
      expect(atomicsWaitSpy).not.toHaveBeenCalled();
      expect(spawnSyncSpy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
