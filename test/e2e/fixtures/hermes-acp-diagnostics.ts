// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ArtifactSink } from "./artifacts.ts";

const MAX_LINE_BYTES = 4096;
const MAX_TOTAL_BYTES = 16 * 1024;
const MAX_LINES = 32;
const DISCARDED =
  "[ACP stderr diagnostics discarded: oversized, incomplete, or capture limit reached]\n";

/** Buffer complete diagnostic lines before redaction, never partial secret fragments. */
export function createHermesAcpDiagnostics(artifacts: ArtifactSink) {
  const lines: string[] = [];
  let pending = "";
  let droppingLine = false;
  let discarded = false;
  let retainedBytes = 0;
  let stopped = false;
  return {
    stop(): void {
      stopped = true;
      if (pending || droppingLine) discarded = true;
      pending = "";
      droppingLine = false;
    },
    append(chunk: string): void {
      if (stopped) return;
      for (const segment of chunk.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
        const complete = segment.endsWith("\n");
        if (!droppingLine) {
          if (
            Buffer.byteLength(pending, "utf8") + Buffer.byteLength(segment, "utf8") >
            MAX_LINE_BYTES
          ) {
            pending = "";
            droppingLine = true;
            discarded = true;
          } else {
            pending += segment;
          }
        }
        if (!complete) continue;
        // Protocol content can follow a log prefix. Only the producer's numeric
        // progress prefix is exempt from the conservative structured-data filter.
        const diagnostic = pending.replace(/^\[\d{1,3}\/\d{1,3}\] /u, "");
        if (!droppingLine && /[[\]{}"]/u.test(diagnostic)) {
          discarded = true;
        } else if (!droppingLine) {
          const line = artifacts.redact(pending);
          const bytes = Buffer.byteLength(line, "utf8");
          if (
            lines.length < MAX_LINES &&
            retainedBytes + bytes <= MAX_TOTAL_BYTES - Buffer.byteLength(DISCARDED)
          ) {
            lines.push(line);
            retainedBytes += bytes;
          } else {
            discarded = true;
          }
        }
        pending = "";
        droppingLine = false;
      }
    },
    async write(relativePath: string): Promise<void> {
      if (pending || droppingLine) discarded = true;
      await artifacts.writeText(relativePath, lines.join("") + (discarded ? DISCARDED : ""));
    },
  };
}
