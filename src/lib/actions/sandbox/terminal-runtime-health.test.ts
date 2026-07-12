// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  parseTerminalRuntimeOomProbeOutput,
  probeTerminalRuntimeCgroupOom,
} from "./terminal-runtime-health";

describe("parseTerminalRuntimeOomProbeOutput", () => {
  it("classifies zero cgroup OOM kills as healthy", () => {
    expect(
      parseTerminalRuntimeOomProbeOutput("oom_kill=0\nsource=/sys/fs/cgroup/memory.events.local\n"),
    ).toEqual({
      kind: "ok",
      oomKillCount: 0,
      source: "/sys/fs/cgroup/memory.events.local",
    });
  });

  it("classifies non-zero cgroup OOM kills as degraded", () => {
    expect(
      parseTerminalRuntimeOomProbeOutput("oom_kill=2\nsource=/sys/fs/cgroup/memory.events\n"),
    ).toEqual({
      kind: "degraded",
      oomKillCount: 2,
      source: "/sys/fs/cgroup/memory.events",
    });
  });

  it("returns unavailable when the probe output is missing the counter", () => {
    expect(parseTerminalRuntimeOomProbeOutput("")).toEqual({
      kind: "unavailable",
      detail: "missing oom_kill counter",
    });
  });

  it("returns unavailable when the probe output contains an invalid counter", () => {
    expect(parseTerminalRuntimeOomProbeOutput("oom_kill=bogus\n")).toEqual({
      kind: "unavailable",
      detail: "invalid oom_kill counter",
    });
  });
});

describe("probeTerminalRuntimeCgroupOom", () => {
  it("checks cgroup OOM counters through a bounded sandbox exec", () => {
    const calls: Array<{ args: readonly string[]; binary: string }> = [];
    const run = vi.fn((binary: string, args: readonly string[]) => {
      calls.push({ args, binary });
      return {
        status: 0,
        stdout: "oom_kill=1\nsource=/sys/fs/cgroup/memory.events\n",
        stderr: "",
      };
    });

    const result = probeTerminalRuntimeCgroupOom("alpha", {
      openshellBinary: "/usr/bin/openshell",
      run,
    });

    expect(result).toEqual({
      kind: "degraded",
      oomKillCount: 1,
      source: "/sys/fs/cgroup/memory.events",
    });
    expect(run).toHaveBeenCalledTimes(1);
    const firstCall = calls[0];
    expect(firstCall).toBeDefined();
    const { args, binary } = firstCall as { args: readonly string[]; binary: string };
    expect(binary).toBe("/usr/bin/openshell");
    expect(args).toEqual(
      expect.arrayContaining(["sandbox", "exec", "--name", "alpha", "--no-tty", "--timeout", "5"]),
    );
    const separator = args.indexOf("--");
    expect(args.slice(separator + 1, separator + 3)).toEqual(["sh", "-lc"]);
    expect(args[separator + 3]).toContain("/sys/fs/cgroup/memory.events");
    expect(args[separator + 3]).toContain("/sys/fs/cgroup/memory.oom_control");
    expect(args[separator + 3]).toContain("/sys/fs/cgroup/memory/memory.oom_control");
    expect(args[separator + 3]).toContain("oom_kill");
  });

  it("treats sandbox exec failures as unavailable", () => {
    const result = probeTerminalRuntimeCgroupOom("alpha", {
      openshellBinary: "/usr/bin/openshell",
      run: () => ({ status: 2, stdout: "", stderr: "no cgroup file" }),
    });

    expect(result).toEqual({ kind: "unavailable", detail: "no cgroup file" });
  });
});
