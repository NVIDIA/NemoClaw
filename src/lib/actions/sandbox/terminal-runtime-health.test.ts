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
  const dockerSandbox = {
    getSandboxDriver: () => "docker",
    listLabeledContainerNames: () => ["openshell-alpha"],
    listSandboxNames: () => ["alpha"],
  };

  it("reads cgroup OOM counters from the host rather than inside the sandbox (#5796)", () => {
    const calls: Array<readonly string[]> = [];
    const run = vi.fn((args: readonly string[]) => {
      calls.push(args);
      return {
        status: 0,
        stdout: "oom_kill=1\nsource=/sys/fs/cgroup/memory.events\n",
        stderr: "",
      };
    });

    const result = probeTerminalRuntimeCgroupOom("alpha", { ...dockerSandbox, run });

    expect(result).toEqual({
      kind: "degraded",
      oomKillCount: 1,
      source: "/sys/fs/cgroup/memory.events",
    });
    expect(run).toHaveBeenCalledTimes(1);
    const args = calls[0] ?? [];
    // The sandbox exec transport runs the probe under the sandbox policy, which
    // denies /sys/fs/cgroup and hid every real OOM behind unavailable.
    expect(args.slice(0, 4)).toEqual(["exec", "openshell-alpha", "sh", "-lc"]);
    expect(args[4]).toContain("/sys/fs/cgroup/memory.events");
    expect(args[4]).toContain("/sys/fs/cgroup/memory.oom_control");
    expect(args[4]).toContain("/sys/fs/cgroup/memory/memory.oom_control");
    expect(args[4]).toContain("oom_kill");
  });

  it("reports a surviving-supervisor OOM as degraded so status can escalate", () => {
    expect(
      probeTerminalRuntimeCgroupOom("alpha", {
        ...dockerSandbox,
        run: () => ({ status: 0, stdout: "oom_kill=1\nsource=/sys/fs/cgroup/memory.events\n" }),
      }),
    ).toEqual({ kind: "degraded", oomKillCount: 1, source: "/sys/fs/cgroup/memory.events" });
  });

  it("treats container exec failures as unavailable", () => {
    const result = probeTerminalRuntimeCgroupOom("alpha", {
      ...dockerSandbox,
      run: () => ({ status: 2, stdout: "", stderr: "no cgroup file" }),
    });

    expect(result).toEqual({ kind: "unavailable", detail: "no cgroup file" });
  });

  it("returns unavailable for a sandbox that is not on the docker driver", () => {
    const run = vi.fn(() => ({ status: 0, stdout: "oom_kill=1\n" }));

    expect(
      probeTerminalRuntimeCgroupOom("alpha", {
        ...dockerSandbox,
        getSandboxDriver: () => "podman",
        run,
      }),
    ).toEqual({ kind: "unavailable", detail: "cgroup OOM probe requires the docker driver" });
    expect(run).not.toHaveBeenCalled();
  });

  it("returns unavailable when no labeled container is found", () => {
    expect(
      probeTerminalRuntimeCgroupOom("alpha", {
        ...dockerSandbox,
        listLabeledContainerNames: () => [],
        run: () => ({ status: 0, stdout: "oom_kill=1\n" }),
      }),
    ).toEqual({ kind: "unavailable", detail: "no labeled container found for sandbox" });
  });

  it("refuses to read a counter when sandbox container ownership is ambiguous", () => {
    const run = vi.fn(() => ({ status: 0, stdout: "oom_kill=1\n" }));

    expect(
      probeTerminalRuntimeCgroupOom("alpha", {
        ...dockerSandbox,
        listLabeledContainerNames: () => ["openshell-alpha", "openshell-alpha-2"],
        run,
      }),
    ).toEqual({ kind: "unavailable", detail: "ambiguous sandbox container ownership" });
    expect(run).not.toHaveBeenCalled();
  });

  it("returns unavailable when the labeled container belongs to a longer-named sandbox", () => {
    expect(
      probeTerminalRuntimeCgroupOom("alpha", {
        ...dockerSandbox,
        listLabeledContainerNames: () => ["openshell-alpha-prod"],
        listSandboxNames: () => ["alpha", "alpha-prod"],
        run: () => ({ status: 0, stdout: "oom_kill=1\n" }),
      }),
    ).toEqual({ kind: "unavailable", detail: "sandbox container owner unresolved" });
  });

  it("returns unavailable when sandbox ownership registry lookup fails", () => {
    const run = vi.fn(() => ({ status: 0, stdout: "oom_kill=1\n" }));

    expect(
      probeTerminalRuntimeCgroupOom("alpha", {
        ...dockerSandbox,
        listSandboxNames: () => undefined,
        run,
      }),
    ).toEqual({ kind: "unavailable", detail: "sandbox ownership registry unavailable" });
    expect(run).not.toHaveBeenCalled();
  });
});
