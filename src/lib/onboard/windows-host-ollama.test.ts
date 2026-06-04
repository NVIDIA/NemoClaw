// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const runCapture = vi.fn<(cmd: readonly string[]) => string>(() => "");

vi.mock("../runner", () => ({
  runCapture: (cmd: readonly string[]) => runCapture(cmd),
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

  it("returns uninstalled when all Windows Ollama probes miss", () => {
    runCapture.mockImplementation(() => "");

    expect(detectWindowsHostOllama()).toEqual({
      installed: false,
      installedPath: "",
      loopbackOnly: false,
    });
  });
});
