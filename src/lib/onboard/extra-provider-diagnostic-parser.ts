// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const DIAGNOSTIC_PREFIXES = ["error:", "rpc error:", "status:"];
const NOT_FOUND_SUFFIXES = new Set([
  "not found",
  "notfound",
  "is not found",
  "is notfound",
  "was not found",
  "was notfound",
]);

// Parser helpers deliberately default to null/false for malformed or unknown
// diagnostics. The caller treats that as `ambiguous-diagnostic`, preserving the
// provider and emitting one redacted aggregate warning for observability.
function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "");
}

function stripIssueMarker(text: string): string {
  const trimmed = text.trimStart();
  return trimmed.startsWith("×") ? trimmed.slice(1).trimStart() : trimmed;
}

function stripIssueDecoration(line: string): string {
  const trimmed = stripAnsi(line).trim();
  const withoutPipe = trimmed.startsWith("│") ? trimmed.slice(1).trimStart() : trimmed;
  return stripIssueMarker(withoutPipe);
}

function joinDiagnosticLines(lines: string[]): string {
  return lines
    .reduce((message, line) => {
      const part = line.trim();
      if (!part) return message;
      return message.endsWith("-") ? `${message}${part}` : `${message} ${part}`;
    }, "")
    .trim();
}

function stripDiagnosticPrefixes(line: string): string {
  let text = stripIssueDecoration(line);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const lower = text.toLowerCase();
    const prefix = DIAGNOSTIC_PREFIXES.find((candidate) => lower.startsWith(candidate));
    if (!prefix) return text;
    text = stripIssueMarker(text.slice(prefix.length));
  }
  return text;
}

function readQuotedValue(text: string, searchStart = 0): { value: string; end: number } | null {
  const quoteIndex = ["'", '"', "`"]
    .map((quote) => ({ quote, index: text.indexOf(quote, searchStart) }))
    .filter(({ index }) => index >= 0)
    .sort((left, right) => left.index - right.index)[0];
  if (!quoteIndex) return null;
  const end = text.indexOf(quoteIndex.quote, quoteIndex.index + 1);
  return end >= 0 ? { value: text.slice(quoteIndex.index + 1, end), end: end + 1 } : null;
}

function lineReportsMissingGateway(line: string): boolean {
  const lower = line.replace(/'[^']*'|"[^"]*"|`[^`]*`/gu, "").toLowerCase();
  return (
    lower.includes("unknown gateway") ||
    lower.includes("no such gateway") ||
    lower.includes("notfound: gateway") ||
    (lower.includes("gateway") &&
      (lower.includes("does not exist") ||
        lower.includes("not found") ||
        lower.includes("notfound")))
  );
}

function structuredStatusValue(line: string): string | null {
  const lower = line.toLowerCase();
  for (const key of ["status", "code"]) {
    const keyIndex = lower.indexOf(key);
    if (keyIndex < 0) continue;
    let cursor = keyIndex + key.length;
    while (/\s/u.test(line[cursor] ?? "")) cursor += 1;
    if (line[cursor] !== ":" && line[cursor] !== "=") continue;
    cursor += 1;
    while (/[\s"']/u.test(line[cursor] ?? "")) cursor += 1;
    if (line.slice(cursor).toLowerCase().startsWith("some requested entity was not found")) {
      return "notfound";
    }
    const start = cursor;
    while (/[a-z_-]/iu.test(line[cursor] ?? "")) cursor += 1;
    return line.slice(start, cursor);
  }
  return null;
}

function normalizeStatus(value: string): string {
  return value.replaceAll("_", "").replaceAll("-", "").toLowerCase();
}

function normalizedNotFoundSuffix(value: string): string {
  return value
    .replace(/[.!]+$/u, "")
    .trim()
    .toLowerCase();
}

function providerNameFromNotFoundLine(line: string): string | null {
  return (
    providerNameFromNotFoundText(stripDiagnosticPrefixes(line)) ?? providerNameFromMessage(line)
  );
}

function providerNameFromNotFoundText(text: string): string | null {
  let hasNotFoundStatusPrefix = false;
  if (text.toLowerCase().startsWith("notfound:")) {
    text = text.slice("notfound:".length).trimStart();
    hasNotFoundStatusPrefix = true;
  }
  const providerPrefix = "provider ";
  if (!text.toLowerCase().startsWith(providerPrefix)) return null;
  const quoted = readQuotedValue(text, providerPrefix.length);
  if (!quoted) return null;
  const suffix = normalizedNotFoundSuffix(text.slice(quoted.end));
  return suffix === "" && hasNotFoundStatusPrefix
    ? quoted.value
    : NOT_FOUND_SUFFIXES.has(suffix)
      ? quoted.value
      : null;
}

function providerNameFromMessage(line: string): string | null {
  const text = stripDiagnosticPrefixes(line);
  const markerIndex = text.toLowerCase().indexOf("message:");
  if (markerIndex < 0) return null;
  let cursor = markerIndex + "message:".length;
  while (/\s/u.test(text[cursor] ?? "")) cursor += 1;
  const quote = text[cursor];
  if (quote === "'" || quote === '"' || quote === "`") {
    const end = text.indexOf(quote, cursor + 1);
    if (end < 0) return null;
    return providerNameFromNotFoundText(text.slice(cursor + 1, end));
  }
  return providerNameFromNotFoundText(text.slice(cursor));
}

function readMessageValue(line: string): string | null {
  const text = stripDiagnosticPrefixes(line);
  const markerIndex = text.toLowerCase().indexOf("message:");
  if (markerIndex < 0) return null;
  const quoted = readQuotedValue(text, markerIndex + "message:".length);
  if (quoted) return quoted.value;
  return text.slice(markerIndex + "message:".length).trim();
}

function lineReportsTargetedProviderGetNotFound(line: string): boolean {
  const text = stripDiagnosticPrefixes(line);
  if (normalizedNotFoundSuffix(text) === "provider not found") return true;
  const status = structuredStatusValue(line);
  if (!status || normalizeStatus(status) !== "notfound") return false;
  return normalizedNotFoundSuffix(readMessageValue(line) ?? "") === "provider not found";
}

function commandNameAfterMarker(text: string, marker: string): string | null {
  const markerIndex = text.toLowerCase().indexOf(marker.toLowerCase());
  if (markerIndex < 0) return null;
  let cursor = markerIndex + marker.length;
  while (/\s/u.test(text[cursor] ?? "")) cursor += 1;
  const start = cursor;
  while (cursor < text.length && !/[\s`]/u.test(text[cursor] ?? "")) cursor += 1;
  return cursor > start ? text.slice(start, cursor) : null;
}

function wrappedIssueDiagnosticMatches(
  issueDiagnostic: string,
  providerName: string,
): boolean | null {
  const text = stripDiagnosticPrefixes(issueDiagnostic).replace(/^\s*×\s*/u, "");
  const lower = text.toLowerCase();
  const providerIndex = lower.indexOf("provider ");
  const hasWrappedIssueShape =
    providerIndex >= 0 &&
    lower.includes(" not found and ") &&
    lower.includes(" is not a recognized provider type");
  if (!hasWrappedIssueShape) return null;

  const firstProvider = readQuotedValue(text, providerIndex);
  const secondProvider = firstProvider
    ? readQuotedValue(text, lower.indexOf(" and ", firstProvider.end))
    : null;
  const commandProvider = commandNameAfterMarker(text, "--name ");
  return (
    firstProvider?.value === providerName &&
    secondProvider?.value === providerName &&
    (commandProvider === null || commandProvider === providerName)
  );
}

/**
 * Accept only diagnostics that bind "not found" to this exact quoted provider.
 *
 * OpenShell currently renders both `provider 'name' not found` and the gRPC
 * ordering `NotFound: provider "name"`. Keeping these shapes narrow matters:
 * gateway failures can mention the provider being queried, but must remain
 * indeterminate so onboarding does not silently drop a healthy attachment.
 */
export function reportsExactProviderNotFound(
  output: string,
  providerName: string,
  diagnosticLimit: number,
): boolean {
  const lines = output.slice(0, diagnosticLimit).split(/\r?\n/);
  const diagnosticLines = lines.map(stripIssueDecoration).filter(Boolean);
  if (diagnosticLines.length === 0) return false;
  if (diagnosticLines.some(lineReportsMissingGateway)) return false;
  if (
    diagnosticLines.some((line) => {
      const status = structuredStatusValue(line);
      return Boolean(status && normalizeStatus(status) !== "notfound");
    })
  ) {
    return false;
  }

  const wrappedIssueMatch = wrappedIssueDiagnosticMatches(
    joinDiagnosticLines(diagnosticLines),
    providerName,
  );
  if (wrappedIssueMatch !== null) return wrappedIssueMatch;
  if (
    diagnosticLines.length === 1 &&
    lineReportsTargetedProviderGetNotFound(diagnosticLines[0] ?? "")
  ) {
    return true;
  }

  return diagnosticLines.every((line) => providerNameFromNotFoundLine(line) === providerName);
}
