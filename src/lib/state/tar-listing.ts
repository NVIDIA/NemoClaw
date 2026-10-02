// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
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

function readTextLinesFromFile(filePath: string, onLine: (line: string) => void): void {
  const fd = openSync(filePath, "r");
  const decoder = new StringDecoder("utf8");
  const chunk = Buffer.alloc(TAR_LISTING_READ_CHUNK_BYTES);
  let pending = "";
  try {
    while (true) {
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

function tarExitStatus(result: ReturnType<typeof spawnSync>): number {
  return result.status ?? (result.error || result.signal ? 1 : 0);
}

export type TarArchiveSource = Buffer | { filePath: string };
export type TarListingSource = TarArchiveSource | { fileDescriptor: number };

function copyDescriptorToPrivateArchive(fileDescriptor: number, tempDir: string): string {
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
      const requested = Math.min(chunk.byteLength, source.size - position);
      const bytesRead = readSync(fileDescriptor, chunk, 0, requested, position);
      if (bytesRead === 0) throw new Error("tar archive descriptor became truncated");
      let written = 0;
      while (written < bytesRead) {
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

function openIndependentTarDescriptor(
  tarArchive: Exclude<TarListingSource, Buffer>,
  tempDir: string,
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
  return openSync(copyDescriptorToPrivateArchive(tarArchive.fileDescriptor, tempDir), "r");
}

export function runTarListing(
  tarArchive: TarListingSource,
  args: string[],
  failureLabel: string,
  onLine: (line: string) => void,
  timeoutMs = 60_000,
): string | null {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tar-listing-"));
  const listingPath = path.join(tempDir, "listing.txt");
  let listingFd: number | null = null;
  let archiveFd: number | null = null;
  try {
    listingFd = openSync(listingPath, "w");
    const result = Buffer.isBuffer(tarArchive)
      ? spawnSync("tar", args, {
          input: tarArchive,
          encoding: "utf-8",
          stdio: ["pipe", listingFd, "pipe"],
          timeout: timeoutMs,
          maxBuffer: TAR_LISTING_STDERR_MAX_BUFFER_BYTES,
        })
      : (() => {
          const descriptor = openIndependentTarDescriptor(tarArchive, tempDir);
          archiveFd = descriptor;
          return spawnSync("tar", args, {
            encoding: "utf-8",
            stdio: [descriptor, listingFd, "pipe"],
            timeout: timeoutMs,
            maxBuffer: TAR_LISTING_STDERR_MAX_BUFFER_BYTES,
          });
        })();
    closeSync(listingFd);
    listingFd = null;
    if (archiveFd !== null) {
      closeSync(archiveFd);
      archiveFd = null;
    }

    const status = tarExitStatus(result);
    if (status !== 0) {
      return `${failureLabel} failed (exit ${status}): ${(result.stderr || "").substring(0, 200)}`;
    }

    if (statSync(listingPath).size > TAR_LISTING_MAX_OUTPUT_BYTES) {
      return `${failureLabel} exceeded ${TAR_LISTING_MAX_OUTPUT_BYTES} bytes`;
    }

    readTextLinesFromFile(listingPath, onLine);
    return null;
  } catch (error) {
    return `${failureLabel} failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (listingFd !== null) closeSync(listingFd);
    if (archiveFd !== null) closeSync(archiveFd);
    rmSync(tempDir, { recursive: true, force: true });
  }
}
