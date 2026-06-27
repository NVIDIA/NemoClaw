// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function looksLikeJsonStart(trimmedLine: string): boolean {
  return /^\{\s*(?:"|}|$)/.test(trimmedLine) || /^\[\s*(?:[\[{"\-0-9tfn]|\]|$)/.test(trimmedLine);
}

export function parseJsonFromText(raw: string): unknown {
  const text = stripAnsi(raw);
  let cursor = 0;
  for (const lineWithBreak of text.match(/^.*(?:\r?\n|$)/gm) ?? []) {
    const line = lineWithBreak.replace(/\r?\n$/, "");
    const trimmed = line.trimStart();
    if (looksLikeJsonStart(trimmed)) {
      const offset = cursor + line.length - trimmed.length;
      const candidate = text.slice(offset);
      const candidates = [
        candidate,
        ...Array.from(candidate.matchAll(/[}\]]/g), ({ index = 0 }) =>
          candidate.slice(0, index + 1),
        ).reverse(),
      ];
      for (const jsonCandidate of candidates) {
        try {
          return JSON.parse(jsonCandidate);
        } catch {
          // Keep searching for the matching end of the first JSON envelope;
          // stderr warnings can be appended after a valid pretty-printed JSON
          // object when the E2E command captures diagnostics with 2>&1.
        }
      }
      throw new Error("JSON envelope was present but not parseable");
    }
    cursor += lineWithBreak.length;
  }
  throw new Error("no JSON object or array found");
}
