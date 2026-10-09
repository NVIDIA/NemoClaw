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

function createStationFixture(
  marker: "regular-file" | "symbolic-link",
  release = STATION_RELEASE,
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-marker-"));
  fixtures.push(root);
  const device = path.join(root, "pci", "0000:01:00.0");
  fs.mkdirSync(device, { recursive: true });
  fs.writeFileSync(path.join(root, "product_name"), "NVIDIA DGX Station GB300\n");
  fs.writeFileSync(path.join(root, "product_family"), "DGX Station GB300 family\n");
  fs.writeFileSync(path.join(root, "board_name"), "NVIDIA Station GB300 board\n");
  fs.writeFileSync(path.join(root, "sys_vendor"), "NVIDIA\n");
  fs.writeFileSync(path.join(root, "possible"), "0-71\n");
  fs.writeFileSync(path.join(root, "meminfo"), "MemTotal:       761441000 kB\n");
  fs.writeFileSync(
    path.join(root, "os-release"),
    'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.4 LTS"\n',
  );
  fs.writeFileSync(path.join(device, "vendor"), "0x10de\n");
  fs.writeFileSync(path.join(device, "device"), "0x31c2\n");
  fs.writeFileSync(path.join(device, "class"), "0x030000\n");
  const target = path.join(root, "dgx-release-target");
  fs.writeFileSync(target, release);
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
      detectGpu: () => ({
        type: "nvidia",
        name: "NVIDIA GB300",
        gpus: [{ name: "NVIDIA GB300", memoryMB: 256_703 }],
        count: 1,
        totalMemoryMB: 256_703,
        perGpuMB: 256_703,
        wslDockerDesktopGpuProofPassed: false,
      }),
      detectHostGpuPlatform: () => "station",
      platformIdentityOptions: {
        productNamePath: path.join(root, "product_name"),
        productFamilyPath: path.join(root, "product_family"),
        boardNamePath: path.join(root, "board_name"),
        systemVendorPath: path.join(root, "sys_vendor"),
        cpuPossiblePath: path.join(root, "possible"),
        memInfoPath: path.join(root, "meminfo"),
        osReleasePath: path.join(root, "os-release"),
        stationReleasePath: path.join(root, "dgx-release"),
        pciDevicesPath: path.join(root, "pci"),
        statFileDescriptor: () => ({
          isFile: () => true,
          isSymbolicLink: () => false,
          size: fs.statSync(path.join(root, "dgx-release-target")).size,
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

  it.each(["NVIDIA DGX GB300WS", "NVIDIA DGX Server", "NVIDIA DGX GB300 Workstation"])(
    "reports a trusted marker as qualified without binding the %s display name (#9898, #10928)",
    (prettyName) => {
      const release = STATION_RELEASE.replace("NVIDIA DGX GB300WS", prettyName);
      const report = reportForStationHost(createStationFixture("regular-file", release));
      const findings = report.findings.map(({ id }) => id);

      expect(stationQualification(report)).toBe("qualified");
      expect(stationCapability(report)).toBe("present");
      expect(findings).not.toContain("host.platform.dgx_station_unqualified");
      expect(findings).not.toContain("host.platform.dgx_station_inconclusive");
    },
  );

  it("reports confirmed Station hardware while unrecognized software remains blocked (#10928)", () => {
    const release = STATION_RELEASE.replace("7.6.0", "7.7.0");
    const report = reportForStationHost(createStationFixture("regular-file", release));
    const findings = report.findings.map(({ id }) => id);
    const identity = report.evidence.find(({ id }) => id === "host.platform.identity");

    expect(stationQualification(report)).toBe("unqualified");
    expect(stationCapability(report)).toBe("absent");
    expect(
      report.capabilities.find(({ id }) => id === "host.platform.dgx_station_hardware")?.state,
    ).toBe("present");
    expect(
      report.capabilities.find(({ id }) => id === "host.platform.dgx_station_software")?.state,
    ).toBe("absent");
    expect(findings).toContain("host.platform.dgx_station_unqualified");
    expect(identity?.details).toMatchObject({
      stationFirmwareProduct: "NVIDIA DGX Station GB300",
      stationSystemVendor: "NVIDIA",
      stationCpuCoreCount: 72,
      stationHostMemoryBytes: 761_441_000 * 1024,
      nvidiaGpuCount: 1,
      nvidiaGpuMemoryPerDeviceBytes: 256_703 * 1024 * 1024,
      osPrettyName: "Ubuntu 24.04.4 LTS",
      stationReleaseName: "DGX GB300WS",
      stationReleasePrettyName: "NVIDIA DGX GB300WS",
      stationReleasePlatform: "DGX Server for GALAXY-GB300",
      stationSoftwareBuildVersion: "7.7.0",
      stationSoftwareBuildDate: "2026-07-14-13-59-06",
    });
  });

  it.each(["NVIDIA DGX GB300WS", "NVIDIA DGX Server"])(
    "qualifies the exact Colossus BaseOS profile with the %s display name (#10906)",
    (prettyName) => {
      const release = STATION_RELEASE.replace("NVIDIA DGX GB300WS", prettyName)
        .replace("2026-07-14-13-59-06", "2026-04-02-08-20-16")
        .replace("7.6.0", "7.5.0-GB300ws-GB200ws");
      const report = reportForStationHost(createStationFixture("regular-file", release));
      const findings = report.findings.map(({ id }) => id);

      expect(stationQualification(report)).toBe("qualified");
      expect(stationCapability(report)).toBe("present");
      expect(findings).not.toContain("host.platform.dgx_station_unqualified");
      expect(findings).not.toContain("host.platform.dgx_station_inconclusive");
    },
  );
});
