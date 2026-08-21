// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type FileNumber = bigint | number;

export interface LaunchdPlistStat {
  ctimeNs: FileNumber;
  dev: FileNumber;
  ino: FileNumber;
  isFile: () => boolean;
  mode: FileNumber;
  mtimeNs: FileNumber;
  nlink: FileNumber;
  size: FileNumber;
  uid: FileNumber;
}

export interface LaunchdPlistPathStat extends LaunchdPlistStat {
  isSymbolicLink: () => boolean;
}

export interface LaunchdPlistFileIdentityOptions {
  closeSync?: (fileDescriptor: number) => void;
  effectivePath: string;
  fstatSync?: (fileDescriptor: number) => LaunchdPlistStat;
  formulaPath: string;
  getuid?: () => number;
  lstatSync?: (filePath: string) => LaunchdPlistPathStat;
  openSync?: (filePath: string, flags: number) => number;
  readSync?: (
    fileDescriptor: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: null,
  ) => number;
}

export interface LaunchdPlistDescriptorIdentity {
  device: string;
  inode: string;
}

export interface LaunchdPlistFileIdentity {
  contentSha256: string;
  effective: LaunchdPlistDescriptorIdentity & { source: "formula" | "loaded" };
  formula: LaunchdPlistDescriptorIdentity;
}

interface StableFileRead {
  bytes: Buffer;
  descriptor: LaunchdPlistDescriptorIdentity;
}

interface StableFileMetadata {
  descriptor: LaunchdPlistDescriptorIdentity;
  fingerprint: string;
  size: number;
}

type PlistValue = boolean | string | PlistValue[] | Map<string, PlistValue>;

const MAX_PLIST_BYTES = 64 * 1024;
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';
const PLIST_DOCTYPE =
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">';
const SERVICE_LABEL = "homebrew.mxcl.openshell";
const SESSION_TYPES = ["Aqua", "Background", "LoginWindow", "StandardIO", "System"];

class PlistReader {
  private cursor = 0;

  constructor(private readonly source: string) {}

  atEnd(): boolean {
    this.skipWhitespace();
    return this.cursor === this.source.length;
  }

  consume(literal: string): boolean {
    this.skipWhitespace();
    if (!this.source.startsWith(literal, this.cursor)) return false;
    this.cursor += literal.length;
    return true;
  }

  readValue(depth = 0): PlistValue | null {
    if (depth > 8) return null;
    if (this.consume("<true/>")) return true;
    if (this.consume("<false/>")) return false;
    const stringValue = this.readTextElement("string");
    if (stringValue !== null) return stringValue;
    if (this.consume("<array>")) {
      const values: PlistValue[] = [];
      while (!this.consume("</array>")) {
        const value = this.readValue(depth + 1);
        if (value === null) return null;
        values.push(value);
      }
      return values;
    }
    if (!this.consume("<dict>")) return null;
    const values = new Map<string, PlistValue>();
    while (!this.consume("</dict>")) {
      const key = this.readTextElement("key");
      if (key === null || key.length === 0 || values.has(key)) return null;
      const value = this.readValue(depth + 1);
      if (value === null) return null;
      values.set(key, value);
    }
    return values;
  }

  private readTextElement(element: "key" | "string"): string | null {
    const start = `<${element}>`;
    const end = `</${element}>`;
    this.skipWhitespace();
    if (!this.source.startsWith(start, this.cursor)) return null;
    const valueStart = this.cursor + start.length;
    const valueEnd = this.source.indexOf(end, valueStart);
    if (valueEnd === -1 || this.source.slice(valueStart, valueEnd).includes("<")) return null;
    this.cursor = valueEnd + end.length;
    return this.source.slice(valueStart, valueEnd);
  }

  private skipWhitespace(): void {
    while (/\s/u.test(this.source[this.cursor] ?? "")) this.cursor += 1;
  }
}

function validFileNumber(value: FileNumber): boolean {
  return typeof value === "bigint" ? value >= 0n : Number.isSafeInteger(value) && value >= 0;
}

function fileNumberToBigInt(value: FileNumber): bigint | null {
  return validFileNumber(value) ? BigInt(value) : null;
}

function stableFileMetadata(stat: LaunchdPlistStat, currentUid: number): StableFileMetadata | null {
  const ctimeNs = fileNumberToBigInt(stat.ctimeNs);
  const device = fileNumberToBigInt(stat.dev);
  const inode = fileNumberToBigInt(stat.ino);
  const mode = fileNumberToBigInt(stat.mode);
  const mtimeNs = fileNumberToBigInt(stat.mtimeNs);
  const linkCount = fileNumberToBigInt(stat.nlink);
  const size = fileNumberToBigInt(stat.size);
  const owner = fileNumberToBigInt(stat.uid);
  if (
    !stat.isFile() ||
    ctimeNs === null ||
    device === null ||
    inode === null ||
    mode === null ||
    mtimeNs === null ||
    linkCount === null ||
    linkCount < 1n ||
    size === null ||
    size > BigInt(MAX_PLIST_BYTES) ||
    owner !== BigInt(currentUid) ||
    (mode & 0o022n) !== 0n
  ) {
    return null;
  }
  return {
    descriptor: { device: String(device), inode: String(inode) },
    fingerprint: [ctimeNs, device, inode, mode, mtimeNs, linkCount, size, owner].join(":"),
    size: Number(size),
  };
}

function sameDescriptorIdentity(
  first: LaunchdPlistDescriptorIdentity,
  second: LaunchdPlistDescriptorIdentity,
): boolean {
  return first.device === second.device && first.inode === second.inode;
}

function sameStableFileMetadata(first: StableFileMetadata, second: StableFileMetadata): boolean {
  return first.fingerprint === second.fingerprint;
}

function defaultFstatSync(fileDescriptor: number): LaunchdPlistStat {
  return fs.fstatSync(fileDescriptor, { bigint: true });
}

function defaultLstatSync(filePath: string): LaunchdPlistPathStat {
  return fs.lstatSync(filePath, { bigint: true });
}

function readExactBytes(
  fileDescriptor: number,
  size: number,
  readSync: NonNullable<LaunchdPlistFileIdentityOptions["readSync"]>,
): Buffer | null {
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fileDescriptor, bytes, offset, size - offset, null);
    if (!Number.isSafeInteger(count) || count <= 0 || count > size - offset) return null;
    offset += count;
  }
  return bytes;
}

function sameStringArray(value: PlistValue | undefined, expected: string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function isCanonicalOpenShellServicePlist(bytes: Buffer, formulaPath: string): boolean {
  if (bytes.length === 0 || bytes.length > MAX_PLIST_BYTES) return false;
  const source = bytes.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(bytes)) return false;

  const reader = new PlistReader(source);
  reader.consume(XML_DECLARATION);
  reader.consume(PLIST_DOCTYPE);
  if (!reader.consume('<plist version="1.0">')) return false;
  const plist = reader.readValue();
  if (!reader.consume("</plist>") || !reader.atEnd() || !(plist instanceof Map)) return false;

  const formulaPrefix = path.posix.dirname(formulaPath);
  if (
    path.posix.basename(formulaPath) !== `${SERVICE_LABEL}.plist` ||
    path.posix.basename(formulaPrefix) !== "openshell" ||
    path.posix.basename(path.posix.dirname(formulaPrefix)) !== "opt"
  ) {
    return false;
  }
  const homebrewPrefix = path.posix.dirname(path.posix.dirname(formulaPrefix));
  const keepAlive = plist.get("KeepAlive");
  if (!(keepAlive instanceof Map)) return false;

  return (
    plist.size === 7 &&
    keepAlive.size === 1 &&
    keepAlive.get("SuccessfulExit") === false &&
    plist.get("Label") === SERVICE_LABEL &&
    sameStringArray(plist.get("LimitLoadToSessionType"), SESSION_TYPES) &&
    sameStringArray(plist.get("ProgramArguments"), [
      path.posix.join(formulaPrefix, "libexec", "openshell-gateway-homebrew-service"),
    ]) &&
    plist.get("RunAtLoad") === true &&
    plist.get("StandardErrorPath") ===
      path.posix.join(homebrewPrefix, "var", "log", "openshell", "openshell-gateway.err.log") &&
    plist.get("StandardOutPath") ===
      path.posix.join(homebrewPrefix, "var", "log", "openshell", "openshell-gateway.out.log")
  );
}

function readStableFile(
  filePath: string,
  currentUid: number,
  closeSync: (fileDescriptor: number) => void,
  fstatSync: (fileDescriptor: number) => LaunchdPlistStat,
  lstatSync: (filePath: string) => LaunchdPlistPathStat,
  openSync: (filePath: string, flags: number) => number,
  readSync: NonNullable<LaunchdPlistFileIdentityOptions["readSync"]>,
): StableFileRead | null {
  let fileDescriptor: number;
  try {
    fileDescriptor = openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
    );
  } catch {
    return null;
  }
  let result: StableFileRead | null = null;
  try {
    const before = stableFileMetadata(fstatSync(fileDescriptor), currentUid);
    const bytes = before ? readExactBytes(fileDescriptor, before.size, readSync) : null;
    const after = bytes ? stableFileMetadata(fstatSync(fileDescriptor), currentUid) : null;
    const pathStat = after ? lstatSync(filePath) : null;
    const finalPath =
      pathStat && !pathStat.isSymbolicLink() ? stableFileMetadata(pathStat, currentUid) : null;
    result =
      before &&
      bytes &&
      after &&
      finalPath &&
      sameStableFileMetadata(before, after) &&
      sameStableFileMetadata(after, finalPath) &&
      bytes.length > 0
        ? { bytes, descriptor: after.descriptor }
        : null;
  } catch {
    result = null;
  }
  try {
    closeSync(fileDescriptor);
  } catch {
    result = null;
  }
  return result;
}

/** Inspect trusted launchd plist files without returning their contents or read errors. */
export function inspectLaunchdPlistFileIdentity({
  closeSync = fs.closeSync,
  effectivePath,
  fstatSync = defaultFstatSync,
  formulaPath,
  getuid = process.getuid as (() => number) | undefined,
  lstatSync = defaultLstatSync,
  openSync = fs.openSync,
  readSync = fs.readSync,
}: LaunchdPlistFileIdentityOptions): LaunchdPlistFileIdentity | null {
  try {
    if (typeof getuid !== "function") return null;
    const currentUid = getuid();
    if (!Number.isSafeInteger(currentUid) || currentUid < 0) return null;
    const formula = readStableFile(
      formulaPath,
      currentUid,
      closeSync,
      fstatSync,
      lstatSync,
      openSync,
      readSync,
    );
    if (!formula) return null;
    const effective =
      effectivePath === formulaPath
        ? formula
        : readStableFile(
            effectivePath,
            currentUid,
            closeSync,
            fstatSync,
            lstatSync,
            openSync,
            readSync,
          );
    if (
      !effective ||
      !effective.bytes.equals(formula.bytes) ||
      !isCanonicalOpenShellServicePlist(formula.bytes, formulaPath)
    ) {
      return null;
    }
    return {
      contentSha256: createHash("sha256").update(formula.bytes).digest("hex"),
      effective: {
        ...effective.descriptor,
        source: effectivePath === formulaPath ? "formula" : "loaded",
      },
      formula: formula.descriptor,
    };
  } catch {
    return null;
  }
}

/** Compare every recorded launchd plist identity across lifecycle checks. */
export function sameLaunchdPlistLifecycleIdentity(
  first: LaunchdPlistFileIdentity,
  second: LaunchdPlistFileIdentity,
): boolean {
  if (
    first.contentSha256 !== second.contentSha256 ||
    !sameDescriptorIdentity(first.formula, second.formula)
  ) {
    return false;
  }
  return (
    first.effective.source === second.effective.source &&
    sameDescriptorIdentity(first.effective, second.effective)
  );
}
