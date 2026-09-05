// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import type { NvidiaPlatform } from "../inference/nim.js";
import { collectN1xIdentity, type N1xIdentityOptions } from "../inference/platform-identity/n1x.js";
import {
  isAdmittedStationProfile,
  isQualifiedStationRuntime,
  isStationGb300PciDevice,
  isStationGb300ProductName,
  isTrustedStationReleaseMarker,
  STATION_RELEASE_MARKER_MAX_BYTES,
  type StationProfile,
} from "./station-qualification.js";
import type {
  QualificationStatus,
  ReadinessCapability,
  ReadinessEvidence,
  ReadinessFinding,
  ReadinessQualification,
  ReadinessState,
} from "./types.js";

export type { StationProfile } from "./station-qualification.js";

export interface PlatformIdentity {
  nvidiaPlatform?: NvidiaPlatform | null;
  productName?: string | null;
  stationFirmwareProduct?: string | null;
  stationSystemVendor?: string | null;
  stationCpuCoreCount?: number | null;
  stationHostMemoryBytes?: number | null;
  n1xCandidate?: boolean | null;
  n1xFastOsMarker?: boolean | null;
  n1xPciGpu?: boolean | null;
  n1xWslProduct?: boolean | null;
  stationProfile?: StationProfile | null;
  stationGb300PciGpu?: boolean | null;
  osId?: string | null;
  osVersionId?: string | null;
  osPrettyName?: string | null;
  stationReleaseName?: string | null;
  stationReleasePrettyName?: string | null;
  stationReleasePlatform?: string | null;
  stationSoftwareBuildVersion?: string | null;
  stationSoftwareBuildDate?: string | null;
  stationOtaVersion?: string | null;
  wslDockerDesktopGpuProofPassed?: boolean;
}

export interface PlatformQualificationInput extends PlatformIdentity {
  platform: string;
  architecture: string;
  isWsl: boolean;
  dockerInstalled: boolean;
  dockerReachable: boolean;
  runtime: string;
  hasNvidiaGpu: boolean;
  nvidiaGpuCount?: number;
  nvidiaGpuMemoryPerDeviceBytes?: number;
}

export interface PlatformQualificationProjection {
  capabilities: ReadinessCapability[];
  qualifications: ReadinessQualification[];
  findings: ReadinessFinding[];
  evidence: ReadinessEvidence[];
}

export interface CollectPlatformIdentityOptions extends N1xIdentityOptions {
  productNamePath?: string;
  productFamilyPath?: string;
  boardNamePath?: string;
  systemVendorPath?: string;
  cpuPossiblePath?: string;
  memInfoPath?: string;
  stationReleasePath?: string;
  osReleasePath?: string;
  isWsl?: boolean;
  runCaptureImpl?: (command: readonly string[], options?: { ignoreError?: boolean }) => string;
}

const N1X_WSL_PRODUCT_NAME_MAX_BYTES = 256;
const N1X_WSL_PRODUCT_PATTERN = /(?:^|\s)RTX Spark N1X(?:$|\s)/i;
const STATION_FIRMWARE_VALUE_MAX_BYTES = 256;
const STATION_HOST_INFO_MAX_BYTES = 64 * 1024;
const MAX_REPORTED_CPU_COUNT = 4096;

export function isN1xWslProductName(value: string): boolean {
  return N1X_WSL_PRODUCT_PATTERN.test(value.trim());
}

function collectN1xWslProduct(options: CollectPlatformIdentityOptions): boolean | undefined {
  if (!options.isWsl || !options.runCaptureImpl) return undefined;
  try {
    const raw = options.runCaptureImpl(
      [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-CimInstance Win32_ComputerSystem).Model",
      ],
      { ignoreError: true },
    );
    const normalized = String(raw ?? "")
      .replace(/\r/g, "")
      .trim();
    if (
      !normalized ||
      normalized.includes("\0") ||
      normalized.includes("\n") ||
      Buffer.byteLength(normalized, "utf8") > N1X_WSL_PRODUCT_NAME_MAX_BYTES
    ) {
      return undefined;
    }
    return isN1xWslProductName(normalized);
  } catch {
    return undefined;
  }
}

function readOptional(
  readFile: (filePath: string) => string,
  filePath: string,
  maxBytes = STATION_RELEASE_MARKER_MAX_BYTES,
): string | undefined {
  try {
    const contents = readFile(filePath);
    if (Buffer.byteLength(contents) > maxBytes) return undefined;
    return contents.replace(/\0/g, "").trim() || undefined;
  } catch {
    return undefined;
  }
}

function nvidiaPlatformFromProducts(
  products: readonly (string | undefined)[],
): NvidiaPlatform | undefined {
  for (const product of products) {
    if (!product) continue;
    if (/DGX[_\s-]+Spark/i.test(product)) return "spark";
    if (
      /(?<![A-Za-z0-9])P3830(?![A-Za-z0-9])/i.test(product) ||
      /DGX[_\s-]+Station/i.test(product) ||
      (/Station/i.test(product) && /GB300/i.test(product))
    ) {
      return "station";
    }
    if (/Jetson|Tegra|Thor|Orin|Xavier/i.test(product)) return "jetson";
  }
  return undefined;
}

function parseOsRelease(contents: string): {
  osId?: string;
  osVersionId?: string;
  osPrettyName?: string;
} {
  const values = new Map<string, string>();
  for (const line of contents.split("\n")) {
    const match = /^(ID|VERSION_ID|PRETTY_NAME)=(?:"([^"\0]*)"|([A-Za-z0-9._-]+))$/.exec(line);
    if (!match) continue;
    const [, key, quotedValue, plainValue] = match;
    if (!key || values.has(key)) continue;
    values.set(key, quotedValue ?? plainValue ?? "");
  }
  return {
    osId: values.get("ID"),
    osVersionId: values.get("VERSION_ID"),
    osPrettyName: values.get("PRETTY_NAME")?.slice(0, STATION_FIRMWARE_VALUE_MAX_BYTES),
  };
}

function parseCpuPossibleCount(contents: string): number | undefined {
  const ranges: Array<readonly [number, number]> = [];
  for (const part of contents.trim().split(",")) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) return undefined;
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return undefined;
    if (end >= MAX_REPORTED_CPU_COUNT) return undefined;
    ranges.push([start, end]);
  }
  ranges.sort(([left], [right]) => left - right);
  let count = 0;
  let priorEnd = -1;
  for (const [start, end] of ranges) {
    if (start <= priorEnd) return undefined;
    count += end - start + 1;
    priorEnd = end;
  }
  return count || undefined;
}

function parseHostMemoryBytes(contents: string): number | undefined {
  const match = /^MemTotal:\s+(\d+)\s+kB$/mu.exec(contents);
  if (!match) return undefined;
  const kibibytes = Number(match[1]);
  const bytes = kibibytes * 1024;
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
}

type StationReleaseParseResult = Pick<
  PlatformIdentity,
  | "stationProfile"
  | "stationReleaseName"
  | "stationReleasePrettyName"
  | "stationReleasePlatform"
  | "stationSoftwareBuildVersion"
  | "stationSoftwareBuildDate"
  | "stationOtaVersion"
>;

const STATION_RELEASE_FIELDS = new Set([
  "DGX_NAME",
  "DGX_PRETTY_NAME",
  "DGX_SWBUILD_DATE",
  "DGX_SWBUILD_VERSION",
  "DGX_COMMIT_ID",
  "DGX_OTA_PRETTY_NAME",
  "DGX_OTA_VERSION",
  "DGX_OTA_DATE",
  "DGX_PLATFORM",
  "DGX_SERIAL_NUMBER",
]);

function stationReleaseResult(
  values: ReadonlyMap<string, readonly string[]>,
  stationProfile: StationProfile,
): StationReleaseParseResult {
  const stationReleaseName = values.get("DGX_NAME")?.[0];
  const stationReleasePrettyName = values.get("DGX_PRETTY_NAME")?.[0];
  const stationReleasePlatform = values.get("DGX_PLATFORM")?.[0];
  const stationSoftwareBuildVersion = values.get("DGX_SWBUILD_VERSION")?.[0];
  const stationSoftwareBuildDate = values.get("DGX_SWBUILD_DATE")?.[0];
  const stationOtaVersion = values.get("DGX_OTA_VERSION")?.at(-1);
  return {
    stationProfile,
    ...(stationReleaseName === undefined ? {} : { stationReleaseName }),
    ...(stationReleasePrettyName === undefined ? {} : { stationReleasePrettyName }),
    ...(stationReleasePlatform === undefined ? {} : { stationReleasePlatform }),
    ...(stationSoftwareBuildVersion === undefined ? {} : { stationSoftwareBuildVersion }),
    ...(stationSoftwareBuildDate === undefined ? {} : { stationSoftwareBuildDate }),
    ...(stationOtaVersion === undefined ? {} : { stationOtaVersion }),
  };
}

function parseStationRelease(contents: string): StationReleaseParseResult {
  const values = new Map<string, string[]>();
  const unsupported = () => stationReleaseResult(values, "unsupported-dgx-os");
  let expectedOtaDate = false;
  for (const line of contents.split("\n")) {
    if (!line) {
      if (expectedOtaDate) return unsupported();
      continue;
    }
    const match = /^([A-Z][A-Z0-9_]*)="([^"]*)"$/.exec(line);
    if (!match) return unsupported();
    const [, key, value] = match;
    if (!key || value === undefined || !STATION_RELEASE_FIELDS.has(key)) return unsupported();
    const existing = values.get(key) ?? [];
    if (key === "DGX_OTA_VERSION") {
      if (expectedOtaDate || existing.includes(value)) return unsupported();
      expectedOtaDate = true;
    } else if (key === "DGX_OTA_DATE") {
      if (!expectedOtaDate) return unsupported();
      expectedOtaDate = false;
    } else if (expectedOtaDate || existing.length > 0) {
      return unsupported();
    }
    existing.push(value);
    values.set(key, existing);
  }
  if (expectedOtaDate || values.get("DGX_PLATFORM")?.[0] !== "DGX Server for GALAXY-GB300") {
    return unsupported();
  }

  const otaVersions = values.get("DGX_OTA_VERSION") ?? [];
  if (otaVersions.length > 0) {
    const otaPretty = values.get("DGX_OTA_PRETTY_NAME")?.[0];
    if (otaPretty !== undefined && otaPretty !== "DGX OS") {
      return unsupported();
    }
    const stationProfile = ["7.2.0", "7.4.0", "7.5.0"].includes(otaVersions.at(-1) ?? "")
      ? "supported-dgx-os"
      : "validation-only-factory-runtime";
    return stationReleaseResult(values, stationProfile);
  }
  if (values.has("DGX_OTA_PRETTY_NAME") || values.has("DGX_OTA_DATE")) {
    return unsupported();
  }
  const noOtaVersion = values.get("DGX_SWBUILD_VERSION")?.[0];
  const noOtaBuildDate = values.get("DGX_SWBUILD_DATE")?.[0];
  if (!noOtaVersion || !noOtaBuildDate) return unsupported();
  if (/^7\.6\.[0-9]+$/u.test(noOtaVersion)) {
    return stationReleaseResult(values, "supported-dgx-os");
  }
  const identity = [noOtaVersion, noOtaBuildDate].join("|");
  if (identity === "7.5.0-GB300ws-GB200ws|2026-04-02-08-20-16") {
    return stationReleaseResult(values, "supported-colossus-baseos");
  }
  if (identity === "7.5.0|2026-06-16-11-48-10") {
    return stationReleaseResult(values, "supported-ai-developer-tools");
  }
  if (identity === "7.5.0|2026-05-13-18-42-38") {
    return stationReleaseResult(values, "supported-ai-developer-tools");
  }
  return stationReleaseResult(values, "validation-only-factory-runtime");
}

function stationHasGb300PciGpu(
  readFile: (filePath: string) => string,
  readdir: (directory: string) => readonly string[],
  pciDevicesPath: string,
): boolean | undefined {
  try {
    const entries = readdir(pciDevicesPath);
    let incompleteEvidence = entries.length > 256;
    for (const entry of entries.slice(0, 256)) {
      const devicePath = path.join(pciDevicesPath, entry);
      const vendor = readOptional(readFile, path.join(devicePath, "vendor"));
      const device = readOptional(readFile, path.join(devicePath, "device"));
      const pciClass = readOptional(readFile, path.join(devicePath, "class"));
      if (isStationGb300PciDevice(vendor, device, pciClass)) return true;
      if (vendor === undefined || device === undefined || pciClass === undefined) {
        incompleteEvidence = true;
      }
    }
    return incompleteEvidence ? undefined : false;
  } catch {
    return undefined;
  }
}

function readOpenedFile(fileDescriptor: number, maxBytes: number): string {
  const contents = Buffer.alloc(maxBytes + 1);
  const bytesRead = fs.readSync(fileDescriptor, contents, 0, contents.length, 0);
  if (bytesRead > maxBytes) throw new Error("identity file exceeds the size limit");
  return contents.toString("utf8", 0, bytesRead);
}

export function collectPlatformIdentity(
  options: CollectPlatformIdentityOptions = {},
): PlatformIdentity {
  const readFile = options.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf8"));
  const readdir = options.readdir ?? ((directory: string) => fs.readdirSync(directory));
  const openFile = options.openFile ?? ((filePath, flags) => fs.openSync(filePath, flags));
  const statFileDescriptor =
    options.statFileDescriptor ?? ((fileDescriptor) => fs.fstatSync(fileDescriptor));
  const readFileDescriptor = options.readFileDescriptor ?? readOpenedFile;
  const closeFileDescriptor =
    options.closeFileDescriptor ?? ((fileDescriptor) => fs.closeSync(fileDescriptor));
  const productName = readOptional(
    readFile,
    options.productNamePath ?? "/sys/class/dmi/id/product_name",
    STATION_FIRMWARE_VALUE_MAX_BYTES,
  );
  const productFamily = readOptional(
    readFile,
    options.productFamilyPath ?? "/sys/class/dmi/id/product_family",
    STATION_FIRMWARE_VALUE_MAX_BYTES,
  );
  const boardName = readOptional(
    readFile,
    options.boardNamePath ?? "/sys/class/dmi/id/board_name",
    STATION_FIRMWARE_VALUE_MAX_BYTES,
  );
  const stationSystemVendor = readOptional(
    readFile,
    options.systemVendorPath ?? "/sys/class/dmi/id/sys_vendor",
    STATION_FIRMWARE_VALUE_MAX_BYTES,
  );
  const firmwareProducts = [productName, productFamily, boardName];
  const stationFirmwareProduct = firmwareProducts.find(
    (value): value is string => value !== undefined && isStationGb300ProductName(value),
  );
  const n1xWslProduct = collectN1xWslProduct(options);
  const wslIdentity = options.isWsl ? { n1xWslProduct } : {};
  let nvidiaPlatform = nvidiaPlatformFromProducts(firmwareProducts);
  if (nvidiaPlatform === undefined) {
    const n1xIdentity = collectN1xIdentity({
      readFile,
      readdir,
      openFile,
      statFileDescriptor,
      readFileDescriptor,
      closeFileDescriptor,
      fastOsReleasePath: options.fastOsReleasePath,
      pciDevicesPath: options.pciDevicesPath,
    });
    if (n1xIdentity.fastOsPlatform === "spark") nvidiaPlatform = "spark";
    else if (n1xIdentity.qualified) nvidiaPlatform = "n1x";
    if (n1xIdentity.candidate && n1xIdentity.fastOsPlatform !== "spark") {
      return {
        nvidiaPlatform,
        productName,
        ...wslIdentity,
        n1xCandidate: true,
        n1xFastOsMarker: n1xIdentity.fastOsMarker,
        n1xPciGpu: n1xIdentity.pciGpu,
      };
    }
  }
  if (nvidiaPlatform !== "station") return { nvidiaPlatform, productName, ...wslIdentity };
  const osRelease = readOptional(readFile, options.osReleasePath ?? "/etc/os-release");
  const { osId, osVersionId, osPrettyName } = osRelease ? parseOsRelease(osRelease) : {};
  const stationCpuCoreCount = parseCpuPossibleCount(
    readOptional(
      readFile,
      options.cpuPossiblePath ?? "/sys/devices/system/cpu/possible",
      STATION_FIRMWARE_VALUE_MAX_BYTES,
    ) ?? "",
  );
  const stationHostMemoryBytes = parseHostMemoryBytes(
    readOptional(readFile, options.memInfoPath ?? "/proc/meminfo", STATION_HOST_INFO_MAX_BYTES) ??
      "",
  );

  const stationReleasePath = options.stationReleasePath ?? "/etc/dgx-release";
  let stationRelease: StationReleaseParseResult = { stationProfile: "generic-ubuntu" };
  try {
    const fileDescriptor = openFile(
      stationReleasePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      const metadata = statFileDescriptor(fileDescriptor);
      if (!isTrustedStationReleaseMarker(metadata)) {
        stationRelease = { stationProfile: "unsupported-dgx-os" };
      } else {
        stationRelease = parseStationRelease(
          readFileDescriptor(fileDescriptor, STATION_RELEASE_MARKER_MAX_BYTES),
        );
      }
    } finally {
      closeFileDescriptor(fileDescriptor);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") {
      stationRelease = { stationProfile: "unsupported-dgx-os" };
    } else if (code !== "ENOENT") {
      stationRelease = { stationProfile: "unknown" };
    }
  }
  return {
    nvidiaPlatform,
    productName,
    ...(stationFirmwareProduct === undefined ? {} : { stationFirmwareProduct }),
    ...(stationSystemVendor === undefined ? {} : { stationSystemVendor }),
    ...(stationCpuCoreCount === undefined ? {} : { stationCpuCoreCount }),
    ...(stationHostMemoryBytes === undefined ? {} : { stationHostMemoryBytes }),
    ...wslIdentity,
    ...stationRelease,
    stationGb300PciGpu: stationHasGb300PciGpu(
      readFile,
      readdir,
      options.pciDevicesPath ?? "/sys/bus/pci/devices",
    ),
    osId,
    osVersionId,
    ...(osPrettyName === undefined ? {} : { osPrettyName }),
  };
}

function capability(id: string, state: ReadinessState): ReadinessCapability {
  return { id, state };
}

function qualification(
  id: string,
  status: QualificationStatus,
  capabilityIds: readonly string[],
): ReadinessQualification {
  return { id, status, capabilityIds };
}

function deriveN1xQualification(input: Readonly<PlatformQualificationInput>): {
  identity: boolean;
  qualified: boolean;
  status: QualificationStatus;
} {
  const identity =
    input.nvidiaPlatform === "n1x" || input.n1xCandidate === true || input.n1xFastOsMarker === true;
  const qualified =
    input.nvidiaPlatform === "n1x" &&
    input.n1xFastOsMarker === true &&
    input.n1xPciGpu === true &&
    input.platform === "linux" &&
    input.architecture === "arm64" &&
    input.hasNvidiaGpu;
  let status: QualificationStatus = "unknown";
  if (identity && input.n1xFastOsMarker === false) {
    status = "unqualified";
  } else if (identity && input.n1xFastOsMarker === true && input.n1xPciGpu !== undefined) {
    status = qualified ? "qualified" : "unqualified";
  }
  return { identity, qualified, status };
}

function deriveN1xWslQualification(
  input: Readonly<PlatformQualificationInput>,
): QualificationStatus {
  if (!input.isWsl) return "unqualified";
  if (input.n1xWslProduct === undefined || input.n1xWslProduct === null) return "unknown";
  return input.n1xWslProduct === true &&
    input.platform === "linux" &&
    input.architecture === "arm64" &&
    input.runtime === "docker-desktop" &&
    input.dockerReachable &&
    input.hasNvidiaGpu
    ? "qualified"
    : "unqualified";
}

function deriveStationQualification(input: Readonly<PlatformQualificationInput>): {
  identity: boolean;
  qualified: boolean;
  hardwareStatus: QualificationStatus;
  softwareStatus: QualificationStatus;
  runtimeStatus: QualificationStatus;
  status: QualificationStatus;
} {
  const identity = input.nvidiaPlatform === "station";
  const firmwareProduct =
    input.stationFirmwareProduct ??
    (input.productName && isStationGb300ProductName(input.productName)
      ? input.productName
      : undefined);
  const hardwareStatus: QualificationStatus = !identity
    ? "unknown"
    : !firmwareProduct || input.stationGb300PciGpu === false
      ? "unqualified"
      : input.stationGb300PciGpu === undefined || input.stationGb300PciGpu === null
        ? "unknown"
        : "qualified";
  const softwareStatus: QualificationStatus = isAdmittedStationProfile(input.stationProfile)
    ? "qualified"
    : input.stationProfile === "unsupported-dgx-os"
      ? "unqualified"
      : "unknown";
  const knownOs =
    input.osId !== undefined &&
    input.osId !== null &&
    input.osVersionId !== undefined &&
    input.osVersionId !== null;
  const runtimeQualified = isQualifiedStationRuntime(input);
  const runtimeStatus: QualificationStatus = !knownOs
    ? "unknown"
    : runtimeQualified
      ? "qualified"
      : "unqualified";
  const observedProfile =
    input.stationProfile !== undefined &&
    input.stationProfile !== null &&
    input.stationProfile !== "unknown";
  const qualified =
    hardwareStatus === "qualified" && softwareStatus === "qualified" && runtimeQualified;
  const status: QualificationStatus = !identity
    ? "unknown"
    : hardwareStatus === "unknown" || !observedProfile || !knownOs
      ? "unknown"
      : qualified
        ? "qualified"
        : "unqualified";
  return { identity, qualified, hardwareStatus, softwareStatus, runtimeStatus, status };
}

export function projectPlatformQualification(
  input: Readonly<PlatformQualificationInput>,
): PlatformQualificationProjection {
  const linuxArchitecture = input.architecture === "x64" || input.architecture === "arm64";
  const linuxSupported = input.platform === "linux" && linuxArchitecture;
  const macosAppleSilicon = input.platform === "darwin" && input.architecture === "arm64";
  const macosRuntime = input.runtime === "docker-desktop" || input.runtime === "colima";
  const macosSupported = macosAppleSilicon && input.dockerReachable && macosRuntime;
  const dockerDesktop = input.isWsl && input.dockerReachable && input.runtime === "docker-desktop";
  const nativeDocker = input.isWsl && input.dockerReachable && input.runtime === "docker";
  const wslRuntimeAvailable = dockerDesktop || nativeDocker;
  const wslGpuPassthrough: ReadinessState =
    input.isWsl && dockerDesktop
      ? input.hasNvidiaGpu
        ? input.wslDockerDesktopGpuProofPassed === true
          ? "present"
          : input.wslDockerDesktopGpuProofPassed === false
            ? "absent"
            : "unknown"
        : "absent"
      : input.isWsl
        ? "unknown"
        : "absent";
  const station = deriveStationQualification(input);
  const stationIdentity = station.identity;
  const stationQualified = station.qualified;
  const stationHardwareStatus = station.hardwareStatus;
  const stationSoftwareStatus = station.softwareStatus;
  const stationRuntimeStatus = station.runtimeStatus;
  const stationStatus = station.status;
  const sparkIdentity = input.nvidiaPlatform === "spark";
  const sparkQualified = sparkIdentity && input.architecture === "arm64" && input.hasNvidiaGpu;
  const n1x = deriveN1xQualification(input);
  const n1xWslStatus = deriveN1xWslQualification(input);
  const platformSupported =
    (linuxSupported || macosSupported) &&
    (!stationIdentity || stationQualified) &&
    (!sparkIdentity || sparkQualified) &&
    !n1x.identity &&
    (!input.isWsl || dockerDesktop);
  const evidence: ReadinessEvidence[] = [];
  if (
    input.productName ||
    input.nvidiaPlatform ||
    input.n1xCandidate !== undefined ||
    input.n1xFastOsMarker !== undefined ||
    input.n1xPciGpu !== undefined ||
    input.n1xWslProduct !== undefined ||
    input.stationProfile ||
    input.stationFirmwareProduct
  ) {
    evidence.push({
      id: "host.platform.identity",
      summary: "Bounded platform identity used for qualification.",
      details: {
        product: input.productName?.slice(0, 256) ?? null,
        nvidiaPlatform: input.nvidiaPlatform ?? null,
        stationFirmwareProduct: input.stationFirmwareProduct?.slice(0, 256) ?? null,
        stationSystemVendor: input.stationSystemVendor?.slice(0, 256) ?? null,
        stationCpuCoreCount: input.stationCpuCoreCount ?? null,
        stationHostMemoryBytes: input.stationHostMemoryBytes ?? null,
        nvidiaGpuCount: input.nvidiaGpuCount ?? null,
        nvidiaGpuMemoryPerDeviceBytes: input.nvidiaGpuMemoryPerDeviceBytes ?? null,
        n1xCandidate: input.n1xCandidate ?? null,
        n1xFastOsMarker: input.n1xFastOsMarker ?? null,
        n1xPciGpu: input.n1xPciGpu ?? null,
        n1xWslProduct: input.n1xWslProduct ?? null,
        stationProfile: input.stationProfile ?? null,
        stationGb300PciGpu: input.stationGb300PciGpu ?? null,
        osId: input.osId ?? null,
        osVersionId: input.osVersionId ?? null,
        osPrettyName: input.osPrettyName?.slice(0, 256) ?? null,
        stationReleaseName: input.stationReleaseName?.slice(0, 256) ?? null,
        stationReleasePrettyName: input.stationReleasePrettyName?.slice(0, 256) ?? null,
        stationReleasePlatform: input.stationReleasePlatform?.slice(0, 256) ?? null,
        stationSoftwareBuildVersion: input.stationSoftwareBuildVersion?.slice(0, 256) ?? null,
        stationSoftwareBuildDate: input.stationSoftwareBuildDate?.slice(0, 256) ?? null,
        stationOtaVersion: input.stationOtaVersion?.slice(0, 256) ?? null,
      },
    });
  }

  const capabilities = [
    capability("host.platform.supported", platformSupported ? "present" : "absent"),
    capability("host.platform.linux_supported", linuxSupported ? "present" : "absent"),
    capability("host.platform.macos_apple_silicon", macosSupported ? "present" : "absent"),
    capability("host.platform.wsl_docker_desktop", dockerDesktop ? "present" : "absent"),
    capability("host.platform.wsl_native_docker", nativeDocker ? "present" : "absent"),
    capability(
      "host.platform.wsl_runtime_available",
      input.isWsl
        ? input.dockerInstalled
          ? input.dockerReachable
            ? wslRuntimeAvailable
              ? "present"
              : "unknown"
            : "absent"
          : "absent"
        : "absent",
    ),
    capability("host.platform.wsl_gpu_passthrough", wslGpuPassthrough),
    capability(
      "host.platform.n1x_wsl",
      !input.isWsl ? "absent" : n1xWslStatus === "qualified" ? "present" : "absent",
    ),
    capability("host.platform.dgx_spark", sparkQualified ? "present" : "absent"),
    capability(
      "host.platform.n1x",
      !n1x.identity
        ? "absent"
        : n1x.status === "qualified"
          ? "present"
          : n1x.status === "unqualified"
            ? "absent"
            : "unknown",
    ),
    capability(
      "host.platform.dgx_station_hardware",
      !stationIdentity
        ? "absent"
        : stationHardwareStatus === "qualified"
          ? "present"
          : stationHardwareStatus === "unqualified"
            ? "absent"
            : "unknown",
    ),
    capability(
      "host.platform.dgx_station_software",
      !stationIdentity
        ? "absent"
        : stationSoftwareStatus === "qualified"
          ? "present"
          : stationSoftwareStatus === "unqualified"
            ? "absent"
            : "unknown",
    ),
    capability(
      "host.platform.dgx_station_runtime",
      !stationIdentity
        ? "absent"
        : stationRuntimeStatus === "qualified"
          ? "present"
          : stationRuntimeStatus === "unqualified"
            ? "absent"
            : "unknown",
    ),
    capability(
      "host.platform.dgx_station",
      !stationIdentity
        ? "absent"
        : stationStatus === "qualified"
          ? "present"
          : stationStatus === "unqualified"
            ? "absent"
            : "unknown",
    ),
  ];
  const qualifications: ReadinessQualification[] = [];
  if (input.isWsl) {
    qualifications.push(
      qualification(
        "host.platform.wsl",
        dockerDesktop
          ? "qualified"
          : nativeDocker
            ? "unqualified"
            : input.dockerInstalled && input.dockerReachable
              ? "unknown"
              : "unqualified",
        [
          "host.platform.wsl_runtime_available",
          "host.platform.wsl_docker_desktop",
          "host.platform.wsl_native_docker",
          "host.platform.wsl_gpu_passthrough",
        ],
      ),
    );
    if (input.n1xWslProduct === true) {
      qualifications.push(
        qualification("host.platform.n1x_wsl", n1xWslStatus, ["host.platform.n1x_wsl"]),
      );
    }
  }
  if (sparkIdentity) {
    qualifications.push(
      qualification("host.platform.dgx_spark", sparkQualified ? "qualified" : "unqualified", [
        "host.platform.dgx_spark",
      ]),
    );
  }
  if (n1x.identity) {
    qualifications.push(qualification("host.platform.n1x", n1x.status, ["host.platform.n1x"]));
  }
  if (stationIdentity) {
    qualifications.push(
      qualification("host.platform.dgx_station_hardware", stationHardwareStatus, [
        "host.platform.dgx_station_hardware",
      ]),
      qualification("host.platform.dgx_station_software", stationSoftwareStatus, [
        "host.platform.dgx_station_software",
      ]),
      qualification("host.platform.dgx_station_runtime", stationRuntimeStatus, [
        "host.platform.dgx_station_runtime",
      ]),
      qualification("host.platform.dgx_station", stationStatus, [
        "host.platform.dgx_station_hardware",
        "host.platform.dgx_station_software",
        "host.platform.dgx_station_runtime",
      ]),
    );
  }
  const findings: ReadinessFinding[] = [];
  if (input.isWsl && !input.dockerInstalled) {
    findings.push({
      id: "host.platform.wsl_runtime_unavailable",
      severity: "blocking",
      summary: "WSL has no available Docker runtime.",
      capabilityIds: ["host.platform.wsl_runtime_available"],
    });
  } else if (input.isWsl && input.dockerInstalled && !input.dockerReachable) {
    findings.push({
      id: "host.platform.wsl_runtime_unreachable",
      severity: "blocking",
      summary: "WSL cannot reach the configured Docker runtime.",
      capabilityIds: ["host.platform.wsl_runtime_available"],
    });
  } else if (nativeDocker) {
    findings.push({
      id: "host.platform.wsl_native_docker_unqualified",
      severity: "blocking",
      summary: "Native Docker Engine inside WSL is not the qualified Docker Desktop integration.",
      capabilityIds: ["host.platform.wsl_native_docker", "host.platform.supported"],
    });
  } else if (input.isWsl && input.dockerReachable && !dockerDesktop) {
    findings.push({
      id: "host.platform.wsl_runtime_inconclusive",
      severity: "blocking",
      summary: "WSL Docker runtime identity is inconclusive.",
      capabilityIds: ["host.platform.wsl_runtime_available"],
    });
  }
  if (input.isWsl && dockerDesktop && wslGpuPassthrough === "unknown") {
    findings.push({
      id: "host.platform.wsl_gpu_passthrough_inconclusive",
      severity: "warning",
      summary: "Docker Desktop WSL GPU passthrough could not be proven.",
      capabilityIds: ["host.platform.wsl_gpu_passthrough"],
    });
  } else if (input.isWsl && dockerDesktop && wslGpuPassthrough === "absent" && input.hasNvidiaGpu) {
    findings.push({
      id: "host.platform.wsl_gpu_passthrough_unavailable",
      severity: "warning",
      summary: "Docker Desktop WSL GPU passthrough proof failed.",
      capabilityIds: ["host.platform.wsl_gpu_passthrough"],
    });
  }
  if (stationStatus === "unqualified") {
    findings.push({
      id: "host.platform.dgx_station_unqualified",
      severity: "blocking",
      summary: "DGX Station hardware or software profile is not qualified.",
      capabilityIds: ["host.platform.dgx_station", "host.platform.supported"],
      ...(evidence.length ? { evidenceIds: ["host.platform.identity"] } : {}),
    });
  } else if (stationIdentity && stationStatus === "unknown") {
    findings.push({
      id: "host.platform.dgx_station_inconclusive",
      severity: "blocking",
      summary: "DGX Station qualification is inconclusive and fails closed.",
      capabilityIds: ["host.platform.dgx_station", "host.platform.supported"],
      ...(evidence.length ? { evidenceIds: ["host.platform.identity"] } : {}),
    });
  }
  if (stationQualified && input.stationProfile === "validation-only-factory-runtime") {
    findings.push({
      id: "host.platform.dgx_station_software_unrecognized",
      severity: "warning",
      summary:
        "DGX Station hardware qualifies, but its software profile uses validation-only factory-runtime handling.",
      capabilityIds: ["host.platform.dgx_station_software", "host.platform.dgx_station"],
      ...(evidence.length ? { evidenceIds: ["host.platform.identity"] } : {}),
    });
  }
  if (sparkIdentity && !sparkQualified) {
    findings.push({
      id: "host.platform.dgx_spark_unqualified",
      severity: "blocking",
      summary: "DGX Spark requires an ARM64 host with an available NVIDIA GPU.",
      capabilityIds: ["host.platform.dgx_spark", "host.platform.supported"],
      ...(evidence.length ? { evidenceIds: ["host.platform.identity"] } : {}),
    });
  }
  if (n1x.status === "qualified") {
    findings.push({
      id: "host.platform.n1x_validation_pending",
      severity: "blocking",
      summary: "N1x platform validation is pending a physical NemoClaw Express E2E run.",
      capabilityIds: ["host.platform.n1x", "host.platform.supported"],
      ...(evidence.length ? { evidenceIds: ["host.platform.identity"] } : {}),
    });
  } else if (n1x.status === "unqualified") {
    findings.push({
      id: "host.platform.n1x_unqualified",
      severity: "blocking",
      summary:
        "N1x requires the trusted FastOS marker, NVIDIA PCI identity, Arm64 host, and available NVIDIA GPU.",
      capabilityIds: ["host.platform.n1x", "host.platform.supported"],
      ...(evidence.length ? { evidenceIds: ["host.platform.identity"] } : {}),
    });
  } else if (n1x.identity && n1x.status === "unknown") {
    findings.push({
      id: "host.platform.n1x_inconclusive",
      severity: "blocking",
      summary: "N1x qualification is inconclusive and fails closed.",
      capabilityIds: ["host.platform.n1x", "host.platform.supported"],
      ...(evidence.length ? { evidenceIds: ["host.platform.identity"] } : {}),
    });
  }
  if (
    !platformSupported &&
    !findings.some(({ severity }) => severity === "blocking" || severity === "fatal")
  ) {
    findings.push({
      id: "host.platform.unsupported",
      severity: "blocking",
      summary: "The detected host platform and container runtime are not supported.",
      capabilityIds: ["host.platform.supported"],
    });
  }
  return { capabilities, qualifications, findings, evidence };
}
