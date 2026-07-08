// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const ISSUE_4434_ACCEPTANCE_FIELD_PATTERNS = {
  httpStatusOrCause: /\b(?:HTTP\s+\d{3}|status(?:\s+code)?\s*[:=]\s*\d{3}|cause\s*[:=]\s*\S+)/i,
  reportingLayer:
    /\b(?:gateway proxy|gateway layer|reported by gateway|upstream API|from upstream)\b/i,
  recoveryHint: /\b(?:recovery hint|hint\s*[:=]|check (?:egress|network|provider)|retry)\b/i,
} as const;

export type Issue4434AcceptanceFields = Record<
  keyof typeof ISSUE_4434_ACCEPTANCE_FIELD_PATTERNS,
  boolean
>;

const RUN_ERROR_RE = /\brun\s+error:/i;
const ERROR_BLOCK_TERMINATOR_RE =
  /(?:\|\s*(?:connected|error)\b|^(?:user|assistant|system|agent)\s*:)/i;
const MAX_ERROR_BLOCK_LINES = 12;

export function stripTerminalControl(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n");
}

/**
 * Return only the final contiguous TUI `run error:` block. Earlier transcript
 * text must not satisfy the structured #4434 acceptance fields for a later,
 * incomplete error. The block is bounded and ends at the first blank, role,
 * or status line after the final run-error line.
 */
export function extractFinalIssue4434ErrorBlock(plainCapture: string): string {
  const lines = plainCapture.split(/\n/).map((line) => line.trim());
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (RUN_ERROR_RE.test(lines[index] ?? "")) start = index;
  }
  if (start < 0) return "";

  const block: string[] = [];
  for (
    let index = start;
    index < lines.length && block.length < MAX_ERROR_BLOCK_LINES;
    index += 1
  ) {
    const line = lines[index] ?? "";
    if (index > start && (!line || ERROR_BLOCK_TERMINATOR_RE.test(line))) break;
    block.push(line);
  }
  return block.join("\n");
}

export function classifyIssue4434AcceptanceFields(errorBlock: string): Issue4434AcceptanceFields {
  return Object.fromEntries(
    Object.entries(ISSUE_4434_ACCEPTANCE_FIELD_PATTERNS).map(([name, pattern]) => [
      name,
      pattern.test(errorBlock),
    ]),
  ) as Issue4434AcceptanceFields;
}

export function hasFullIssue4434Diagnostics(fields: Issue4434AcceptanceFields): boolean {
  return fields.httpStatusOrCause && fields.reportingLayer && fields.recoveryHint;
}
