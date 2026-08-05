// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMock = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("node:child_process", () => childProcessMock);

import { managedStartupSandboxPrefix } from "./managed-startup/image-runtime";

function setprivStat(
  overrides: Partial<Pick<fs.Stats, "gid" | "mode" | "uid">> & {
    file?: boolean;
    symbolicLink?: boolean;
  } = {},
): fs.Stats {
  return {
    gid: overrides.gid ?? 0,
    isFile: () => overrides.file ?? true,
    isSymbolicLink: () => overrides.symbolicLink ?? false,
    mode: overrides.mode ?? 0o755,
    uid: overrides.uid ?? 0,
  } as fs.Stats;
}

describe("managed startup sandbox identity prefix", () => {
  beforeEach(() => {
    childProcessMock.spawnSync.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the trusted setpriv path with numeric sandbox identity arguments", () => {
    vi.spyOn(fs, "lstatSync").mockReturnValue(setprivStat());
    childProcessMock.spawnSync.mockImplementation((_command, args) => ({
      status: 0,
      stdout: args[0] === "-u" ? "1000\n" : "1001\n",
    }));

    expect(managedStartupSandboxPrefix()).toEqual([
      "/usr/bin/setpriv",
      "--reuid=1000",
      "--regid=1001",
      "--init-groups",
      "--",
    ]);
    expect(childProcessMock.spawnSync.mock.calls).toEqual([
      ["/usr/bin/id", ["-u", "sandbox"], { encoding: "utf8", env: { PATH: expect.any(String) } }],
      ["/usr/bin/id", ["-g", "sandbox"], { encoding: "utf8", env: { PATH: expect.any(String) } }],
    ]);
  });

  it.each([
    ["is a symbolic link", setprivStat({ symbolicLink: true })],
    ["is not a regular file", setprivStat({ file: false })],
    ["is writable by its group", setprivStat({ mode: 0o775 })],
    ["is writable by other users", setprivStat({ mode: 0o757 })],
    ["is not executable", setprivStat({ mode: 0o644 })],
    ["is not owned by root", setprivStat({ uid: 1000 })],
    ["is not in the root group", setprivStat({ gid: 1000 })],
  ] as const)("fails before identity lookup when setpriv %s", (_label, stat) => {
    vi.spyOn(fs, "lstatSync").mockReturnValue(stat);

    expect(() => managedStartupSandboxPrefix()).toThrow("a trusted setpriv executable is required");
    expect(childProcessMock.spawnSync).not.toHaveBeenCalled();
  });

  it("fails before identity lookup when setpriv is missing", () => {
    vi.spyOn(fs, "lstatSync").mockImplementation(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    expect(() => managedStartupSandboxPrefix()).toThrow("a trusted setpriv executable is required");
    expect(childProcessMock.spawnSync).not.toHaveBeenCalled();
  });

  it.each([
    ["zero", "0\n", 0],
    ["non-numeric", "sandbox\n", 0],
    ["lookup failure", "", 1],
  ] as const)("rejects a %s sandbox identity", (_label, stdout, status) => {
    vi.spyOn(fs, "lstatSync").mockReturnValue(setprivStat());
    childProcessMock.spawnSync.mockReturnValue({ status, stdout });

    expect(() => managedStartupSandboxPrefix()).toThrow("could not resolve the sandbox account");
  });
});
