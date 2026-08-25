// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { discoverStationGb300SysfsReadOnlyPaths } from "../onboard/initial-policy";
import {
  collectPlatformIdentity,
  type PlatformQualificationInput,
  projectPlatformQualification,
} from "./platform-qualification";
import {
  isStationGb300PciDevice,
  isStationGb300ProductName,
  STATION_RELEASE_MARKER_MAX_BYTES,
} from "./station-qualification";

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
    osId: "ubuntu",
    osVersionId: "24.04",
    ...overrides,
  };
}

function capability(result: ReturnType<typeof projectPlatformQualification>, id: string) {
  return result.capabilities.find((entry) => entry.id === id)?.state;
}

function qualification(result: ReturnType<typeof projectPlatformQualification>, id: string) {
  return result.qualifications.find((entry) => entry.id === id)?.status;
}

function unexpectedFixturePath(filePath: string): never {
  throw new Error(`unexpected path: ${filePath}`);
}

function stationFixtureReadFile(path: string): string {
  const values = new Map([
    ["product_name", "NVIDIA DGX Station GB300\n"],
    ["os-release", 'ID=ubuntu\nVERSION_ID="24.04"\n'],
    ["vendor", "0x10DE\n"],
    ["device", "0x31c2\n"],
    ["class", "0x030000\n"],
  ]);
  return values.get(path.split("/").at(-1) ?? "") ?? "";
}

function noOtaStationRelease(
  overrides: Partial<{
    prettyName: string;
    version: string;
    buildDate: string;
    otaMetadata: string;
  }> = {},
): string {
  const fields = {
    prettyName: "NVIDIA DGX GB300WS",
    version: "7.6.0",
    buildDate: "2026-07-14-13-59-06",
    otaMetadata: "",
    ...overrides,
  };
  return [
    'DGX_NAME="DGX GB300WS"',
    `DGX_PRETTY_NAME="${fields.prettyName}"`,
    `DGX_SWBUILD_DATE="${fields.buildDate}"`,
    `DGX_SWBUILD_VERSION="${fields.version}"`,
    'DGX_COMMIT_ID="d0e99cc"',
    fields.otaMetadata,
    'DGX_PLATFORM="DGX Server for GALAXY-GB300"',
  ]
    .filter(Boolean)
    .join("\n");
}

function nonGb300StationFixtureReadFile(path: string): string {
  const values = new Map([
    ["dgx-release", noOtaStationRelease()],
    ["device", "0xffff\n"],
  ]);
  return values.get(path.split("/").at(-1) ?? "") ?? stationFixtureReadFile(path);
}

function trustedMarkerStat(
  overrides: Partial<{ uid: number; gid: number; mode: number; size: number }> = {},
) {
  return {
    isFile: () => true,
    isSymbolicLink: () => false,
    size: 256,
    uid: 0,
    gid: 0,
    mode: 0o100644,
    ...overrides,
  };
}

function collectStationIdentity(release: string, markerStat = trustedMarkerStat()) {
  return collectPlatformIdentity({
    productNamePath: "/fixtures/product_name",
    osReleasePath: "/fixtures/os-release",
    stationReleasePath: "/fixtures/dgx-release",
    pciDevicesPath: "/fixtures/pci",
    readFile: (filePath) =>
      filePath.endsWith("dgx-release") ? "" : stationFixtureReadFile(filePath),
    readdir: () => ["0000:01:00.0"],
    openFile: () => 17,
    statFileDescriptor: () => markerStat,
    readFileDescriptor: () => release,
    closeFileDescriptor: () => undefined,
  });
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

  it("blocks an unsupported Intel macOS platform combination", () => {
    const result = projectPlatformQualification(
      input({ platform: "darwin", architecture: "x64", runtime: "docker-desktop" }),
    );

    expect(capability(result, "host.platform.supported")).toBe("absent");
    expect(result.findings).toContainEqual(
      expect.objectContaining({ id: "host.platform.unsupported", severity: "blocking" }),
    );
  });

  it.each([
    ["native Docker", "docker", "host.platform.wsl_native_docker_unqualified"],
    ["an inconclusive runtime", "unknown", "host.platform.wsl_runtime_inconclusive"],
  ] as const)("blocks WSL with %s using its specific finding", (_scenario, runtime, findingId) => {
    const result = projectPlatformQualification(input({ isWsl: true, runtime }));

    expect(capability(result, "host.platform.supported")).toBe("absent");
    expect(result.findings).toContainEqual(
      expect.objectContaining({ id: findingId, severity: "blocking" }),
    );
    expect(result.findings.some(({ id }) => id === "host.platform.unsupported")).toBe(false);
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
    ["wrong architecture", { architecture: "x64" }],
    ["unavailable GPU", { hasNvidiaGpu: false }],
  ] as const)("keeps DGX Spark unqualified with %s", (_scenario, overrides) => {
    const result = projectPlatformQualification(
      input({
        architecture: "arm64",
        hasNvidiaGpu: true,
        nvidiaPlatform: "spark",
        productName: "NVIDIA DGX Spark",
        ...overrides,
      }),
    );

    expect(capability(result, "host.platform.dgx_spark")).toBe("absent");
    expect(qualification(result, "host.platform.dgx_spark")).toBe("unqualified");
    expect(result.findings.map(({ id }) => id)).toContain("host.platform.dgx_spark_unqualified");
  });

  it("collects and qualifies the accepted N1x identity boundary (#8574)", () => {
    const identityFiles: Readonly<Record<string, string>> = {
      product_name: "SKU 1\n",
      vendor: "0x10de\n",
      device: "0x2e2a\n",
      class: "0x030000\n",
    };
    const identity = collectPlatformIdentity({
      productNamePath: "/fixtures/product_name",
      fastOsReleasePath: "/fixtures/fastos-release",
      pciDevicesPath: "/fixtures/pci",
      readFile: (filePath) => {
        const field = filePath.split("/").at(-1) ?? "";
        return identityFiles[field] ?? unexpectedFixturePath(filePath);
      },
      readdir: () => ["000f:01:00.0"],
      openFile: () => 19,
      statFileDescriptor: () => trustedMarkerStat({ size: 116 }),
      readFileDescriptor: () => 'NAME="N1x FASTOS"\nVERSION="1.23.0"\n',
      closeFileDescriptor: () => undefined,
    });
    const result = projectPlatformQualification(
      input({ architecture: "arm64", hasNvidiaGpu: true, ...identity }),
    );

    expect(identity).toEqual({
      nvidiaPlatform: "n1x",
      productName: "SKU 1",
      n1xCandidate: true,
      n1xFastOsMarker: true,
      n1xPciGpu: true,
    });
    expect(capability(result, "host.platform.n1x")).toBe("present");
    expect(capability(result, "host.platform.supported")).toBe("absent");
    expect(qualification(result, "host.platform.n1x")).toBe("qualified");
    expect(result.findings.map(({ id }) => id)).toContain("host.platform.n1x_validation_pending");
    expect(result.evidence[0]?.details).toMatchObject({
      product: "SKU 1",
      nvidiaPlatform: "n1x",
      n1xCandidate: true,
      n1xFastOsMarker: true,
      n1xPciGpu: true,
    });
  });

  it.each([
    ["wrong operating system", { platform: "darwin" }],
    ["wrong architecture", { architecture: "x64" }],
    ["unavailable GPU", { hasNvidiaGpu: false }],
    ["wrong PCI device", { nvidiaPlatform: null, n1xPciGpu: false }],
  ] as const)("keeps N1x unqualified with %s (#8574)", (_scenario, overrides) => {
    const result = projectPlatformQualification(
      input({
        architecture: "arm64",
        hasNvidiaGpu: true,
        nvidiaPlatform: "n1x",
        productName: "SKU 1",
        n1xFastOsMarker: true,
        n1xPciGpu: true,
        ...overrides,
      }),
    );

    expect(capability(result, "host.platform.n1x")).toBe("absent");
    expect(capability(result, "host.platform.supported")).toBe("absent");
    expect(qualification(result, "host.platform.n1x")).toBe("unqualified");
    expect(result.findings.map(({ id }) => id)).toContain("host.platform.n1x_unqualified");
  });

  it("keeps N1x qualification inconclusive when PCI identity cannot be read (#8574)", () => {
    const result = projectPlatformQualification(
      input({
        architecture: "arm64",
        hasNvidiaGpu: true,
        nvidiaPlatform: null,
        productName: "SKU 1",
        n1xFastOsMarker: true,
        n1xPciGpu: undefined,
      }),
    );

    expect(capability(result, "host.platform.n1x")).toBe("unknown");
    expect(qualification(result, "host.platform.n1x")).toBe("unknown");
    expect(result.findings.map(({ id }) => id)).toContain("host.platform.n1x_inconclusive");
  });

  it.each([
    ["untrusted", false, "unqualified", "absent", "host.platform.n1x_unqualified"],
    ["unreadable", undefined, "unknown", "unknown", "host.platform.n1x_inconclusive"],
  ] as const)("fails closed for an %s N1x FastOS marker (#8574)", (_scenario, n1xFastOsMarker, expectedStatus, expectedCapability, expectedFinding) => {
    const result = projectPlatformQualification(
      input({
        architecture: "arm64",
        hasNvidiaGpu: true,
        n1xCandidate: true,
        n1xFastOsMarker,
        n1xPciGpu: undefined,
      }),
    );

    expect(capability(result, "host.platform.n1x")).toBe(expectedCapability);
    expect(capability(result, "host.platform.supported")).toBe("absent");
    expect(qualification(result, "host.platform.n1x")).toBe(expectedStatus);
    expect(result.findings.map(({ id }) => id)).toContain(expectedFinding);
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

  it.each([
    ["wrong platform", { platform: "darwin" }],
    ["wrong architecture", { architecture: "x64" }],
    ["wrong distribution", { osId: "debian" }],
    ["wrong Ubuntu release", { osVersionId: "22.04" }],
    ["unavailable GPU", { hasNvidiaGpu: false }],
  ] as const)("keeps Station unqualified with %s", (_scenario, overrides) => {
    const result = projectPlatformQualification(
      input({
        architecture: "arm64",
        hasNvidiaGpu: true,
        nvidiaPlatform: "station",
        productName: "NVIDIA DGX Station GB300",
        stationProfile: "supported-dgx-os",
        stationGb300PciGpu: true,
        ...overrides,
      }),
    );

    expect(qualification(result, "host.platform.dgx_station")).toBe("unqualified");
    expect(capability(result, "host.platform.dgx_station")).toBe("absent");
    expect(result.findings.map(({ id }) => id)).toContain("host.platform.dgx_station_unqualified");
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

  it("marks Station unqualified when no exact GB300 PCI device is present", () => {
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

  it.each([
    [
      "unreadable vendor",
      "vendor",
      () => {
        throw Object.assign(new Error("unreadable PCI identity"), { code: "EIO" });
      },
    ],
    ["oversized device", "device", () => "0x31c2".padEnd(5000, "0")],
    [
      "unreadable class",
      "class",
      () => {
        throw Object.assign(new Error("unreadable PCI identity"), { code: "EIO" });
      },
    ],
  ] as const)("keeps Station qualification inconclusive with %s evidence", (_scenario, field, readFault) => {
    const pciFaults = new Map([[`/fixtures/pci/0000:01:00.0/${field}`, readFault]]);
    const identity = collectPlatformIdentity({
      productNamePath: "/fixtures/product_name",
      osReleasePath: "/fixtures/os-release",
      stationReleasePath: "/fixtures/dgx-release",
      pciDevicesPath: "/fixtures/pci",
      readFile: (filePath) => pciFaults.get(filePath)?.() ?? stationFixtureReadFile(filePath),
      readdir: () => ["0000:01:00.0"],
      openFile: () => 17,
      statFileDescriptor: () => trustedMarkerStat(),
      readFileDescriptor: () => noOtaStationRelease(),
      closeFileDescriptor: () => undefined,
    });
    const result = projectPlatformQualification(
      input({
        architecture: "arm64",
        hasNvidiaGpu: true,
        ...identity,
      }),
    );

    expect(identity.stationGb300PciGpu).toBeUndefined();
    expect(qualification(result, "host.platform.dgx_station")).toBe("unknown");
    expect(capability(result, "host.platform.dgx_station")).toBe("unknown");
    expect(result.findings.map(({ id }) => id)).toContain("host.platform.dgx_station_inconclusive");
  });

  it("keeps a truncated PCI scan inconclusive when a matching device may be outside the bound", () => {
    const entries = [
      ...Array.from({ length: 256 }, (_, index) => `device-${index}`),
      "gb300-device",
    ];
    const identity = collectPlatformIdentity({
      productNamePath: "/fixtures/product_name",
      osReleasePath: "/fixtures/os-release",
      stationReleasePath: "/fixtures/dgx-release",
      pciDevicesPath: "/fixtures/pci",
      readFile: (filePath) =>
        filePath.includes("gb300-device")
          ? stationFixtureReadFile(filePath)
          : nonGb300StationFixtureReadFile(filePath),
      readdir: () => entries,
      openFile: () => 17,
      statFileDescriptor: () => trustedMarkerStat(),
      readFileDescriptor: () => noOtaStationRelease(),
      closeFileDescriptor: () => undefined,
    });
    const result = projectPlatformQualification(
      input({
        architecture: "arm64",
        hasNvidiaGpu: true,
        ...identity,
      }),
    );

    expect(identity.stationGb300PciGpu).toBeUndefined();
    expect(qualification(result, "host.platform.dgx_station")).toBe("unknown");
    expect(result.findings.map(({ id }) => id)).toContain("host.platform.dgx_station_inconclusive");
  });

  it.each([
    ["7.6.0", "NVIDIA DGX GB300WS"],
    ["7.6.0", "NVIDIA DGX Server"],
    ["7.6.1", "NVIDIA DGX GB300WS"],
    ["7.6.1", "NVIDIA DGX Server"],
  ])(
    "accepts no-OTA DGX OS %s with the %s display name without binding its build date (#9898)",
    (version, prettyName) => {
      expect(
        collectStationIdentity(
          noOtaStationRelease({
            version,
            prettyName,
            buildDate: "2099-01-02-03-04-05",
          }),
        ),
      ).toMatchObject({
        stationProfile: "supported-dgx-os",
        stationGb300PciGpu: true,
      });
    },
  );

  it("classifies the exact GB300WS 7.5.0 build 2026-05-13-18-42-38 as supported-ai-developer-tools (#7979)", () => {
    expect(
      collectStationIdentity(
        noOtaStationRelease({ version: "7.5.0", buildDate: "2026-05-13-18-42-38" }),
      ),
    ).toMatchObject({
      stationProfile: "supported-ai-developer-tools",
      stationGb300PciGpu: true,
    });
  });

  it.each([
    ["different lineage", { prettyName: "Unrecognized DGX Station" }],
    ["older no-OTA version", { version: "7.5.0" }],
    ["future release family", { version: "7.7.0" }],
    ["non-numeric patch", { version: "7.6.rc1" }],
    ["partial OTA identity", { otaMetadata: 'DGX_OTA_PRETTY_NAME="DGX OS"' }],
  ] as const)("keeps no-OTA Station metadata fail-closed with %s", (_scenario, overrides) => {
    expect(collectStationIdentity(noOtaStationRelease(overrides))).toMatchObject({
      stationProfile: "unsupported-dgx-os",
      stationGb300PciGpu: true,
    });
  });

  it.each([
    ["non-root owner", { uid: 1000 }],
    ["non-root group", { gid: 1000 }],
    ["group-writable marker", { mode: 0o100664 }],
    ["world-writable marker", { mode: 0o100646 }],
  ] as const)("rejects a %s before trusting Station release metadata", (_scenario, overrides) => {
    expect(
      collectStationIdentity(noOtaStationRelease(), trustedMarkerStat(overrides)),
    ).toMatchObject({
      stationProfile: "unsupported-dgx-os",
    });
  });

  it("classifies an oversized DGX Station release marker as unqualified (#7877)", () => {
    const identity = collectStationIdentity(
      noOtaStationRelease(),
      trustedMarkerStat({ size: STATION_RELEASE_MARKER_MAX_BYTES + 1 }),
    );
    const result = projectPlatformQualification(
      input({
        architecture: "arm64",
        hasNvidiaGpu: true,
        ...identity,
      }),
    );

    expect(identity.stationProfile).toBe("unsupported-dgx-os");
    expect(qualification(result, "host.platform.dgx_station")).toBe("unqualified");
    expect(result.findings.map(({ id }) => id)).toContain("host.platform.dgx_station_unqualified");
  });

  it.each([
    ["a symbolic link", "ELOOP"],
    ["a symbolic link rejected as a link count", "EMLINK"],
  ] as const)("rejects %s Station marker as an unsupported release", (_scenario, code) => {
    expect(
      collectPlatformIdentity({
        productNamePath: "/fixtures/product_name",
        osReleasePath: "/fixtures/os-release",
        stationReleasePath: "/fixtures/dgx-release",
        pciDevicesPath: "/fixtures/pci",
        readFile: stationFixtureReadFile,
        readdir: () => ["0000:01:00.0"],
        openFile: () => {
          throw Object.assign(new Error("marker is a symbolic link"), { code });
        },
        statFileDescriptor: () => trustedMarkerStat(),
        readFileDescriptor: () => noOtaStationRelease(),
        closeFileDescriptor: () => undefined,
      }),
    ).toMatchObject({ stationProfile: "unsupported-dgx-os" });
  });

  it("collects only bounded identity reads and never invokes host preparation", () => {
    const readFile = vi.fn(stationFixtureReadFile);
    const readdir = vi.fn(() => ["0000:01:00.0"]);
    const openFile = vi.fn(() => 17);
    const statFileDescriptor = vi.fn(() => trustedMarkerStat());
    const readFileDescriptor = vi.fn(() => "");
    const closeFileDescriptor = vi.fn();

    expect(
      collectPlatformIdentity({
        productNamePath: "/fixtures/product_name",
        osReleasePath: "/fixtures/os-release",
        stationReleasePath: "/fixtures/dgx-release",
        pciDevicesPath: "/fixtures/pci",
        readFile,
        readdir,
        openFile,
        statFileDescriptor,
        readFileDescriptor,
        closeFileDescriptor,
      }),
    ).toEqual({
      productName: "NVIDIA DGX Station GB300",
      nvidiaPlatform: "station",
      stationProfile: "unsupported-dgx-os",
      stationGb300PciGpu: true,
      osId: "ubuntu",
      osVersionId: "24.04",
    });
    expect(openFile).toHaveBeenCalledWith("/fixtures/dgx-release", expect.any(Number));
    expect(statFileDescriptor).toHaveBeenCalledWith(17);
    expect(readFileDescriptor).toHaveBeenCalledWith(17, 4096);
    expect(closeFileDescriptor).toHaveBeenCalledWith(17);
    expect(readFile.mock.calls.every(([path]) => String(path).startsWith("/fixtures/"))).toBe(true);
  });

  it("does not parse a Station marker replacement after opening the trusted file", () => {
    const replacement = noOtaStationRelease();
    let replaced = false;
    const readFile = vi.fn((filePath: string) =>
      replaced && filePath.endsWith("dgx-release") ? replacement : stationFixtureReadFile(filePath),
    );
    const readFileDescriptor = vi.fn(() => {
      throw Object.assign(new Error("opened marker became unreadable"), { code: "EIO" });
    });

    expect(
      collectPlatformIdentity({
        productNamePath: "/fixtures/product_name",
        osReleasePath: "/fixtures/os-release",
        stationReleasePath: "/fixtures/dgx-release",
        pciDevicesPath: "/fixtures/pci",
        readFile,
        readdir: () => ["0000:01:00.0"],
        openFile: () => 17,
        statFileDescriptor: () => {
          replaced = true;
          return trustedMarkerStat();
        },
        readFileDescriptor,
        closeFileDescriptor: () => undefined,
      }),
    ).toMatchObject({ stationProfile: "unknown" });
    expect(replaced).toBe(true);
    expect(readFileDescriptor).toHaveBeenCalledWith(17, 4096);
    expect(readFile).not.toHaveBeenCalledWith("/fixtures/dgx-release");
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
  ] as const)("accepts %s exact Station GB300 devices as preparation", (devices, _count) => {
    const readFile = vi.fn(stationFixtureReadFile);

    const identity = collectPlatformIdentity({
      productNamePath: "/fixtures/product_name",
      osReleasePath: "/fixtures/os-release",
      stationReleasePath: "/fixtures/dgx-release",
      pciDevicesPath: "/fixtures/pci",
      readFile,
      readdir: () => devices,
      openFile: () => 17,
      statFileDescriptor: () => trustedMarkerStat(),
      readFileDescriptor: () => "",
      closeFileDescriptor: () => undefined,
    });

    expect(isStationGb300PciDevice("0x10DE", "0x31c2", "0x030000")).toBe(true);
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
    expect(readFile).toHaveBeenCalledWith(expect.stringContaining("/device"));
  });

  it("rejects a non-GB300 NVIDIA display-class device", () => {
    const identity = collectPlatformIdentity({
      productNamePath: "/fixtures/product_name",
      osReleasePath: "/fixtures/os-release",
      stationReleasePath: "/fixtures/dgx-release",
      pciDevicesPath: "/fixtures/pci",
      readFile: nonGb300StationFixtureReadFile,
      readdir: () => ["0000:01:00.0"],
      openFile: () => 17,
      statFileDescriptor: () => trustedMarkerStat(),
      readFileDescriptor: () => noOtaStationRelease(),
      closeFileDescriptor: () => undefined,
    });

    expect(isStationGb300PciDevice("0x10DE", "0xffff", "0x030000")).toBe(false);
    expect(identity.stationGb300PciGpu).toBe(false);
  });

  it("bounds firmware identity before publishing it", () => {
    const identity = collectPlatformIdentity({
      productNamePath: "/fixtures/product_name",
      readFile: () => "NVIDIA DGX Spark".padEnd(5000, "x"),
    });

    expect(identity).toEqual({ nvidiaPlatform: undefined, productName: undefined });
  });
});
