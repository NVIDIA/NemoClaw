// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type RawArtifactOutputMode = "content" | "metadata-only";

export interface SnapshotArtifactSummary {
  capturedBytes: number;
  capturedFiles: number;
  capturedLines: number;
}

const OMITTED_CONTENT = "omitted: inspected in memory only";

export function projectRawOutputForArtifact(
  text: string,
  stream: "stdout" | "stderr",
  mode: RawArtifactOutputMode,
): string {
  if (mode === "content") return text;
  return `${JSON.stringify({
    stream,
    capturedBytes: Buffer.byteLength(text, "utf8"),
    capturedLines: text.length === 0 ? 0 : text.split("\n").length,
    content: OMITTED_CONTENT,
  })}\n`;
}

export function summarizeSandboxSnapshot(text: string): SnapshotArtifactSummary {
  return {
    capturedBytes: Buffer.byteLength(text, "utf8"),
    capturedFiles: text.split("\n").filter((line) => line.startsWith("@@NEMOCLAW_E2E_FILE@@ "))
      .length,
    capturedLines: text.length === 0 ? 0 : text.split("\n").length,
  };
}
