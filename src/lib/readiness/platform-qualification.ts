// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import type { NvidiaPlatform } from "../inference/nim.js";
import { collectN1xIdentity, type N1xIdentityOptions } from "../inference/platform-identity/n1x.js";
import {
  isQualifiedStationProfile,
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
  n1xCandidate?: boolean | null;
  n1xFastOsMarker?: boolean | null;
  n1xPciGpu?: boolean | null;
  n1xWslProduct?: boolean | null;
  stationProfile?: StationProfile | null;
  stationGb300PciGpu?: boolean | null;
  osId?: string | null;
  osVersionId?: string | null;
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
}

export interface PlatformQualificationProjection {
  capabilities: ReadinessCapability[];
  qualifications: ReadinessQualification[];
  findings: ReadinessFinding[];
  evidence: ReadinessEvidence[];
}

export interface CollectPlatformIdentityOptions extends N1xIdentityOptions {
  productNamePath?: string;
  stationReleasePath?: string;
  osReleasePath?: string;
  isWsl?: boolean;
  runCaptureImpl?: (
    command: readonly string[],
    options?: { ignoreError?: boolean },
  ) => string;
}

const N1X_WSL_PRODUCT_NAME_MAX_BYTES = 256;
const N1X_WSL_PRODUCT_PATTERN = /(?:^|\s)RTX Spark N1X(?:$|\s)/i;

export function isN1xWslProductName(value: string): boolean {
  return N1X_WSL_PRODUCT_PATTERN.test(value.trim());
}

function collectN1xWslProduct(
  options: CollectPlatformIdentityOptions,
): boolean | undefined {
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
    const normalized = String(raw ?? "").replace(/\r/g, "").trim();
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
): string | undefined {
  try {
    const contents = readFile(filePath);
    if (Buffer.byteLength(contents) > STATION_RELEASE_MARKER_MAX_BYTES) return undefined;
    return contents.replace(/\0/g, "").trim() || undefined;
  } catch {
    return undefined;
  }
}

function nvidiaPlatformFromProduct(productName: string | undefined): NvidiaPlatform | undefined {
  if (!productName) return undefined;
  if (/DGX[_\s-]+Spark/i.test(productName)) return "spark";
  if (
    /(?<![A-Za-z0-9])P3830(?![A-Za-z0-9])/i.test(productName) ||
    /DGX[_\s-]+Station/i.test(productName) ||
    (/Station/i.test(productName) && /GB300/i.test(productName))
  ) {
    return "station";
  }
  if (/Jetson|Tegra|Thor|Orin|Xavier/i.test(productName)) return "jetson";
  return undefined;
}

function parseOsRelease(contents: string): { osId?: string; osVersionId?: string } {
  const values = new Map<string, string>();
  for (const line of contents.split("\n")) {
    const match = /^(ID|VERSION_ID)=(?:"([^"]*)"|([A-Za-z0-9._-]+))$/.exec(line);
    if (!match) continue;
    const [, key, quotedValue, plainValue] = match;
    if (!key || values.has(key)) continue;
    values.set(key, quotedValue ?? plainValue ?? "");
  }
  return {
    osId: values.get("ID"),
    osVersionId: values.get("VERSION_ID"),
  };
}

function parseStationRelease(contents: string): StationProfile {
  const values = new Map<string, string[]>();
  let expectedOtaDate = false;
  for (const line of contents.split("\n")) {
    if (!line) {
      if (expectedOtaDate) return "unsupported-dgx-os";
      continue;
    }
    const match = /^([A-Z][A-Z0-9_]*)="([^"]*)"$/.exec(line);
    if (!match) return "unsupported-dgx-os";
    const [, key, value] = match;
    if (!key || value === undefined) return "unsupported-dgx-os";
    const allowed = new Set([
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
    if (!allowed.has(key)) return "unsupported-dgx-os";
    const existing = values.get(key) ?? [];
    if (key === "DGX_OTA_VERSION") {
      if (expectedOtaDate || existing.includes(value)) return "unsupported-dgx-os";
      expectedOtaDate = true;
    } else if (key === "DGX_OTA_DATE") {
      if (!expectedOtaDate) return "unsupported-dgx-os";
      expectedOtaDate = false;
    } else if (expectedOtaDate || existing.length > 0) {
      return "unsupported-dgx-os";
    }
    existing.push(value);
    values.set(key, existing);
  }
  if (expectedOtaDate || values.get("DGX_PLATFORM")?.[0] !== "DGX Server for GALAXY-GB300") {
    return "unsupported-dgx-os";
  }

  const otaVersions = values.get("DGX_OTA_VERSION") ?? [];
  if (otaVersions.length > 0) {
    const otaPretty = values.get("DGX_OTA_PRETTY_NAME")?.[0];
    if (
      (otaPretty !== undefined && otaPretty !== "DGX OS") ||
      (otaPretty === undefined && values.get("DGX_PRETTY_NAME")?.[0] !== "NVIDIA DGX GB300WS")
    ) {
      return "unsupported-dgx-os";
    }
    return ["7.2.0", "7.4.0", "7.5.0"].includes(otaVersions.at(-1) ?? "")
      ? "supported-dgx-os"
      : "unsupported-dgx-os";
  }
  if (values.has("DGX_OTA_PRETTY_NAME") || values.has("DGX_OTA_DATE")) {
    return "unsupported-dgx-os";
  }
  const noOtaPrettyName = values.get("DGX_PRETTY_NAME")?.[0];
  const noOtaVersion = values.get("DGX_SWBUILD_VERSION")?.[0];
  if (
    (noOtaPrettyName === "NVIDIA DGX GB300WS" || noOtaPrettyName === "NVIDIA DGX Server") &&
    /^7\.6\.[0-9]+$/u.test(noOtaVersion ?? "") &&
    values.has("DGX_SWBUILD_DATE")
  ) {
    return "supported-dgx-os";
  }
  const identity = [noOtaPrettyName, noOtaVersion, values.get("DGX_SWBUILD_DATE")?.[0]].join("|");
  if (identity === "NVIDIA DGX Server|7.5.0-GB300ws-GB200ws|2026-04-02-08-20-16") {
    return "supported-colossus-baseos";
  }
  if (identity === "NVIDIA DGX GB300WS|7.5.0|2026-06-16-11-48-10") {
    return "supported-ai-developer-tools";
  }
  if (identity === "NVIDIA DGX GB300WS|7.5.0|2026-05-13-18-42-38") {
    return "supported-ai-developer-tools";
  }
  return "unsupported-dgx-os";
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
  );
  const n1xWslProduct = collectN1xWslProduct(options);
  const wslIdentity = options.isWsl ? { n1xWslProduct } : {};
  let nvidiaPlatform = nvidiaPlatformFromProduct(productName);
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
  const { osId, osVersionId } = osRelease ? parseOsRelease(osRelease) : {};

  const stationReleasePath = options.stationReleasePath ?? "/etc/dgx-release";
  let stationProfile: StationProfile = "generic-ubuntu";
  try {
    const fileDescriptor = openFile(
      stationReleasePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      const metadata = statFileDescriptor(fileDescriptor);
      if (!isTrustedStationReleaseMarker(metadata)) {
        stationProfile = "unsupported-dgx-os";
      } else {
        stationProfile = parseStationRelease(
          readFileDescriptor(fileDescriptor, STATION_RELEASE_MARKER_MAX_BYTES),
        );
      }
    } finally {
      closeFileDescriptor(fileDescriptor);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") {
      stationProfile = "unsupported-dgx-os";
    } else if (code !== "ENOENT") {
      stationProfile = "unknown";
    }
  }
  return {
    nvidiaPlatform,
    productName,
    ...wslIdentity,
    stationProfile,
    stationGb300PciGpu: stationHasGb300PciGpu(
      readFile,
      readdir,
      options.pciDevicesPath ?? "/sys/bus/pci/devices",
    ),
    osId,
    osVersionId,
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
  const stationIdentity = input.nvidiaPlatform === "station";
  const stationProduct = input.productName
    ? isStationGb300ProductName(input.productName)
    : undefined;
  const knownStationProfile =
    input.stationProfile !== undefined &&
    input.stationProfile !== null &&
    input.stationProfile !== "unknown";
  const knownStationOs =
    input.osId !== undefined &&
    input.osId !== null &&
    input.osVersionId !== undefined &&
    input.osVersionId !== null;
  const stationRuntimeQualified = isQualifiedStationRuntime(input);
  const stationQualified =
    stationIdentity &&
    stationProduct === true &&
    input.stationGb300PciGpu === true &&
    isQualifiedStationProfile(input.stationProfile) &&
    stationRuntimeQualified;
  const stationStatus: QualificationStatus = !stationIdentity
    ? "unknown"
    : stationProduct === undefined ||
        input.stationGb300PciGpu === undefined ||
        !knownStationProfile ||
        !knownStationOs
      ? "unknown"
      : stationQualified
        ? "qualified"
        : "unqualified";
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
    input.stationProfile
  ) {
    evidence.push({
      id: "host.platform.identity",
      summary: "Bounded platform identity used for qualification.",
      details: {
        product: input.productName?.slice(0, 256) ?? null,
        nvidiaPlatform: input.nvidiaPlatform ?? null,
        n1xCandidate: input.n1xCandidate ?? null,
        n1xFastOsMarker: input.n1xFastOsMarker ?? null,
        n1xPciGpu: input.n1xPciGpu ?? null,
        n1xWslProduct: input.n1xWslProduct ?? null,
        stationProfile: input.stationProfile ?? null,
        stationGb300PciGpu: input.stationGb300PciGpu ?? null,
        osId: input.osId ?? null,
        osVersionId: input.osVersionId ?? null,
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
      !input.isWsl
        ? "absent"
        : n1xWslStatus === "qualified"
          ? "present"
          : "absent",
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
      qualification("host.platform.dgx_station", stationStatus, ["host.platform.dgx_station"]),
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
