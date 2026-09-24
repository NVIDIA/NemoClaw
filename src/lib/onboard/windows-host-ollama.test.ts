// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const runCapture = vi.fn<typeof import("../runner").runCapture>(() => "");

vi.mock("../runner", () => ({
  runCapture: (
    cmd: readonly string[],
    options?: Parameters<typeof import("../runner").runCapture>[1],
  ) => runCapture(cmd, options),
}));

vi.mock("../platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform")>()),
  isWsl: vi.fn(() => true),
}));

import { isWsl, windowsProcessListensOnlyOnLoopback } from "../platform";
import { detectWindowsHostOllama } from "./windows-host-ollama";

describe("windowsProcessListensOnlyOnLoopback", () => {
  const probe = { processName: "ollama", port: 11434, timeoutMs: 5_000 };

  it("accepts only Ollama-owned IPv4 and IPv6 loopback listeners", () => {
    const capture = vi.fn(() => "127.0.0.1\r\n::1\r\n");

    expect(windowsProcessListensOnlyOnLoopback(capture, probe)).toBe(true);
    expect(capture).toHaveBeenCalledWith(
      [
        "powershell.exe",
        "-Command",
        expect.stringMatching(
          /Get-Process 'ollama'.*Get-NetTCPConnection -LocalPort 11434.*\$processPids -contains \$_\.OwningProcess/,
        ),
      ],
      { ignoreError: true, timeout: 5_000 },
    );
  });

  it.each(["0.0.0.0", "192.168.1.10", "127.0.0.1\n0.0.0.0", ""])(
    "rejects unsafe or absent Windows listener output: %j",
    (addresses) => {
      expect(windowsProcessListensOnlyOnLoopback(() => addresses, probe)).toBe(false);
    },
  );

  it.each([
    { processName: "", port: 11434, timeoutMs: 5_000 },
    { processName: "ollama", port: 0, timeoutMs: 5_000 },
    { processName: "ollama", port: 65_536, timeoutMs: 5_000 },
    { processName: "ollama", port: 1.5, timeoutMs: 5_000 },
  ])("rejects a malformed Windows listener probe: %j", (invalidProbe) => {
    const capture = vi.fn(() => "127.0.0.1");

    expect(windowsProcessListensOnlyOnLoopback(capture, invalidProbe)).toBe(false);
    expect(capture).not.toHaveBeenCalled();
  });
});

describe("detectWindowsHostOllama", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.mocked(isWsl).mockReturnValue(true);
  });

  it("detects installed-but-not-running Ollama via known install path (#4066)", () => {
    const knownPath = "C:\\Users\\tester\\AppData\\Local\\Programs\\Ollama\\ollama.exe";
    runCapture.mockImplementation((command: readonly string[]) => {
      const cmd = command.join(" ");
      if (cmd.includes("Get-Command ollama.exe")) return "";
      if (cmd.includes("Get-Process ollama") && cmd.includes("Path")) return "";
      if (cmd.includes("Get-Process ollama") && cmd.includes("Id")) return "";
      if (cmd.includes("Test-Path -LiteralPath")) return knownPath;
      if (cmd.includes("Get-NetTCPConnection")) return "";
      return "";
    });

    expect(detectWindowsHostOllama()).toEqual({
      installed: true,
      installedPath: knownPath,
      loopbackOnly: false,
    });
  });

  it("returns uninstalled when not on WSL", () => {
    vi.mocked(isWsl).mockReturnValue(false);

    expect(detectWindowsHostOllama()).toEqual({
      installed: false,
      installedPath: "",
      loopbackOnly: false,
    });
    expect(runCapture).not.toHaveBeenCalled();
  });

  it("returns absent state when Windows-host probes do not respond (#9604)", () => {
    runCapture.mockImplementation(() => "");

    expect(detectWindowsHostOllama({ isWsl: () => true, runCapture })).toEqual({
      installed: false,
      installedPath: "",
      loopbackOnly: false,
    });
    expect(runCapture).toHaveBeenCalledTimes(3);
    expect(runCapture.mock.calls.map(([, options]) => options)).toEqual([
      { ignoreError: true, timeout: 5_000 },
      { ignoreError: true, timeout: 5_000 },
      { ignoreError: true, timeout: 5_000 },
    ]);
  });

  it("continues when the Windows-host port probe does not respond (#9604)", () => {
    const installedPath = "C:\\Users\\tester\\AppData\\Local\\Programs\\Ollama\\ollama.exe";
    const outputs = [installedPath, ""];
    runCapture.mockImplementation(() => outputs.shift() ?? "");

    expect(detectWindowsHostOllama()).toEqual({
      installed: true,
      installedPath,
      loopbackOnly: false,
    });
    expect(runCapture).toHaveBeenCalledTimes(2);
    expect(runCapture.mock.calls.map(([, options]) => options)).toEqual([
      { ignoreError: true, timeout: 5_000 },
      { ignoreError: true, timeout: 5_000 },
    ]);
  });

  it("accepts only loopback listeners owned by an Ollama process", () => {
    const installedPath = "C:\\Users\\tester\\AppData\\Local\\Programs\\Ollama\\ollama.exe";
    runCapture.mockImplementation((command) => {
      const script = command.join(" ");
      return script.includes("Get-Command ollama.exe")
        ? installedPath
        : script.includes("Get-NetTCPConnection")
          ? "127.0.0.1\n::1"
          : "";
    });

    expect(detectWindowsHostOllama()).toEqual({
      installed: true,
      installedPath,
      loopbackOnly: true,
    });
    const listenerCommand = runCapture.mock.calls.find(([command]) =>
      command.join(" ").includes("Get-NetTCPConnection"),
    )?.[0];
    expect(listenerCommand).toEqual(
      expect.arrayContaining([expect.stringContaining("$processPids -contains $_.OwningProcess")]),
    );
  });

  it.each(["127.0.0.1\n192.168.1.10", "127.0.0.1\n203.0.113.10"])(
    "rejects an Ollama listener set that includes a non-loopback address: %j",
    (listenerAddresses) => {
      const installedPath = "C:\\Ollama\\ollama.exe";
      runCapture.mockImplementation((command) => {
        const script = command.join(" ");
        return script.includes("Get-Command ollama.exe")
          ? installedPath
          : script.includes("Get-NetTCPConnection")
            ? listenerAddresses
            : "";
      });

      expect(detectWindowsHostOllama().loopbackOnly).toBe(false);
    },
  );

  it("rejects a loopback listener that is not owned by an Ollama process", () => {
    const installedPath = "C:\\Ollama\\ollama.exe";
    runCapture.mockImplementation((command) => {
      const script = command.join(" ");
      return script.includes("Get-Command ollama.exe") ? installedPath : "";
    });

    expect(detectWindowsHostOllama().loopbackOnly).toBe(false);
  });
});
