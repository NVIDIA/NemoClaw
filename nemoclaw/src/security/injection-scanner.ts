// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Prompt injection scanner for detecting injection attacks in action
 * inputs and outputs.
 *
 * Detects 15 patterns across 4 categories:
 *  - Role/system prompt overrides
 *  - Instruction injection
 *  - Tool manipulation
 *  - Data exfiltration markers
 *
 * Includes NFKC unicode normalization, zero-width character stripping,
 * and base64 decode-rescan to defeat common evasion techniques.
 */

export type Severity = "high" | "medium" | "low";

/** A single injection finding detected by the scanner. */
export interface Finding {
  /** Which field triggered the finding (e.g. "stdout", "body_b64decoded"). */
  field: string;
  /** Which pattern matched (e.g. "role_override_you_are"). */
  pattern: string;
  severity: Severity;
  /** Truncated match context (max 200 chars). */
  snippet: string;
}

interface PatternDef {
  name: string;
  pattern: RegExp;
  severity: Severity;
}

const defaultPatterns: PatternDef[] = [
  // Role/system prompt overrides
  { name: "role_override_you_are", pattern: /\byou\s+are\s+now\b/i, severity: "high" },
  {
    name: "role_override_ignore",
    pattern: /\bignore\s+(all\s+)?previous\s+instructions?\b/i,
    severity: "high",
  },
  { name: "role_override_system_tag", pattern: /<\|im_start\|>\s*system/i, severity: "high" },
  // Uses /m flag intentionally — matches system: at any line start, not just
  // string start. More permissive than Go original for better multiline detection.
  { name: "role_override_system_colon", pattern: /^system\s*:/im, severity: "medium" },

  // Instruction injection
  { name: "instruction_important", pattern: /\bIMPORTANT\s*:\s*[A-Z]/i, severity: "medium" },
  { name: "instruction_critical", pattern: /\bCRITICAL\s*:\s*[A-Z]/i, severity: "medium" },
  { name: "instruction_override", pattern: /\bOVERRIDE\s*:/i, severity: "high" },
  { name: "instruction_inst_tag", pattern: /\[INST\]/i, severity: "high" },
  { name: "instruction_sys_tag", pattern: /<<SYS>>/i, severity: "high" },

  // Tool manipulation
  { name: "tool_manipulation_call", pattern: /\b(call|invoke|use)\s+tool\b/i, severity: "medium" },
  { name: "tool_manipulation_function", pattern: /\buse\s+function\b/i, severity: "medium" },
  { name: "tool_manipulation_execute", pattern: /\bexecute\s+command\b/i, severity: "medium" },

  // Data exfiltration markers
  { name: "exfil_base64_encode", pattern: /\bbase64\s+encode\b/i, severity: "medium" },
  { name: "exfil_send_to", pattern: /\b(send|post|upload)\s+(to|data\s+to)\b/i, severity: "low" },
  {
    name: "exfil_post_secret",
    pattern: /POST\b.*\b(secret|token|key|password|credential)/i,
    severity: "high",
  },
];

/**
 * Scan a set of named string fields for injection patterns.
 *
 * All text is NFKC-normalized, stripped of zero-width and control
 * characters, and optionally base64-decoded before pattern matching.
 * Returns an array of findings (may be empty).
 */
export function scanFields(fields: Record<string, string>): Finding[] {
  const findings: Finding[] = [];

  for (const [fieldName, value] of Object.entries(fields)) {
    if (value === "") {
      continue;
    }

    const normalizedValue = normalizeText(value);
    scanText(fieldName, normalizedValue, findings);

    // Attempt base64 decode and re-scan (use normalized input so
    // zero-width/control chars don't prevent valid base64 from decoding)
    const decoded = tryBase64Decode(normalizedValue);
    if (decoded !== "") {
      scanText(fieldName + "_b64decoded", normalizeText(decoded), findings);
    }
  }

  return findings;
}

function scanText(field: string, text: string, out: Finding[]): void {
  for (const p of defaultPatterns) {
    const match = p.pattern.exec(text);
    if (match !== null) {
      out.push({
        field,
        pattern: p.name,
        severity: p.severity,
        snippet: truncate(text.slice(match.index), 200),
      });
    }
  }
}

/** Returns true if any finding has "high" severity. */
export function hasHighSeverity(findings: Finding[]): boolean {
  return findings.some((f) => f.severity === "high");
}

/** Returns the highest severity among findings, or "" if empty. */
export function maxSeverity(findings: Finding[]): Severity | "" {
  let highest: Severity | "" = "";
  for (const f of findings) {
    if (f.severity === "high") {
      return "high";
    }
    if (f.severity === "medium") {
      highest = "medium";
    }
    if (highest === "" && f.severity === "low") {
      highest = "low";
    }
  }
  return highest;
}

// ── Internal helpers ───────────────────────────────────────────

/** Zero-width and BOM code points to strip. */
const ZERO_WIDTH = new Set([
  0x200b, // zero-width space
  0x200c, // zero-width non-joiner
  0x200d, // zero-width joiner
  0xfeff, // BOM / zero-width no-break space
]);

/**
 * Normalize text using NFKC, strip zero-width characters and
 * non-whitespace control characters.
 */
function normalizeText(s: string): string {
  // NFKC normalization to catch unicode evasion (e.g. fullwidth chars)
  const normalized = s.normalize("NFKC");

  let result = "";
  for (const ch of normalized) {
    const code = ch.codePointAt(0) ?? 0;

    // Strip zero-width characters
    if (ZERO_WIDTH.has(code)) {
      continue;
    }

    // Strip control characters, but preserve \n \r \t
    if (code < 0x20 && code !== 0x0a && code !== 0x0d && code !== 0x09) {
      continue;
    }

    result += ch;
  }

  return result;
}

/**
 * Try to base64-decode a string. Returns the decoded text if:
 *  - trimmed length is between 20 and 100,000
 *  - decoding succeeds (standard or unpadded)
 *  - result is printable text (no bytes < 0x20 except newline/CR/tab)
 *
 * Returns "" otherwise.
 */
function tryBase64Decode(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length < 20 || trimmed.length > 100_000) {
    return "";
  }

  // Validate base64 alphabet before decoding — Buffer.from is too lenient
  // and silently ignores non-base64 characters.
  if (!/^[A-Za-z0-9+/\n\r]*={0,2}$/.test(trimmed)) {
    return "";
  }

  let decoded: Buffer;
  try {
    decoded = Buffer.from(trimmed, "base64");
  } catch {
    return "";
  }

  // Buffer.from with "base64" is lenient — check we got meaningful output.
  if (decoded.length === 0) {
    return "";
  }

  // Check if result is printable text
  for (const b of decoded) {
    if (b < 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09) {
      return "";
    }
  }

  return decoded.toString("utf-8");
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) {
    return s;
  }
  return s.slice(0, maxLen);
}
