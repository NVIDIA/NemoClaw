// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";

// runner.js is CJS — use require so we don't pull it into the TS build.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runCapture } = require("../../bin/lib/runner");

export type HostSupportStatus = "ok" | "warning" | "error";
export type HostSupportCode =
  | "SUPPORTED"
  | "NEAR_EOL"
  | "EOL"
  | "UNSUPPORTED_OS"
  | "UNKNOWN_VERSION";

export type HostSupportResult = {
  os: string;
  version: string;
  status: HostSupportStatus;
  code: HostSupportCode;
  message: string;
};

export interface OsReleaseInfo {
  id: string;
  versionId: string;
}

export interface CheckHostSupportOpts {
  platform?: NodeJS.Platform;
  osReleasePath?: string;
  readFileSyncImpl?: (path: string, encoding: BufferEncoding) => string;
  getMacosVersionImpl?: () => string;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseOsRelease(content: string): OsReleaseInfo {
  const lines = content.split("\n");
  let id = "";
  let versionId = "";

  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    const value = stripQuotes(line.slice(eq + 1));

    if (key === "ID") id = value.toLowerCase();
    if (key === "VERSION_ID") versionId = value;
  }

  return { id, versionId };
}

function parseUbuntuVersion(version: string): { major: number; minor: number } | null {
  const match = String(version).trim().match(/^(\d+)\.(\d+)/);
  if (!match) return null;

  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  if (isNaN(major) || isNaN(minor)) return null;

  return { major, minor };
}

export function classifyLinuxHost(id: string, versionId: string): HostSupportResult {
  if (!id) {
    return {
      os: "linux",
      version: versionId || "unknown",
      status: "warning",
      code: "UNKNOWN_VERSION",
      message: "Linux detected but distro/version could not be determined from /etc/os-release.",
    };
  }

  if (id !== "ubuntu") {
    return {
      os: id,
      version: versionId || "unknown",
      status: "warning",
      code: "UNSUPPORTED_OS",
      message: `${id} ${versionId || "unknown"} detected: recognized Linux distro, but explicit host support policy is currently defined for Ubuntu only.`,
    };
  }

  if (!versionId) {
    return {
      os: "ubuntu",
      version: "unknown",
      status: "warning",
      code: "UNKNOWN_VERSION",
      message: "Ubuntu detected but VERSION_ID is missing; support level could not be determined.",
    };
  }

  const parsed = parseUbuntuVersion(versionId);
  if (!parsed) {
    return {
      os: "ubuntu",
      version: versionId,
      status: "warning",
      code: "UNKNOWN_VERSION",
      message: `Ubuntu ${versionId} detected, but version format is unrecognized; support level could not be determined.`,
    };
  }

  const { major, minor } = parsed;
  const normalized = `${major}.${minor.toString().padStart(2, "0")}`;

  if ((major === 24 && minor === 4) || (major === 22 && minor === 4)) {
    return {
      os: "ubuntu",
      version: normalized,
      status: "ok",
      code: "SUPPORTED",
      message: `Ubuntu ${normalized} detected: supported.`,
    };
  }

  if (major === 20 && minor === 4) {
    return {
      os: "ubuntu",
      version: normalized,
      status: "warning",
      code: "NEAR_EOL",
      message: `Ubuntu ${normalized} detected: older host OS; upgrade is recommended.`,
    };
  }

  if (major < 20 || (major === 18 && minor <= 4)) {
    return {
      os: "ubuntu",
      version: normalized,
      status: "error",
      code: "EOL",
      message: `Ubuntu ${normalized} detected: unsupported or end-of-life host OS.`,
    };
  }

  return {
    os: "ubuntu",
    version: normalized,
    status: "warning",
    code: "UNSUPPORTED_OS",
    message: `Ubuntu ${normalized} detected: recognized host OS, but this version is outside the current explicit support policy.`,
  };
}

export function classifyMacosHost(version: string): HostSupportResult {
  if (!version || version === "unknown") {
    return {
      os: "macos",
      version: "unknown",
      status: "warning",
      code: "UNKNOWN_VERSION",
      message: "macOS detected but product version could not be determined; explicit support policy is not yet fully defined.",
    };
  }

  const major = version.split(".")[0] || version;
  return {
    os: "macos",
    version,
    status: "warning",
    code: "UNSUPPORTED_OS",
    message: `macOS ${major} detected: recognized host OS; explicit support policy not yet fully defined.`,
  };
}

function defaultGetMacosVersion(): string {
  const out = runCapture("sw_vers -productVersion", { ignoreError: true });
  return String(out || "").trim();
}

export function checkHostSupport(opts: CheckHostSupportOpts = {}): HostSupportResult {
  const platform = opts.platform || os.platform();
  const osReleasePath = opts.osReleasePath || "/etc/os-release";
  const readFileSyncImpl = opts.readFileSyncImpl || fs.readFileSync;
  const getMacosVersionImpl = opts.getMacosVersionImpl || defaultGetMacosVersion;

  if (platform === "linux") {
    try {
      const content = readFileSyncImpl(osReleasePath, "utf-8");
      const { id, versionId } = parseOsRelease(content);
      return classifyLinuxHost(id, versionId);
    } catch {
      return {
        os: "linux",
        version: "unknown",
        status: "warning",
        code: "UNKNOWN_VERSION",
        message: "Linux detected but /etc/os-release is unavailable; support level could not be determined.",
      };
    }
  }

  if (platform === "darwin") {
    const version = getMacosVersionImpl() || "unknown";
    return classifyMacosHost(version);
  }

  return {
    os: platform,
    version: "unknown",
    status: "error",
    code: "UNSUPPORTED_OS",
    message: `${platform} detected: unsupported host operating system for NemoClaw onboarding.`,
  };
}
