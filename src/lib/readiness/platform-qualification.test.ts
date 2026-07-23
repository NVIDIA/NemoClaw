// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { discoverStationGb300SysfsReadOnlyPaths } from "../onboard/initial-policy";
import {
  collectPlatformIdentity,
  type PlatformQualificationInput,
  projectPlatformQualification,
} from "./platform-qualification";
import { isNvidiaDisplayClassPciDevice, isStationGb300ProductName } from "./station-qualification";

function input(overrides: Partial<PlatformQualificationInput> = {}): PlatformQualificationInput {
  return {
    platform: "linux",
    architecture: "x64",
    isWsl: false,
    dockerInstalled: true,
    dockerReachable: true,
    runtime: "docker",
    hasNvidiaGpu: false,
    productName: null,
    nvidiaPlatform: null,
    stationProfile: null,
    stationGb300PciGpu: null,
    ...overrides,
  };
}

function capability(result: ReturnType<typeof projectPlatformQualification>, id: string) {
  return result.capabilities.find((entry) => entry.id === id)?.state;
}

function qualification(result: ReturnType<typeof projectPlatformQualification>, id: string) {
  return result.qualifications.find((entry) => entry.id === id)?.status;
}

function stationFixtureReadFile(path: string): string {
  const values = new Map([
    ["product_name", "NVIDIA DGX Station GB300\n"],
    ["vendor", "0x10DE\n"],
    ["device", "0xffff\n"],
    ["class", "0x030000\n"],
  ]);
  return values.get(path.split("/").at(-1) ?? "") ?? "";
}

describe("platform readiness qualification (#7410)", () => {
  it.each(["x64", "arm64"])("supports generic Linux %s by capability", (architecture) => {
    const result = projectPlatformQualification(input({ architecture }));

    expect(capability(result, "host.platform.linux_supported")).toBe("present");
    expect(capability(result, "host.platform.supported")).toBe("present");
    expect(result.qualifications).toEqual([]);
    expect(result.evidence).toEqual([]);
  });

  it.each([
    ["Docker Desktop integration", true, true, "docker-desktop", "present", "absent"],
    ["native Docker", true, true, "docker", "absent", "present"],
    ["unavailable Docker", false, false, "unknown", "absent", "absent"],
    ["inconclusive runtime", true, true, "unknown", "absent", "absent"],
  ] as const)("distinguishes WSL %s", (_scenario, dockerInstalled, dockerReachable, runtime, desktop, native) => {
    const result = projectPlatformQualification(
      input({ isWsl: true, dockerInstalled, dockerReachable, runtime }),
    );

    expect(capability(result, "host.platform.wsl_docker_desktop")).toBe(desktop);
    expect(capability(result, "host.platform.wsl_native_docker")).toBe(native);
    expect(capability(result, "host.platform.wsl_runtime_available")).toBe(
      !dockerInstalled || !dockerReachable
        ? "absent"
        : runtime === "unknown"
          ? "unknown"
          : "present",
    );
  });

  it.each([
    [true, "present"],
    [false, "absent"],
    [undefined, "unknown"],
  ] as const)("reports WSL GPU passthrough proof %s", (proofPassed, expected) => {
    const result = projectPlatformQualification(
      input({
        isWsl: true,
        runtime: "docker-desktop",
        hasNvidiaGpu: true,
        wslDockerDesktopGpuProofPassed: proofPassed,
      }),
    );

    expect(capability(result, "host.platform.wsl_gpu_passthrough")).toBe(expected);
  });

  it.each([
    ["arm64", "docker-desktop", true],
    ["arm64", "colima", true],
    ["x64", "docker-desktop", false],
    ["arm64", "docker", false],
  ] as const)("projects macOS %s with %s support as %s", (architecture, runtime, expected) => {
    const result = projectPlatformQualification(
      input({ platform: "darwin", architecture, runtime }),
    );

    expect(capability(result, "host.platform.macos_apple_silicon")).toBe(
      expected ? "present" : "absent",
    );
    expect(capability(result, "host.platform.supported")).toBe(expected ? "present" : "absent");
  });

  it("qualifies DGX Spark while retaining product identity as bounded evidence", () => {
    const result = projectPlatformQualification(
      input({
        architecture: "arm64",
        hasNvidiaGpu: true,
        nvidiaPlatform: "spark",
        productName: "NVIDIA DGX Spark",
      }),
    );

    expect(capability(result, "host.platform.dgx_spark")).toBe("present");
    expect(qualification(result, "host.platform.dgx_spark")).toBe("qualified");
    expect(result.evidence[0]?.details).toMatchObject({ product: "NVIDIA DGX Spark" });
  });

  it.each([
    ["generic-ubuntu", "qualified"],
    ["supported-dgx-os", "qualified"],
    ["supported-colossus-baseos", "qualified"],
    ["supported-ai-developer-tools", "qualified"],
    ["unsupported-dgx-os", "unqualified"],
    [null, "unknown"],
  ] as const)("projects Station profile %s as %s", (stationProfile, expected) => {
    const result = projectPlatformQualification(
      input({
        architecture: "arm64",
        hasNvidiaGpu: true,
        nvidiaPlatform: "station",
        productName: "NVIDIA DGX Station GB300",
        stationProfile,
        stationGb300PciGpu: true,
      }),
    );

    expect(qualification(result, "host.platform.dgx_station")).toBe(expected);
    expect(capability(result, "host.platform.dgx_station")).toBe(
      expected === "qualified" ? "present" : expected === "unqualified" ? "absent" : "unknown",
    );
  });

  it("uses the shared Station product qualification contract", () => {
    const productName = "Custom Station GB300 platform";
    const result = projectPlatformQualification(
      input({
        architecture: "arm64",
        hasNvidiaGpu: true,
        nvidiaPlatform: "station",
        productName,
        stationProfile: "generic-ubuntu",
        stationGb300PciGpu: true,
      }),
    );

    expect(isStationGb300ProductName(productName)).toBe(true);
    expect(qualification(result, "host.platform.dgx_station")).toBe("qualified");
  });

  it("fails closed when Station identity or hardware is unsafe", () => {
    const result = projectPlatformQualification(
      input({
        architecture: "arm64",
        hasNvidiaGpu: true,
        nvidiaPlatform: "station",
        productName: "NVIDIA DGX Station GB300",
        stationProfile: "supported-dgx-os",
        stationGb300PciGpu: false,
      }),
    );

    expect(qualification(result, "host.platform.dgx_station")).toBe("unqualified");
    expect(capability(result, "host.platform.supported")).toBe("absent");
    expect(result.findings.map(({ id }) => id)).toContain("host.platform.dgx_station_unqualified");
  });

  it("collects only bounded identity reads and never invokes host preparation", () => {
    const readFile = vi.fn(stationFixtureReadFile);
    const readdir = vi.fn(() => ["0000:01:00.0"]);
    const stat = vi.fn(() => ({ isFile: () => true, isSymbolicLink: () => false, size: 256 }));

    expect(
      collectPlatformIdentity({
        productNamePath: "/fixtures/product_name",
        stationReleasePath: "/fixtures/dgx-release",
        pciDevicesPath: "/fixtures/pci",
        readFile,
        readdir,
        stat,
      }),
    ).toEqual({
      productName: "NVIDIA DGX Station GB300",
      nvidiaPlatform: "station",
      stationProfile: "unsupported-dgx-os",
      stationGb300PciGpu: true,
    });
    expect(stat).toHaveBeenCalledWith("/fixtures/dgx-release");
    expect(readFile.mock.calls.every(([path]) => String(path).startsWith("/fixtures/"))).toBe(true);
  });

  it.each([
    "unsupported-dgx-os",
    "unknown",
  ] as const)("keeps %s Station readiness and direct-GPU preparation fail-closed", (stationProfile) => {
    const readiness = projectPlatformQualification(
      input({
        nvidiaPlatform: "station",
        productName: "NVIDIA DGX Station GB300",
        stationProfile,
        stationGb300PciGpu: true,
        hasNvidiaGpu: true,
      }),
    );

    expect(qualification(readiness, "host.platform.dgx_station")).not.toBe("qualified");
    expect(() =>
      discoverStationGb300SysfsReadOnlyPaths(
        "NVIDIA DGX Station GB300",
        "/fixtures/pci",
        stationProfile,
      ),
    ).toThrow("software profile is unsupported or unknown");
  });

  it.each([
    [["0000:01:00.0"], "one"],
    [["0000:01:00.0", "0000:02:00.0"], "multiple"],
  ] as const)("accepts %s Station NVIDIA display-class devices as preparation", (devices, _count) => {
    const readFile = vi.fn(stationFixtureReadFile);

    const identity = collectPlatformIdentity({
      productNamePath: "/fixtures/product_name",
      stationReleasePath: "/fixtures/dgx-release",
      pciDevicesPath: "/fixtures/pci",
      readFile,
      readdir: () => devices,
      stat: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 256 }),
    });

    expect(isNvidiaDisplayClassPciDevice("0x10DE", "0x030000")).toBe(true);
    expect(identity.stationGb300PciGpu).toBe(true);
    expect(
      qualification(
        projectPlatformQualification(
          input({
            architecture: "arm64",
            hasNvidiaGpu: true,
            ...identity,
            stationProfile: "generic-ubuntu",
          }),
        ),
        "host.platform.dgx_station",
      ),
    ).toBe("qualified");
    expect(readFile).not.toHaveBeenCalledWith(expect.stringContaining("/device"));
  });

  it("bounds firmware identity before publishing it", () => {
    const identity = collectPlatformIdentity({
      productNamePath: "/fixtures/product_name",
      readFile: () => "NVIDIA DGX Spark".padEnd(5000, "x"),
    });

    expect(identity).toEqual({ nvidiaPlatform: undefined, productName: undefined });
  });
});
