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

vi.mock("../platform", () => ({
  isWsl: vi.fn(() => true),
}));

import { isWsl } from "../platform";
import { detectWindowsHostOllama } from "./windows-host-ollama";

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
    const outputs = [installedPath, "42", ""];
    runCapture.mockImplementation(() => outputs.shift() ?? "");

    expect(detectWindowsHostOllama()).toEqual({
      installed: true,
      installedPath,
      loopbackOnly: false,
    });
    expect(runCapture).toHaveBeenCalledTimes(3);
    expect(runCapture.mock.calls.map(([, options]) => options)).toEqual([
      { ignoreError: true, timeout: 5_000 },
      { ignoreError: true, timeout: 5_000 },
      { ignoreError: true, timeout: 5_000 },
    ]);
  });
});
