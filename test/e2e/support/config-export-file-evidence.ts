// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

export const CONFIG_EXPORT_EVIDENCE_FILE_LIMIT_BYTES = 1024 * 1024;

export type ProtectedConfigExportRead =
  | { readonly ok: true; readonly raw: string }
  | { readonly ok: false; readonly reason: string };

/** Read a candidate-created export without following links or trusting its path after open. */
export function readProtectedConfigExportFile(
  filePath: string,
  limitBytes = CONFIG_EXPORT_EVIDENCE_FILE_LIMIT_BYTES,
): ProtectedConfigExportRead {
  let file: number | undefined;
  try {
    file = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(file);
    if (!opened.isFile()) return { ok: false, reason: "export output is not a regular file" };
    if (opened.nlink !== 1) {
      return { ok: false, reason: "export output must have exactly one hard link" };
    }
    if (opened.size > limitBytes) {
      return { ok: false, reason: `export output exceeds the ${limitBytes}-byte limit` };
    }

    const buffer = Buffer.alloc(limitBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(file, buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > limitBytes) {
      return { ok: false, reason: `export output exceeds the ${limitBytes}-byte limit` };
    }

    const published = fs.lstatSync(filePath);
    if (
      !published.isFile() ||
      published.nlink !== 1 ||
      published.size > limitBytes ||
      published.size !== opened.size ||
      published.dev !== opened.dev ||
      published.ino !== opened.ino
    ) {
      return { ok: false, reason: "export output changed while it was being read" };
    }
    return { ok: true, raw: buffer.subarray(0, offset).toString("utf8") };
  } catch {
    return { ok: false, reason: "export output could not be opened safely" };
  } finally {
    if (file !== undefined) fs.closeSync(file);
  }
}
