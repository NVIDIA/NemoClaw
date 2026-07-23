// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import type { NvidiaPlatform } from "../inference/nim.js";
import type {
  QualificationStatus,
  ReadinessCapability,
  ReadinessEvidence,
  ReadinessFinding,
  ReadinessQualification,
  ReadinessState,
} from "./types.js";

const STATION_PRODUCT_PATTERN = /(?:^|[^A-Za-z0-9])Station(?:[^A-Za-z0-9]|$).*\bGB300\b/i;
const IDENTITY_FILE_MAX_BYTES = 4096;

export type StationProfile =
  | "generic-ubuntu"
  | "supported-dgx-os"
  | "supported-colossus-baseos"
  | "supported-ai-developer-tools"
  | "unsupported-dgx-os"
  | "unknown";

export interface PlatformIdentity {
  nvidiaPlatform?: NvidiaPlatform | null;
  productName?: string | null;
  stationProfile?: StationProfile | null;
  stationGb300PciGpu?: boolean | null;
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

export interface CollectPlatformIdentityOptions {
  readFile?: (filePath: string) => string;
  readdir?: (directory: string) => readonly string[];
  stat?: (filePath: string) => { isFile(): boolean; isSymbolicLink(): boolean; size: number };
  productNamePath?: string;
  stationReleasePath?: string;
  pciDevicesPath?: string;
}

function readOptional(
  readFile: (filePath: string) => string,
  filePath: string,
): string | undefined {
  try {
    const contents = readFile(filePath);
    if (Buffer.byteLength(contents) > IDENTITY_FILE_MAX_BYTES) return undefined;
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
  if (values.has("DGX_OTA_DATE")) return "unsupported-dgx-os";
  const identity = [
    values.get("DGX_PRETTY_NAME")?.[0],
    values.get("DGX_SWBUILD_VERSION")?.[0],
    values.get("DGX_SWBUILD_DATE")?.[0],
  ].join("|");
  if (identity === "NVIDIA DGX Server|7.5.0-GB300ws-GB200ws|2026-04-02-08-20-16") {
    return "supported-colossus-baseos";
  }
  if (identity === "NVIDIA DGX GB300WS|7.5.0|2026-06-16-11-48-10") {
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
    let matches = 0;
    for (const entry of readdir(pciDevicesPath).slice(0, 256)) {
      const devicePath = path.join(pciDevicesPath, entry);
      const vendor = readOptional(readFile, path.join(devicePath, "vendor"));
      const pciClass = readOptional(readFile, path.join(devicePath, "class"));
      if (vendor?.toLowerCase() === "0x10de" && /^0x03[0-9a-f]{4}$/iu.test(pciClass ?? "")) {
        matches += 1;
      }
    }
    return matches === 1;
  } catch {
    return undefined;
  }
}

export function collectPlatformIdentity(
  options: CollectPlatformIdentityOptions = {},
): PlatformIdentity {
  const readFile = options.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf8"));
  const readdir = options.readdir ?? ((directory: string) => fs.readdirSync(directory));
  const stat = options.stat ?? ((filePath: string) => fs.lstatSync(filePath));
  const productName = readOptional(
    readFile,
    options.productNamePath ?? "/sys/class/dmi/id/product_name",
  );
  const nvidiaPlatform = nvidiaPlatformFromProduct(productName);
  if (nvidiaPlatform !== "station") return { nvidiaPlatform, productName };

  const stationReleasePath = options.stationReleasePath ?? "/etc/dgx-release";
  let stationProfile: StationProfile = "generic-ubuntu";
  try {
    const metadata = stat(stationReleasePath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size <= 0 ||
      metadata.size > IDENTITY_FILE_MAX_BYTES
    ) {
      stationProfile = "unsupported-dgx-os";
    } else {
      stationProfile = parseStationRelease(readFile(stationReleasePath));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") stationProfile = "unknown";
  }
  return {
    nvidiaPlatform,
    productName,
    stationProfile,
    stationGb300PciGpu: stationHasGb300PciGpu(
      readFile,
      readdir,
      options.pciDevicesPath ?? "/sys/bus/pci/devices",
    ),
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
    ? STATION_PRODUCT_PATTERN.test(input.productName)
    : undefined;
  const knownStationProfile =
    input.stationProfile !== undefined &&
    input.stationProfile !== null &&
    input.stationProfile !== "unknown";
  const stationQualified =
    stationIdentity &&
    stationProduct === true &&
    input.stationGb300PciGpu === true &&
    knownStationProfile &&
    input.stationProfile !== "unsupported-dgx-os";
  const stationStatus: QualificationStatus = !stationIdentity
    ? "unknown"
    : stationProduct === undefined || input.stationGb300PciGpu === undefined || !knownStationProfile
      ? "unknown"
      : stationQualified
        ? "qualified"
        : "unqualified";
  const sparkQualified = input.nvidiaPlatform === "spark";
  const platformSupported =
    (linuxSupported || macosSupported) &&
    (!stationIdentity || stationQualified) &&
    (!input.isWsl || dockerDesktop);
  const evidence: ReadinessEvidence[] = [];
  if (input.productName || input.nvidiaPlatform || input.stationProfile) {
    evidence.push({
      id: "host.platform.identity",
      summary: "Bounded platform identity used for qualification.",
      details: {
        product: input.productName?.slice(0, 256) ?? null,
        nvidiaPlatform: input.nvidiaPlatform ?? null,
        stationProfile: input.stationProfile ?? null,
        stationGb300PciGpu: input.stationGb300PciGpu ?? null,
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
    capability("host.platform.dgx_spark", sparkQualified ? "present" : "absent"),
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
  }
  if (sparkQualified) {
    qualifications.push(
      qualification("host.platform.dgx_spark", "qualified", ["host.platform.dgx_spark"]),
    );
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
      severity: "warning",
      summary: "Native Docker Engine inside WSL is not the qualified Docker Desktop integration.",
      capabilityIds: ["host.platform.wsl_native_docker", "host.platform.supported"],
    });
  } else if (input.isWsl && input.dockerReachable && !dockerDesktop) {
    findings.push({
      id: "host.platform.wsl_runtime_inconclusive",
      severity: "warning",
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
  return { capabilities, qualifications, findings, evidence };
}
