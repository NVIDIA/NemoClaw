// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { stripAnsi } from "../../adapters/openshell/client";
import { redactStandaloneSecretsFull } from "../../security/redact";
import type { McpBridgeEntry } from "../../state/registry";

export type OpenShellCommandResult = {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
};

const UNSAFE_DISPLAY_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const MCP_REDACTION_MARKER = "***REDACTED***";
const MCP_SENSITIVE_VALUE_CANDIDATE =
  /(?:(?:(["'])([A-Za-z_][A-Za-z0-9_-]*)\1|([A-Za-z_][A-Za-z0-9_-]*))\s*[:=]\s*|\bBearer\s+)/gi;

type SensitiveValueCandidate = {
  index: number;
  end: number;
  prefix: string;
  key?: string;
};

function isSensitiveOutputKey(key: string): boolean {
  return /authorization|api[_-]?key|token|secret|password|credential/i.test(key);
}

function nextSensitiveValueCandidate(
  line: string,
  fromIndex: number,
): SensitiveValueCandidate | undefined {
  const candidates = new RegExp(
    MCP_SENSITIVE_VALUE_CANDIDATE.source,
    MCP_SENSITIVE_VALUE_CANDIDATE.flags,
  );
  candidates.lastIndex = fromIndex;
  for (let match = candidates.exec(line); match; match = candidates.exec(line)) {
    const key = match[2] ?? match[3];
    if (key && !isSensitiveOutputKey(key)) continue;
    return {
      index: match.index,
      end: candidates.lastIndex,
      prefix: match[0],
      ...(key ? { key } : {}),
    };
  }
  return undefined;
}

function enclosingQuoteAt(line: string, index: number): '"' | "'" | undefined {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let cursor = 0; cursor < index; cursor++) {
    const character = line[cursor];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character !== '"' && character !== "'") continue;
    quote = quote === character ? undefined : (quote ?? character);
  }
  return quote;
}

function closingQuoteIndex(line: string, fromIndex: number, quote: '"' | "'"): number {
  let escaped = false;
  for (let cursor = fromIndex; cursor < line.length; cursor++) {
    const character = line[cursor];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === quote) return cursor;
  }
  return -1;
}

function redactSensitiveValuesOnLine(line: string): string {
  let output = "";
  let cursor = 0;
  while (cursor < line.length) {
    const candidate = nextSensitiveValueCandidate(line, cursor);
    if (!candidate) {
      output += line.slice(cursor);
      break;
    }

    output += line.slice(cursor, candidate.index) + candidate.prefix;
    let valueStart = candidate.end;
    if (candidate.key) {
      const bearer = /^Bearer\s+/i.exec(line.slice(valueStart));
      if (bearer) {
        output += bearer[0];
        valueStart += bearer[0].length;
      }
    }

    const openingQuote = line[valueStart];
    if (openingQuote === '"' || openingQuote === "'") {
      const closingQuote = closingQuoteIndex(line, valueStart + 1, openingQuote);
      const quotedBearer = candidate.key
        ? /^Bearer\s+/i.exec(
            line.slice(valueStart + 1, closingQuote < 0 ? undefined : closingQuote),
          )
        : null;
      output += `${openingQuote}${quotedBearer?.[0] ?? ""}${MCP_REDACTION_MARKER}`;
      if (closingQuote < 0) break;
      output += openingQuote;
      cursor = closingQuote + 1;
      continue;
    }

    const enclosingQuote = enclosingQuoteAt(line, candidate.index);
    const enclosingQuoteEnd = enclosingQuote
      ? closingQuoteIndex(line, valueStart, enclosingQuote)
      : -1;
    const followingCandidate = nextSensitiveValueCandidate(line, valueStart);
    let valueEnd =
      enclosingQuoteEnd >= 0 ? enclosingQuoteEnd : (followingCandidate?.index ?? line.length);
    if (enclosingQuoteEnd < 0 && followingCandidate) {
      while (valueEnd > valueStart && /\s/.test(line[valueEnd - 1] ?? "")) valueEnd--;
    }
    output += MCP_REDACTION_MARKER;
    cursor = valueEnd;
  }
  return output;
}

function explicitCredentialValues(
  entry: Pick<McpBridgeEntry, "env"> | undefined,
  envValues: Record<string, string>,
): string[] {
  const values = [
    ...(entry?.env.map((name) => envValues[name] ?? process.env[name] ?? "") ?? []),
    ...Object.values(envValues),
  ];
  return [...new Set(values.filter(Boolean))].sort((left, right) => right.length - left.length);
}

function redactMcpOutput(
  text: string,
  entry: Pick<McpBridgeEntry, "env"> | undefined,
  envValues: Record<string, string>,
): string {
  // Preserve the semantic text before removing standalone control bytes.
  // Otherwise an SGR label such as `\x1b[2mId:\x1b[0m` becomes
  // `[2mId:[0m`, which is safe to display but no longer parseable.
  let output = stripAnsi(text || "");
  for (const value of explicitCredentialValues(entry, envValues)) {
    output = output.replaceAll(value, MCP_REDACTION_MARKER);
  }
  output = output.replace(UNSAFE_DISPLAY_CONTROL_CHARS, "");
  output = output
    .split(/(\r\n|\n|\r)/)
    .map((part) => (/^(?:\r\n|\n|\r)$/.test(part) ? part : redactSensitiveValuesOnLine(part)))
    .join("");
  return redactStandaloneSecretsFull(output);
}

export function redactBridgeSecretsForDisplay(
  text: string,
  entry?: Pick<McpBridgeEntry, "env">,
  envValues: Record<string, string> = {},
): string {
  return redactMcpOutput(text, entry, envValues);
}

export function redactCredentialValuesForDisplay(
  value: string,
  envValues: Record<string, string>,
): string {
  return redactMcpOutput(value, undefined, envValues);
}

export function commandOutput(
  result: OpenShellCommandResult,
  envValues: Record<string, string> = {},
): string {
  const stdout =
    typeof result.stdout === "string" ? result.stdout : (result.stdout?.toString() ?? "");
  const stderr =
    typeof result.stderr === "string" ? result.stderr : (result.stderr?.toString() ?? "");
  return redactMcpOutput(`${stderr}${stdout}`, undefined, envValues).replace(/\r/g, "").trim();
}
