// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assessHost } from "../../src/lib/onboard/preflight";
import { createHostReadinessReport } from "../../src/lib/readiness/host";

const NOW = new Date("2026-07-30T12:00:00Z");
const SOURCE_REVISION = "a".repeat(40);
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
  'sh -c command -v "$1" -- apt-get': "/usr/bin/apt-get",
  'sh -c command -v "$1" -- dnf': "",
  'sh -c command -v "$1" -- yum': "",
  'sh -c command -v "$1" -- brew': "",
  'sh -c command -v "$1" -- pacman': "",
  'sh -c command -v "$1" -- systemctl': "/usr/bin/systemctl",
  "docker info --format {{json .}}": DOCKER_INFO,
  "systemctl is-active docker": "active",
  "systemctl is-enabled docker": "enabled",
};
const HOST_FILE_CONTENTS: Record<string, string> = {
  "/proc/version": "Linux version 6.8",
  "/etc/docker/daemon.json": "{}",
};
const STATION_RELEASE = [
  'DGX_NAME="DGX GB300WS"',
  'DGX_PRETTY_NAME="NVIDIA DGX GB300WS"',
  'DGX_SWBUILD_DATE="2026-07-14-13-59-06"',
  'DGX_SWBUILD_VERSION="7.6.0"',
  'DGX_COMMIT_ID="d0e99cc"',
  'DGX_PLATFORM="DGX Server for GALAXY-GB300"',
].join("\n");

const fixtures: string[] = [];

function createStationFixture(marker: "regular-file" | "symbolic-link"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-marker-"));
  fixtures.push(root);
  const device = path.join(root, "pci", "0000:01:00.0");
  fs.mkdirSync(device, { recursive: true });
  fs.writeFileSync(path.join(root, "product_name"), "NVIDIA DGX Station GB300\n");
  fs.writeFileSync(path.join(root, "os-release"), 'ID=ubuntu\nVERSION_ID="24.04"\n');
  fs.writeFileSync(path.join(device, "vendor"), "0x10de\n");
  fs.writeFileSync(path.join(device, "device"), "0x31c2\n");
  fs.writeFileSync(path.join(device, "class"), "0x030000\n");
  const target = path.join(root, "dgx-release-target");
  fs.writeFileSync(target, STATION_RELEASE);
  const publish = {
    "regular-file": () => fs.copyFileSync(target, path.join(root, "dgx-release")),
    "symbolic-link": () => fs.symlinkSync(target, path.join(root, "dgx-release")),
  };
  publish[marker]();
  return root;
}

function reportForStationHost(root: string) {
  return createHostReadinessReport(
    { nemoclawVersion: "0.0.0-test", sourceRevision: SOURCE_REVISION, now: () => NOW },
    {
      architecture: "arm64",
      assess: () =>
        assessHost({
          platform: "linux",
          gpuProbeImpl: () => true,
          readFileImpl: (filePath: string) => HOST_FILE_CONTENTS[String(filePath)] ?? "",
          readdirImpl: () => [],
          runCaptureImpl: (command: readonly string[]) => COMMAND_OUTPUTS[command.join(" ")] ?? "",
        }),
      detectHostGpuPlatform: () => "station",
      platformIdentityOptions: {
        productNamePath: path.join(root, "product_name"),
        osReleasePath: path.join(root, "os-release"),
        stationReleasePath: path.join(root, "dgx-release"),
        pciDevicesPath: path.join(root, "pci"),
        statFileDescriptor: () => ({
          isFile: () => true,
          isSymbolicLink: () => false,
          size: Buffer.byteLength(STATION_RELEASE),
          uid: 0,
          gid: 0,
          mode: 0o100644,
        }),
      },
      now: () => NOW,
    },
  );
}

function stationQualification(report: ReturnType<typeof createHostReadinessReport>) {
  return report.qualifications.find(({ id }) => id === "host.platform.dgx_station")?.status;
}

function stationCapability(report: ReturnType<typeof createHostReadinessReport>) {
  return report.capabilities.find(({ id }) => id === "host.platform.dgx_station")?.state;
}

afterEach(() => {
  fixtures.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

describe("DGX Station release marker readiness", () => {
  it("reports a symlinked marker as an unqualified Station", () => {
    const report = reportForStationHost(createStationFixture("symbolic-link"));
    const findings = report.findings.map(({ id }) => id);

    expect(stationQualification(report)).toBe("unqualified");
    expect(stationCapability(report)).toBe("absent");
    expect(findings).toContain("host.platform.dgx_station_unqualified");
    expect(findings).not.toContain("host.platform.dgx_station_inconclusive");
    expect(report.exitCode).toBe(2);
  });

  it("reports the same marker content in a trusted regular file as a qualified Station", () => {
    const report = reportForStationHost(createStationFixture("regular-file"));
    const findings = report.findings.map(({ id }) => id);

    expect(stationQualification(report)).toBe("qualified");
    expect(stationCapability(report)).toBe("present");
    expect(findings).not.toContain("host.platform.dgx_station_unqualified");
    expect(findings).not.toContain("host.platform.dgx_station_inconclusive");
  });
});
