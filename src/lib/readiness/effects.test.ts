// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { assessHost } from "../onboard/preflight";
import { createHostReadinessReport } from "./host";

const NOW = new Date("2026-06-01T12:00:00Z");
const SOURCE_REVISION = "21e60ae287e8c2a184f71406ac8b418f046330d1";
const DOCKER_INFO = JSON.stringify({
  CgroupVersion: "2",
  Driver: "overlay2",
  DriverStatus: [],
  NCPU: 8,
  MemTotal: 16 * 1024 ** 3,
  OperatingSystem: "Docker Engine",
});
const COMMAND_OUTPUTS: Record<string, string> = {
  'sh -c command -v "$1" -- docker': "/usr/bin/docker",
  'sh -c command -v "$1" -- node': "/usr/bin/node",
  'sh -c command -v "$1" -- openshell': "/usr/bin/openshell",
  'sh -c command -v "$1" -- nvidia-ctk': "/usr/bin/nvidia-ctk",
  'sh -c command -v "$1" -- apt-get': "",
  'sh -c command -v "$1" -- dnf': "",
  'sh -c command -v "$1" -- yum': "",
  'sh -c command -v "$1" -- brew': "",
  'sh -c command -v "$1" -- pacman': "",
  'sh -c command -v "$1" -- systemctl': "/usr/bin/systemctl",
  "docker info --format {{json .}}": DOCKER_INFO,
  "systemctl is-active docker": "active",
  "systemctl is-enabled docker": "enabled",
};
const FILE_CONTENTS: Record<string, string> = {
  "/proc/version": "Linux version 6.8",
  "/etc/docker/daemon.json": "{}",
  "/home/rootless/.config/docker/daemon.json": "{}",
};

describe("readiness process effects (#7412)", () => {
  it("repeats the host probe without invoking a mutating dependency", () => {
    const commands: string[][] = [];
    const reads: string[] = [];
    const directories: string[] = [];
    const runCaptureImpl = vi.fn((command: readonly string[]) => {
      commands.push([...command]);
      return COMMAND_OUTPUTS[command.join(" ")] ?? "";
    });
    const readFileImpl = vi.fn((path: string) => {
      reads.push(path);
      return FILE_CONTENTS[path] ?? "";
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
    const options = {
      nemoclawVersion: "0.1.0",
      sourceRevision: SOURCE_REVISION,
      now: () => NOW,
    };
    const collectionOptions = {
      assess,
      collectPlatformIdentity: () => ({
        productName: null,
        nvidiaPlatform: null,
        stationProfile: null,
        stationGb300PciGpu: null,
      }),
      now: () => NOW,
    };

    const first = createHostReadinessReport(options, collectionOptions);
    const second = createHostReadinessReport(options, collectionOptions);

    expect(first).toEqual(second);
    expect(first.mutated).toBe(false);
    expect(assess).toHaveBeenCalledTimes(2);
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((command) => Object.hasOwn(COMMAND_OUTPUTS, command.join(" ")))).toBe(
      true,
    );
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
    const mutatingExecutables = [
      "apt",
      "apt-get",
      "dnf",
      "yum",
      "pacman",
      "brew",
      "groupadd",
      "usermod",
      "gpasswd",
      "reboot",
      "shutdown",
    ];
    expect(
      commands.every(
        ([command]) => !mutatingExecutables.includes(String(command).split("/").at(-1) ?? ""),
      ),
    ).toBe(true);
    expect(
      commands.some(([command, operation]) => command === "nvidia-ctk" && operation === "cdi"),
    ).toBe(false);
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
