// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function dockerRunCommandBetween(
  dockerfile: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = dockerfile.indexOf(startMarker);
  const end = dockerfile.indexOf(endMarker, start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Expected Dockerfile block between ${startMarker} and ${endMarker}`);
  }
  const runIndex = dockerfile.indexOf("RUN ", start);
  if (runIndex === -1 || runIndex > end) {
    throw new Error(`Expected RUN instruction after ${startMarker}`);
  }
  const runLines: string[] = [];
  for (const line of dockerfile.slice(runIndex, end).split("\n")) {
    runLines.push(line);
    if (!line.trimEnd().endsWith("\\")) {
      break;
    }
  }
  const lastLine = runLines[runLines.length - 1]?.trimEnd() ?? "";
  if (lastLine.endsWith("\\")) {
    throw new Error(`Expected complete RUN instruction before ${endMarker}`);
  }
  return runLines
    .join("\n")
    .trim()
    .replace(/^RUN\s+/, "")
    .replace(/\\\n/g, " ");
}
