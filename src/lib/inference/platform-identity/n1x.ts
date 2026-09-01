// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

export const N1X_FASTOS_RELEASE_MAX_BYTES = 4096;
// Bound discovery so malformed sysfs state cannot create unbounded work.
const N1X_PCI_SCAN_MAX_DEVICES = 256;
const N1X_PCI_FIELD_MAX_BYTES = 64;

export interface N1xIdentityEvidence {
  candidate: boolean;
  fastOsMarker: boolean | undefined;
  fastOsPlatform?: "n1x" | "spark";
  pciGpu: boolean | undefined;
  qualified: boolean;
}

export interface N1xIdentityOptions {
  readFile?: (filePath: string) => string;
  readdir?: (directory: string) => readonly string[];
  openFile?: (filePath: string, flags: number) => number;
  statFileDescriptor?: (fileDescriptor: number) => {
    isFile(): boolean;
    isSymbolicLink(): boolean;
    size: number;
    uid: number;
    gid: number;
    mode: number;
  };
  readFileDescriptor?: (fileDescriptor: number, maxBytes: number) => string;
  closeFileDescriptor?: (fileDescriptor: number) => void;
  fastOsReleasePath?: string;
  pciDevicesPath?: string;
}

export function isTrustedN1xFastOsMarker(metadata: {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  size: number;
  uid: number;
  gid: number;
  mode: number;
}): boolean {
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.size > 0 &&
    metadata.size <= N1X_FASTOS_RELEASE_MAX_BYTES &&
    metadata.uid === 0 &&
    metadata.gid === 0 &&
    (metadata.mode & 0o022) === 0
  );
}

export function parseTrustedFastOsPlatform(contents: string): "n1x" | "spark" | undefined {
  if (
    Buffer.byteLength(contents, "utf8") > N1X_FASTOS_RELEASE_MAX_BYTES ||
    contents.includes("\0") ||
    contents.includes("\r")
  ) {
    return undefined;
  }
  let platform: "n1x" | "spark" | undefined;
  for (const line of contents.split("\n")) {
    if (!line.startsWith("NAME=")) continue;
    if (platform !== undefined) return undefined;
    if (line === 'NAME="N1x FASTOS"') platform = "n1x";
    else if (line === 'NAME="DGX SPARK FASTOS"') platform = "spark";
    else return undefined;
  }
  return platform;
}

export function isN1xFastOsRelease(contents: string): boolean {
  return parseTrustedFastOsPlatform(contents) === "n1x";
}

export function isN1xPciDisplayDevice(
  vendor: string | undefined,
  device: string | undefined,
  pciClass: string | undefined,
): boolean {
  return (
    vendor?.toLowerCase() === "0x10de" &&
    device?.toLowerCase() === "0x2e2a" &&
    /^0x03[0-9a-f]{4}$/i.test(pciClass ?? "")
  );
}

function readOpenedFile(fileDescriptor: number, maxBytes: number): string {
  const contents = Buffer.alloc(maxBytes + 1);
  const bytesRead = fs.readSync(fileDescriptor, contents, 0, contents.length, 0);
  if (bytesRead > maxBytes) throw new Error("identity file exceeds the size limit");
  return contents.toString("utf8", 0, bytesRead);
}

function readBoundedOptional(
  readFile: (filePath: string) => string,
  filePath: string,
): string | undefined {
  try {
    const contents = readFile(filePath);
    if (Buffer.byteLength(contents, "utf8") > N1X_PCI_FIELD_MAX_BYTES) return undefined;
    return contents.replace(/\0/g, "").trim() || undefined;
  } catch {
    return undefined;
  }
}

function collectN1xPciGpu(
  readFile: (filePath: string) => string,
  readdir: (directory: string) => readonly string[],
  pciDevicesPath: string,
): boolean | undefined {
  try {
    const entries = readdir(pciDevicesPath);
    let incompleteEvidence = entries.length > N1X_PCI_SCAN_MAX_DEVICES;
    for (const entry of entries.slice(0, N1X_PCI_SCAN_MAX_DEVICES)) {
      const devicePath = path.join(pciDevicesPath, entry);
      const vendor = readBoundedOptional(readFile, path.join(devicePath, "vendor"));
      const device = readBoundedOptional(readFile, path.join(devicePath, "device"));
      const pciClass = readBoundedOptional(readFile, path.join(devicePath, "class"));
      if (isN1xPciDisplayDevice(vendor, device, pciClass)) return true;
      if (vendor === undefined || device === undefined || pciClass === undefined) {
        incompleteEvidence = true;
      }
    }
    return incompleteEvidence ? undefined : false;
  } catch {
    return undefined;
  }
}

export function collectN1xIdentity(options: N1xIdentityOptions = {}): N1xIdentityEvidence {
  const readFile = options.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf8"));
  const readdir = options.readdir ?? ((directory: string) => fs.readdirSync(directory));
  const openFile = options.openFile ?? ((filePath, flags) => fs.openSync(filePath, flags));
  const statFileDescriptor =
    options.statFileDescriptor ?? ((fileDescriptor) => fs.fstatSync(fileDescriptor));
  const readFileDescriptor = options.readFileDescriptor ?? readOpenedFile;
  const closeFileDescriptor =
    options.closeFileDescriptor ?? ((fileDescriptor) => fs.closeSync(fileDescriptor));

  let candidate = false;
  let fastOsMarker: boolean | undefined;
  let fastOsPlatform: "n1x" | "spark" | undefined;
  try {
    const fileDescriptor = openFile(
      options.fastOsReleasePath ?? "/etc/fastos-release",
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    candidate = true;
    try {
      const metadata = statFileDescriptor(fileDescriptor);
      if (isTrustedN1xFastOsMarker(metadata)) {
        fastOsPlatform = parseTrustedFastOsPlatform(
          readFileDescriptor(fileDescriptor, N1X_FASTOS_RELEASE_MAX_BYTES),
        );
        fastOsMarker = fastOsPlatform === "n1x";
      } else {
        fastOsMarker = false;
      }
    } finally {
      closeFileDescriptor(fileDescriptor);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      fastOsMarker = false;
    } else if (code === "ELOOP" || code === "EMLINK") {
      candidate = true;
      fastOsMarker = false;
    } else {
      candidate = true;
      fastOsMarker = undefined;
    }
  }

  if (fastOsMarker !== true) {
    return { candidate, fastOsMarker, fastOsPlatform, pciGpu: undefined, qualified: false };
  }
  const pciGpu = collectN1xPciGpu(
    readFile,
    readdir,
    options.pciDevicesPath ?? "/sys/bus/pci/devices",
  );
  return { candidate, fastOsMarker, fastOsPlatform, pciGpu, qualified: pciGpu === true };
}
