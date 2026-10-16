// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

// Compatibility boundary: existing backups are raw tar streams, so validation
// still shells out to system tar. Route listings through a bounded temp file
// instead of child-process stdout buffers; remove this path when backup
// validation moves to a native streaming tar parser or indexed manifest format.
const TAR_LISTING_STDERR_MAX_BUFFER_BYTES = 1024 * 1024;
const TAR_LISTING_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const TAR_LISTING_READ_CHUNK_BYTES = 64 * 1024;
const TAR_LISTING_MAX_LINE_CHARS = 1024 * 1024;
export const TAR_BLOCK_BYTES = 512;
const TAR_METADATA_MAX_BYTES = 1024 * 1024;
const TAR_TOTAL_METADATA_MAX_BYTES = 4 * 1024 * 1024;
const TAR_MAX_INSPECTED_HEADERS = 65_536;
let unsupportedLiteralQuotingExecutable: string | null = null;

/** Resolve the active tar executable and its filesystem identity from PATH. */
function resolveTarExecutable(): { command: string; identity: string | null } {
  const pathEnv = process.env.PATH ?? "";
  for (const entry of pathEnv.split(path.delimiter)) {
    const candidate = path.resolve(entry || ".", "tar");
    try {
      accessSync(candidate, constants.X_OK);
      const stat = statSync(candidate);
      if (!stat.isFile()) continue;
      const realPath = realpathSync(candidate);
      return {
        command: realPath,
        identity: `${realPath}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
      };
    } catch {
      // Continue searching PATH entries when a candidate is missing or not executable.
    }
  }
  return { command: "tar", identity: null };
}

/** Return true when an archive-listing deadline is invalid or has already passed. */
function listingDeadlineExpired(deadlineMs: number): boolean {
  return !Number.isFinite(deadlineMs) || Date.now() >= deadlineMs;
}

/** Compute the remaining positive timeout budget before deadlineMs, bounded by maximumMs. */
function remainingListingTimeoutMs(deadlineMs: number, maximumMs: number): number | null {
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(maximumMs) || maximumMs <= 0) return null;
  const remainingMs = Math.floor(deadlineMs - Date.now());
  return remainingMs > 0 ? Math.min(maximumMs, remainingMs) : null;
}

/** Stream UTF-8 lines from the bounded listing file without buffering the whole output in memory. */
function readTextLinesFromFile(
  filePath: string,
  onLine: (line: string) => void,
  deadlineMs: number,
): void {
  const fd = openSync(filePath, "r");
  const decoder = new StringDecoder("utf8");
  const chunk = Buffer.alloc(TAR_LISTING_READ_CHUNK_BYTES);
  let pending = "";
  try {
    while (true) {
      if (listingDeadlineExpired(deadlineMs)) {
        throw new Error("archive listing timed out");
      }
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      pending += decoder.write(chunk.subarray(0, bytesRead));
      if (pending.length > TAR_LISTING_MAX_LINE_CHARS) {
        throw new Error("tar listing line exceeds supported length");
      }
      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = pending.slice(0, newlineIndex).replace(/\r$/, "");
        if (line.length > 0) onLine(line);
        pending = pending.slice(newlineIndex + 1);
        newlineIndex = pending.indexOf("\n");
      }
    }
    pending += decoder.end();
    if (pending.length > TAR_LISTING_MAX_LINE_CHARS) {
      throw new Error("tar listing line exceeds supported length");
    }
    const lastLine = pending.replace(/\r$/, "");
    if (lastLine.length > 0) onLine(lastLine);
  } finally {
    closeSync(fd);
  }
}

/** Normalize spawnSync exit outcomes so signal or spawn errors fail closed as non-zero. */
function tarExitStatus(result: ReturnType<typeof spawnSync>): number {
  return result.status ?? (result.error || result.signal ? 1 : 0);
}

/** Detect tar implementations such as bsdtar that reject GNU --quoting-style=literal. */
function isUnsupportedQuotingStyle(result: SpawnSyncReturns<string>): boolean {
  return tarExitStatus(result) !== 0 && /quoting-style/iu.test(result.stderr || "");
}

/** Return true when a header value contains a line break (CR or LF), which would split a line-delimited listing. */
function hasHeaderLineBreak(value: string): boolean {
  return value.includes("\n") || value.includes("\r");
}

/** Read a NUL-padded UTF-8 field from a 512-byte ustar header block. */
export function tarHeaderString(header: Buffer, start: number, length: number): string {
  const end = header.indexOf(0, start);
  return header
    .subarray(start, end >= start && end < start + length ? end : start + length)
    .toString("utf8");
}

/** Decode an octal or base-256 tar member size field. */
export function tarHeaderSize(header: Buffer): number | null {
  const field = header.subarray(124, 136);
  if ((field[0] ?? 0) & 0x80) {
    let value = BigInt((field[0] ?? 0) & 0x7f);
    for (const byte of field.subarray(1)) value = (value << 8n) | BigInt(byte);
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  }
  const text = field.toString("ascii").replace(/\0.*$/su, "").trim();
  if (!/^[0-7]*$/u.test(text)) return null;
  const value = text.length === 0 ? 0 : Number.parseInt(text, 8);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

type TarHeaderLineBreakInspection =
  | "clean"
  | "line-break"
  | "uninspectable"
  | "limit-exceeded"
  | "timeout";

/** Detect a PAX path, linkpath, or GNU.sparse.name record that contains a line break; report malformed records as uninspectable. */
function inspectPaxHeaderForLineBreaks(payload: Buffer): TarHeaderLineBreakInspection {
  let cursor = 0;
  while (cursor < payload.byteLength) {
    const separator = payload.indexOf(0x20, cursor);
    if (separator < 0) return "uninspectable";
    const length = Number.parseInt(payload.subarray(cursor, separator).toString("ascii"), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || cursor + length > payload.byteLength) {
      return "uninspectable";
    }
    if (payload[cursor + length - 1] !== 0x0a) return "uninspectable";
    const record = payload.subarray(separator + 1, cursor + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals <= 0) return "uninspectable";
    const key = record.slice(0, equals);
    if (
      (key === "path" || key === "linkpath" || key === "GNU.sparse.name") &&
      hasHeaderLineBreak(record.slice(equals + 1))
    ) {
      return "line-break";
    }
    cursor += length;
  }
  return "clean";
}

/**
 * Inspect every tar header before tar lists the archive, within the header,
 * metadata, and deadline budget. Return a failure when a member path or link
 * target contains a line break, when a header or its metadata is malformed or
 * exceeds TAR_METADATA_MAX_BYTES, or when cumulative inspection exceeds the
 * header-count, metadata-byte, or deadline budget.
 */
function inspectArchiveHeadersForLineBreaks(
  readRange: (position: number, length: number) => Buffer | "timeout" | null,
  archiveSize: number,
  deadlineMs: number,
): TarHeaderLineBreakInspection {
  let offset = 0;
  let inspectedHeaders = 0;
  let inspectedMetadataBytes = 0;
  while (offset < archiveSize) {
    if (listingDeadlineExpired(deadlineMs)) return "timeout";
    if (offset + TAR_BLOCK_BYTES > archiveSize) return "uninspectable";
    const header = readRange(offset, TAR_BLOCK_BYTES);
    if (header === "timeout") return "timeout";
    if (!header) return "uninspectable";
    if (header.every((byte) => byte === 0)) return "clean";
    inspectedHeaders += 1;
    if (inspectedHeaders > TAR_MAX_INSPECTED_HEADERS) return "limit-exceeded";
    if (
      hasHeaderLineBreak(tarHeaderString(header, 0, 100)) ||
      hasHeaderLineBreak(tarHeaderString(header, 157, 100)) ||
      hasHeaderLineBreak(tarHeaderString(header, 345, 155))
    ) {
      return "line-break";
    }
    const size = tarHeaderSize(header);
    if (size === null) return "uninspectable";
    const dataOffset = offset + TAR_BLOCK_BYTES;
    const nextOffset = dataOffset + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    if (!Number.isSafeInteger(nextOffset) || nextOffset > archiveSize) return "uninspectable";
    const type = String.fromCharCode(header[156] ?? 0);
    if (type === "x" || type === "g" || type === "L" || type === "K") {
      if (size > TAR_METADATA_MAX_BYTES) return "uninspectable";
      inspectedMetadataBytes += size;
      if (inspectedMetadataBytes > TAR_TOTAL_METADATA_MAX_BYTES) return "limit-exceeded";
      const metadata = readRange(dataOffset, size);
      if (metadata === "timeout") return "timeout";
      if (!metadata) return "uninspectable";
      if (type === "x" || type === "g") {
        const paxResult = inspectPaxHeaderForLineBreaks(metadata);
        if (paxResult !== "clean") return paxResult;
      } else {
        const longValue = metadata.toString("utf8").replace(/\0.*$/su, "");
        if (!longValue) return "uninspectable";
        if (hasHeaderLineBreak(longValue)) return "line-break";
      }
    }
    offset = nextOffset;
  }
  return "clean";
}

/** Read a byte range at a fixed position without moving the file offset. Return null at EOF. */
export function readArchiveRange(
  descriptor: number,
  position: number,
  length: number,
): Buffer | null {
  const result = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = readSync(descriptor, result, read, length - read, position + read);
    if (count === 0) return null;
    read += count;
  }
  return result;
}

export type TarArchiveSource = Buffer | { filePath: string };
export type TarListingSource = TarArchiveSource | { fileDescriptor: number };

/** Stage a caller-supplied file descriptor into a private temporary archive at offset 0. */
function copyDescriptorToPrivateArchive(
  fileDescriptor: number,
  tempDir: string,
  deadlineMs: number,
): string {
  const source = fstatSync(fileDescriptor);
  if (!source.isFile() || !Number.isSafeInteger(source.size) || source.size < 0) {
    throw new Error("tar archive descriptor must reference a regular file");
  }
  const archivePath = path.join(tempDir, "archive.tar");
  const archiveFd = openSync(archivePath, "wx", 0o600);
  const chunk = Buffer.alloc(TAR_LISTING_READ_CHUNK_BYTES);
  let position = 0;
  try {
    while (position < source.size) {
      if (listingDeadlineExpired(deadlineMs)) {
        throw new Error("archive listing timed out");
      }
      const requested = Math.min(chunk.byteLength, source.size - position);
      const bytesRead = readSync(fileDescriptor, chunk, 0, requested, position);
      if (bytesRead === 0) throw new Error("tar archive descriptor became truncated");
      let written = 0;
      while (written < bytesRead) {
        if (listingDeadlineExpired(deadlineMs)) {
          throw new Error("archive listing timed out");
        }
        const count = writeSync(archiveFd, chunk, written, bytesRead - written, position + written);
        if (count === 0) throw new Error("could not stage tar archive descriptor");
        written += count;
      }
      position += bytesRead;
    }
  } finally {
    closeSync(archiveFd);
  }
  return archivePath;
}

/** Open a descriptor at offset 0 so repeated tar passes do not share a consumed file position. */
function openIndependentTarDescriptor(
  tarArchive: Exclude<TarListingSource, Buffer>,
  tempDir: string,
  stagedArchivePath: { current: string | null },
  deadlineMs: number,
) {
  if ("filePath" in tarArchive) return openSync(tarArchive.filePath, "r");
  // Linux reopens the underlying inode with an independent file offset, even
  // after its original pathname is unlinked. Other platforms' /dev/fd clones
  // share the offset, so use a private positional copy there instead.
  if (process.platform === "linux") {
    try {
      return openSync(`/proc/self/fd/${tarArchive.fileDescriptor}`, "r");
    } catch {
      // Fall back for Linux environments without procfs mounted.
    }
  }
  if (stagedArchivePath.current === null) {
    stagedArchivePath.current = copyDescriptorToPrivateArchive(
      tarArchive.fileDescriptor,
      tempDir,
      deadlineMs,
    );
  }
  return openSync(stagedArchivePath.current, "r");
}

/** Run one tar listing pass into listingPath, closing descriptors before returning. */
function spawnTarListingPass(
  tarCommand: string,
  tarArchive: TarListingSource,
  tempDir: string,
  listingPath: string,
  stagedArchivePath: { current: string | null },
  args: string[],
  timeoutMs: number,
  deadlineMs: number,
): SpawnSyncReturns<string> {
  let listingFd: number | null = null;
  let archiveFd: number | null = null;
  try {
    listingFd = openSync(listingPath, "w");
    if (Buffer.isBuffer(tarArchive)) {
      return spawnSync(tarCommand, args, {
        input: tarArchive,
        encoding: "utf-8",
        stdio: ["pipe", listingFd, "pipe"],
        timeout: timeoutMs,
        maxBuffer: TAR_LISTING_STDERR_MAX_BUFFER_BYTES,
      });
    }
    archiveFd = openIndependentTarDescriptor(tarArchive, tempDir, stagedArchivePath, deadlineMs);
    return spawnSync(tarCommand, args, {
      encoding: "utf-8",
      stdio: [archiveFd, listingFd, "pipe"],
      timeout: timeoutMs,
      maxBuffer: TAR_LISTING_STDERR_MAX_BUFFER_BYTES,
    });
  } finally {
    if (listingFd !== null) closeSync(listingFd);
    if (archiveFd !== null) closeSync(archiveFd);
  }
}

/**
 * List tar entries through a temporary file so large archives do not overflow
 * spawnSync buffers. Reject archives whose member paths or link targets contain
 * a line break before tar runs. With --quoting-style=literal, GNU tar lists names
 * without escapes. When tar rejects that option (for example, bsdtar), listing
 * keeps tar's default escaping; members that NemoClaw then extracts by name fail
 * closed.
 */
export function runTarListing(
  tarArchive: TarListingSource,
  args: string[],
  failureLabel: string,
  onLine: (line: string) => void,
  timeoutMs = 60_000,
  deadlineMs?: number,
): string | null {
  const nowMs = Date.now();
  const listingDeadlineMs =
    deadlineMs === undefined ? nowMs + timeoutMs : Math.min(nowMs + timeoutMs, deadlineMs);
  if (listingDeadlineExpired(listingDeadlineMs)) {
    return `${failureLabel} failed: archive listing timed out`;
  }
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tar-listing-"));
  const listingPath = path.join(tempDir, "listing.txt");
  const stagedArchivePath = { current: null as string | null };
  let headerFd: number | null = null;
  try {
    const headerInspection = Buffer.isBuffer(tarArchive)
      ? inspectArchiveHeadersForLineBreaks(
          (position, length) =>
            listingDeadlineExpired(listingDeadlineMs)
              ? "timeout"
              : position + length <= tarArchive.byteLength
                ? tarArchive.subarray(position, position + length)
                : null,
          tarArchive.byteLength,
          listingDeadlineMs,
        )
      : (() => {
          headerFd = openIndependentTarDescriptor(
            tarArchive,
            tempDir,
            stagedArchivePath,
            listingDeadlineMs,
          );
          const size = fstatSync(headerFd).size;
          return inspectArchiveHeadersForLineBreaks(
            (position, length) =>
              listingDeadlineExpired(listingDeadlineMs)
                ? "timeout"
                : readArchiveRange(headerFd!, position, length),
            size,
            listingDeadlineMs,
          );
        })();
    if (headerFd !== null) {
      closeSync(headerFd);
      headerFd = null;
    }
    if (headerInspection === "line-break") {
      return `${failureLabel} failed: archive entry contains a line break`;
    }
    if (headerInspection === "limit-exceeded") {
      return `${failureLabel} failed: archive header inspection exceeded the header-count or metadata-byte limit`;
    }
    if (headerInspection === "timeout") {
      return `${failureLabel} failed: archive header inspection timed out`;
    }
    if (headerInspection === "uninspectable") {
      return `${failureLabel} failed: archive header cannot be inspected for line breaks`;
    }

    const tarExecutable = resolveTarExecutable();
    const tryLiteralQuoting =
      tarExecutable.identity === null ||
      unsupportedLiteralQuotingExecutable !== tarExecutable.identity;
    const initialTimeoutMs = remainingListingTimeoutMs(listingDeadlineMs, timeoutMs);
    if (initialTimeoutMs === null) {
      return `${failureLabel} failed: archive listing timed out`;
    }
    let result = spawnTarListingPass(
      tarExecutable.command,
      tarArchive,
      tempDir,
      listingPath,
      stagedArchivePath,
      tryLiteralQuoting ? ["--quoting-style=literal", ...args] : args,
      initialTimeoutMs,
      listingDeadlineMs,
    );
    if (tryLiteralQuoting && isUnsupportedQuotingStyle(result)) {
      unsupportedLiteralQuotingExecutable = tarExecutable.identity;
      const fallbackTimeoutMs = remainingListingTimeoutMs(listingDeadlineMs, timeoutMs);
      if (fallbackTimeoutMs === null) {
        return `${failureLabel} failed: archive listing timed out`;
      }
      result = spawnTarListingPass(
        tarExecutable.command,
        tarArchive,
        tempDir,
        listingPath,
        stagedArchivePath,
        args,
        fallbackTimeoutMs,
        listingDeadlineMs,
      );
    }

    const status = tarExitStatus(result);
    if (status !== 0) {
      return `${failureLabel} failed (exit ${status}): ${(result.stderr || "").substring(0, 200)}`;
    }

    if (statSync(listingPath).size > TAR_LISTING_MAX_OUTPUT_BYTES) {
      return `${failureLabel} exceeded ${TAR_LISTING_MAX_OUTPUT_BYTES} bytes`;
    }

    readTextLinesFromFile(listingPath, onLine, listingDeadlineMs);
    return null;
  } catch (error) {
    return `${failureLabel} failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (headerFd !== null) closeSync(headerFd);
    rmSync(tempDir, { recursive: true, force: true });
  }
}
