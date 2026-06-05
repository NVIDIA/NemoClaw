// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const WINDOWS_DIST_PATH = require.resolve("../../../../dist/lib/inference/ollama/windows");
const RUNNER_PATH = require.resolve("../../../../dist/lib/runner");
const childProcess = require("node:child_process");

function commandText(command: string | string[]): string {
  return Array.isArray(command) ? command.join(" ") : String(command);
}

function loadWindowsOllamaWithMocks(run: ReturnType<typeof vi.fn>, runCapture: ReturnType<typeof vi.fn>) {
  const runner = require(RUNNER_PATH);
  const originalRun = runner.run;
  const originalRunCapture = runner.runCapture;
  const originalSpawnSync = childProcess.spawnSync;

  delete require.cache[WINDOWS_DIST_PATH];
  runner.run = run;
  runner.runCapture = runCapture;
  childProcess.spawnSync = vi.fn(() => ({ status: 0 }));

  return {
    windows: require(WINDOWS_DIST_PATH),
    restore() {
      delete require.cache[WINDOWS_DIST_PATH];
      runner.run = originalRun;
      runner.runCapture = originalRunCapture;
      childProcess.spawnSync = originalSpawnSync;
    },
  };
}

describe("Windows Ollama helper", () => {
  it("falls back from a stale watcher path to the verified installed executable", () => {
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
      if (cmd.includes("host.docker.internal:11434/api/tags")) {
        return launchScripts.some((script) => script.includes(installedPath))
          ? JSON.stringify({ models: [] })
          : "";
      }
      return "";
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { windows, restore } = loadWindowsOllamaWithMocks(run, runCapture);

    try {
      expect(windows.setupWindowsOllamaWith0000Binding({ installedPath })).toBe(true);
    } finally {
      restore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(run).toHaveBeenCalledTimes(2);
    expect(launchScripts[0]).toContain(watcherPath);
    expect(launchScripts[1]).toContain(installedPath);
    expect(launchScripts[1]).toContain("-ArgumentList 'serve'");
    expect(launchScripts.some((script) => script.includes("Start-Process -FilePath ollama.exe"))).toBe(
      false,
    );
    expect(stopCommands[0]).toContain("Get-Process 'ollama app'");
    expect(stopCommands[1]).toContain("Get-Process ollama");
  });
});
