// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncOptions } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import { buildCheckSpawnInvocation, runChecks } from "../scripts/checks/run.mts";

const sampleCheck = {
  name: "sample",
  command: "tsx.cmd",
  args: ["scripts/checks/sample.mts"],
};

function successfulSpawn(): { status: number | null } {
  return { status: 0 };
}

describe("checks runner", () => {
  it("runs Windows command shims through cmd.exe", () => {
    expect(
      buildCheckSpawnInvocation(sampleCheck, "win32", {
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "tsx.cmd", "scripts/checks/sample.mts"],
    });
  });

  it("uses cmd.exe when ComSpec is unavailable on Windows", () => {
    expect(buildCheckSpawnInvocation(sampleCheck, "win32", {})).toMatchObject({
      command: "cmd.exe",
    });
  });

  it("keeps POSIX runner execution direct", () => {
    expect(buildCheckSpawnInvocation(sampleCheck, "linux")).toEqual({
      command: "tsx.cmd",
      args: ["scripts/checks/sample.mts"],
    });
  });

  it("uses the Windows shim invocation when running checks", () => {
    const calls: SpawnSyncOptions[] = [];
    const spawn = vi.fn((_command: string, _args: string[], options: SpawnSyncOptions) => {
      calls.push(options);
      return successfulSpawn();
    });

    runChecks({
      checks: [sampleCheck],
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      spawn,
    });

    expect(spawn).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/s", "/c", "tsx.cmd", "scripts/checks/sample.mts"],
      expect.objectContaining({ stdio: "inherit" }),
    );
    expect(calls[0]?.shell).toBeUndefined();
  });

  it("uses direct execution when running checks on POSIX", () => {
    const spawn = vi.fn((_command: string, _args: string[], _options: SpawnSyncOptions) =>
      successfulSpawn(),
    );

    runChecks({ checks: [sampleCheck], platform: "linux", spawn });

    expect(spawn).toHaveBeenCalledWith(
      "tsx.cmd",
      ["scripts/checks/sample.mts"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("exits with one when a check has no status", () => {
    const spawn = vi.fn((_command: string, _args: string[], _options: SpawnSyncOptions) => ({
      status: null,
      error: new Error("spawn failed"),
    }));
    const exit = vi.fn((code?: number): never => {
      throw new Error(`exit ${code}`);
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => runChecks({ checks: [sampleCheck], platform: "linux", spawn, exit })).toThrow(
      "exit 1",
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith("Check failed: sample");
    expect(error).toHaveBeenCalledWith("spawn failed");
    error.mockRestore();
  });

  it("exits with the check status code on failure", () => {
    const spawn = vi.fn((_command: string, _args: string[], _options: SpawnSyncOptions) => ({
      status: 2,
    }));
    const exit = vi.fn((code?: number): never => {
      throw new Error(`exit ${code}`);
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => runChecks({ checks: [sampleCheck], platform: "linux", spawn, exit })).toThrow(
      "exit 2",
    );
    expect(exit).toHaveBeenCalledWith(2);
    expect(error).toHaveBeenCalledWith("Check failed: sample");
    expect(error).not.toHaveBeenCalledWith("spawn failed");
    error.mockRestore();
  });
});
