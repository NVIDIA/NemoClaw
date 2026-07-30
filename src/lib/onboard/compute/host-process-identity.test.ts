// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { captureLinuxHostProcessIdentity } from "./host-process-identity";

function linuxStat(pid: number, name: string, startTicks: string): string {
  return `${String(pid)} (${name}) ${["S", ...Array(18).fill("0"), startTicks].join(" ")}`;
}

describe("host process identity", () => {
  it("binds argv to matching process-start samples across the read boundary", () => {
    const readFile = vi
      .fn()
      .mockReturnValueOnce(linuxStat(41, "openshell gateway) worker", "9001"))
      .mockReturnValueOnce(Buffer.from("/usr/bin/openshell-gateway\0serve\0"))
      .mockReturnValueOnce(linuxStat(41, "openshell gateway) worker", "9001"));

    expect(captureLinuxHostProcessIdentity(41, { readFile })).toEqual({
      argv: ["/usr/bin/openshell-gateway", "serve"],
      startIdentity: "linux-proc-start:9001",
    });
    expect(readFile.mock.calls.map(([filePath]) => filePath)).toEqual([
      "/proc/41/stat",
      "/proc/41/cmdline",
      "/proc/41/stat",
    ]);
  });

  it("rejects argv captured across PID reuse", () => {
    const readFile = vi
      .fn()
      .mockReturnValueOnce(linuxStat(41, "old", "9001"))
      .mockReturnValueOnce(Buffer.from("/usr/bin/foreign\0"))
      .mockReturnValueOnce(linuxStat(41, "new", "9002"));

    expect(captureLinuxHostProcessIdentity(41, { readFile })).toBeNull();
  });

  it("treats a process that disappears before capture as inactive", () => {
    const readFile = vi.fn(() => {
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    });

    expect(captureLinuxHostProcessIdentity(41, { readFile })).toBeNull();
  });
});
