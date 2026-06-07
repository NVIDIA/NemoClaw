// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
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

export function runTarListing(
  tarBuffer: Buffer,
  args: string[],
  failureLabel: string,
  onLine: (line: string) => void,
): string | null {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tar-listing-"));
  const listingPath = path.join(tempDir, "listing.txt");
  let listingFd: number | null = null;
  try {
    listingFd = openSync(listingPath, "w");
    const result = spawnSync("tar", args, {
      input: tarBuffer,
      encoding: "utf-8",
      stdio: ["pipe", listingFd, "pipe"],
      timeout: 60000,
      maxBuffer: TAR_LISTING_STDERR_MAX_BUFFER_BYTES,
    });
    closeSync(listingFd);
    listingFd = null;

    const status = tarExitStatus(result);
    if (status !== 0) {
      return `${failureLabel} failed (exit ${status}): ${(result.stderr || "").substring(0, 200)}`;
    }

    const listingSize = statSync(listingPath).size;
    if (listingSize > TAR_LISTING_MAX_OUTPUT_BYTES) {
      return `${failureLabel} exceeded ${TAR_LISTING_MAX_OUTPUT_BYTES} bytes`;
    }

    readTextLinesFromFile(listingPath, onLine);
    return null;
  } catch (error) {
    return `${failureLabel} failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (listingFd !== null) closeSync(listingFd);
    rmSync(tempDir, { recursive: true, force: true });
  }
}
