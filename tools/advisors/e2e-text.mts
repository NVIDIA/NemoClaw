// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Defense in depth for rejecting obvious command-shaped model items. This is
// deliberately not an authorization or publication boundary: normalized E2E
// output retains only allowlisted identifiers and trusted-code-authored prose.
const COMMAND_EXECUTABLE =
  "(?:aws|bash|bun|cat|chmod|chown|curl|dd|deno|docker|env|eval|export|find|gh|git|helm|jq|kill|kubectl|ls|make|mkdir|mv|nc|node|npm|npx|openssl|pip3?|pnpm|podman|powershell|pwsh|python3?|rm|rsync|scp|sed|sh|ssh|sudo|tar|tee|touch|wget|xargs|yarn|zsh)";
const COMMAND_LINE_PATTERN = new RegExp(
  String.raw`(?:^|\n)\s*(?:[$>#]\s*)?(?:sudo\s+)?${COMMAND_EXECUTABLE}(?:\s|$)`,
  "u",
);
const COMMAND_INSTRUCTION_PATTERN = new RegExp(
  String.raw`(?:^|[.!?]\s+)(?:please\s+)?(?:dispatch|enter|execute|invoke|paste|run|type)\s+(?:(?:this|the)\s+)?(?:command\s*:\s*)?\S+`,
  "iu",
);
const EXPLICIT_COMMAND_LABEL_PATTERN = /\b(?:command|shell command)\s*:\s*(?:[$>#]\s*)?\S+/iu;
const INLINE_COMMAND_PATTERN = new RegExp(
  `\`(?:sudo\\s+)?${COMMAND_EXECUTABLE}(?:\\s+[^\`\\r\\n]+)?\``,
  "u",
);
const FENCED_COMMAND_PATTERN = new RegExp(
  `\`\`\`(?:bash|console|powershell|pwsh|shell|sh|zsh)?[\\s\\S]*?\\b${COMMAND_EXECUTABLE}\\b[\\s\\S]*?\`\`\``,
  "iu",
);
const COMMAND_SEQUENCE_PATTERNS: readonly RegExp[] = [
  /\bgh\s+(?:api|workflow\s+run)\b/iu,
  /\b(?:bun|npm|pnpm|yarn)\s+(?:exec|install|run|test)\b/iu,
  /\b(?:bash|powershell|pwsh|sh|zsh)\s+-[^\s]*c\b/iu,
  /(?:^|\s)--ref(?:=|\s)/iu,
  /--field\s+(?:jobs|targets)=/iu,
  /\/dispatches\b/iu,
  /\$\(|&&|\|\|/u,
];
const GENERIC_FLAG_COMMAND_LINE_PATTERN =
  /(?:^|\n)\s*(?:[$>#]\s*)?(?:sudo\s+)?(?:\.{0,2}\/|\/)?[a-zA-Z0-9_.-]+\s+--?[a-zA-Z0-9]/u;
const PATH_COMMAND_LINE_PATTERN =
  /(?:^|\n)\s*(?:[$>#]\s*)?(?:sudo\s+)?(?:\.{1,2}\/|\/)[^\s]+(?:\s|$)/u;
const SHELL_PROMPT_PATTERN = /(?:^|\n)\s*[$>#]\s*\S/u;
const SHELL_SYNTAX_PATTERN = /\\|\$|&&|\|\||(?:^|\s)[|<>](?:\s|$)|[^\s;]+;[^\s;]/u;
const SHELL_QUOTE_CONCATENATION_PATTERN = /['"]{2}|\w['"][^'"\s]*['"](?:\w|$)/u;

function canonicalCommandText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\r\n\u2028\u2029]+/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[\p{Cc}\p{White_Space}]+/gu, " ").trim())
    .join("\n")
    .trim();
}

export function isCommandShapedE2eText(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const canonical = canonicalCommandText(value);
  if (!canonical) return false;
  const flat = canonical.replace(/\s+/gu, " ");
  if (
    COMMAND_LINE_PATTERN.test(canonical) ||
    COMMAND_INSTRUCTION_PATTERN.test(flat) ||
    EXPLICIT_COMMAND_LABEL_PATTERN.test(flat) ||
    INLINE_COMMAND_PATTERN.test(canonical) ||
    FENCED_COMMAND_PATTERN.test(canonical) ||
    GENERIC_FLAG_COMMAND_LINE_PATTERN.test(canonical) ||
    PATH_COMMAND_LINE_PATTERN.test(canonical) ||
    SHELL_PROMPT_PATTERN.test(canonical) ||
    SHELL_SYNTAX_PATTERN.test(canonical) ||
    SHELL_QUOTE_CONCATENATION_PATTERN.test(canonical) ||
    COMMAND_SEQUENCE_PATTERNS.some((pattern) => pattern.test(flat))
  ) {
    return true;
  }
  const compact = flat.replace(/\s+/gu, "").toLowerCase();
  return /ghworkflowrun(?:--|[a-z0-9_.-]+\.ya?ml)/u.test(compact);
}

export function containsCommandShapedE2eText(value: unknown): boolean {
  if (typeof value === "string") return isCommandShapedE2eText(value);
  if (Array.isArray(value)) return value.some(containsCommandShapedE2eText);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsCommandShapedE2eText);
  }
  return false;
}

export function normalizeSafeE2eText(value: unknown, maxLength = 2_000): string | undefined {
  if (typeof value !== "string" || isCommandShapedE2eText(value)) return undefined;
  const normalized = value
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .trim();
  if (!normalized || normalized.length > maxLength || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(normalized)) {
    return undefined;
  }
  return normalized;
}
