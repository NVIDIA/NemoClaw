// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captureSandboxSshConfig = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn() };
});

vi.mock("../../adapters/openshell/runtime", () => ({
  captureOpenshell: vi.fn(),
  captureOpenshellForStatus: vi.fn(),
  captureSandboxSshConfig,
  getOpenshellBinary: vi.fn(() => "openshell"),
  isCommandTimeout: vi.fn(() => false),
  runOpenshell: vi.fn(),
}));

vi.mock("../../runner", () => ({
  ROOT: "/repo",
  shellQuote: (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`,
}));

import { executeSandboxCommand } from "./process-recovery";

describe("executeSandboxCommand temp SSH config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses an mkdtemp-backed SSH config file and removes the temp directory", () => {
    captureSandboxSshConfig.mockReturnValue({
      status: 0,
      output: "Host openshell-alpha\n  HostName 127.0.0.1\n",
    });
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "ok\n",
      stderr: "",
      pid: 1234,
      output: [],
      signal: null,
    });

    const result = executeSandboxCommand("alpha", "echo ok");

    expect(result).toEqual({ status: 0, stdout: "ok", stderr: "" });
    const sshArgs = vi.mocked(spawnSync).mock.calls[0]?.[1] as string[];
    const configFile = sshArgs[sshArgs.indexOf("-F") + 1];
    const configDir = path.dirname(configFile);
    expect(configDir).not.toBe(os.tmpdir());
    expect(path.basename(configDir)).toMatch(/^nemoclaw-ssh-/);
    expect(path.basename(configFile)).toBe("ssh_config");
    expect(fs.existsSync(configDir)).toBe(false);
  });

  it("returns null without creating an SSH process when config capture fails", () => {
    captureSandboxSshConfig.mockReturnValue({ status: 1, output: "" });

    expect(executeSandboxCommand("alpha", "echo ok")).toBeNull();
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
