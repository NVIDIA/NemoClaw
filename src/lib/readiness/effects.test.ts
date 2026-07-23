// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { assessHost } from "../onboard/preflight";
import { describe, expect, it, vi } from "vitest";
import { createHostReadinessReport } from "./host";

const NOW = new Date("2026-06-01T12:00:00Z");
const DOCKER_INFO = JSON.stringify({
  CgroupVersion: "2",
  Driver: "overlay2",
  DriverStatus: [],
  NCPU: 8,
  MemTotal: 16 * 1024 ** 3,
  OperatingSystem: "Docker Engine",
});

describe("readiness process effects (#7412)", () => {
  it("repeats the host probe without invoking a mutating dependency", () => {
    const commands: string[][] = [];
    const reads: string[] = [];
    const directories: string[] = [];
    const runCaptureImpl = vi.fn((command: readonly string[]) => {
      commands.push([...command]);
      if (command[0] === "sh" && command[4]) return `/usr/bin/${command[4]}`;
      if (command[0] === "docker") return DOCKER_INFO;
      if (command[0] === "systemctl") return command[1] === "is-active" ? "active" : "enabled";
      return "";
    });
    const readFileImpl = vi.fn((path: string) => {
      reads.push(path);
      return path === "/proc/version" ? "Linux version 6.8" : "{}";
    });
    const readdirImpl = vi.fn((path: string) => {
      directories.push(path);
      return [];
    });
    const assess = vi.fn(() =>
      assessHost({
        gpuProbeImpl: () => false,
        platform: "linux",
        readFileImpl,
        readdirImpl,
        runCaptureImpl,
      }),
    );
    const options = { nemoclawVersion: "0.1.0", now: () => NOW };
    const collectionOptions = { assess, now: () => NOW };

    const first = createHostReadinessReport(options, collectionOptions);
    const second = createHostReadinessReport(options, collectionOptions);

    expect(first).toEqual(second);
    expect(first.mutated).toBe(false);
    expect(assess).toHaveBeenCalledTimes(2);
    expect(commands.length).toBeGreaterThan(0);
    expect(
      commands.every(([command]) => ["sh", "docker", "systemctl"].includes(command ?? "")),
    ).toBe(true);
    expect(
      commands
        .filter(([command]) => command === "systemctl")
        .every(([, operation]) => operation === "is-active" || operation === "is-enabled"),
    ).toBe(true);
    expect(
      commands
        .filter(([command]) => command === "docker")
        .every(([, operation]) => operation === "info"),
    ).toBe(true);
    expect(
      reads.every((path) =>
        [
          "/proc/version",
          "/etc/docker/daemon.json",
          "/home/rootless/.config/docker/daemon.json",
        ].includes(path),
      ),
    ).toBe(true);
    expect(directories.every((path) => path === "/etc/cdi" || path === "/var/run/cdi")).toBe(true);
  });
});
