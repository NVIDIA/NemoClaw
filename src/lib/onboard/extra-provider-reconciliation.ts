// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { assertNoOpenShellGatewayEndpointOverride } from "../openshell-gateway-endpoint-guard";

type ExtraProviderRunOpenshell = (
  args: string[],
  opts?: Record<string, unknown>,
) => {
  status: number | null;
  error?: Error;
  output?: unknown;
  stdout?: unknown;
  stderr?: unknown;
};

export type ReconcileExtraProvidersDeps = {
  runOpenshell?: ExtraProviderRunOpenshell;
  listExtraProviders?: () => string[];
  nowMs?: () => number;
  warn?: (message: string) => void;
};

type IndeterminateProbeReason =
  | "aggregate-time-budget"
  | "ambiguous-diagnostic"
  | "diagnostic-capture-limit"
  | "probe-process-error"
  | "probe-threw"
  | "timeout-or-signal"
  | "unexpected-exit";

function defaultRunOpenshell(
  args: string[],
  opts?: Record<string, unknown>,
): ReturnType<ExtraProviderRunOpenshell> {
  const runtime = require("../adapters/openshell/runtime") as {
    getOpenshellBinary: () => string;
  };
  const { run } = require("../runner") as {
    run: (
      command: string[],
      options?: Record<string, unknown>,
    ) => ReturnType<ExtraProviderRunOpenshell>;
  };
  return run([runtime.getOpenshellBinary(), ...args], opts);
}

function defaultListExtraProviders(): string[] {
  const { listExtraProviders } = require("../state/registry") as {
    listExtraProviders: () => string[];
  };
  return listExtraProviders();
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString();
  if (Array.isArray(value)) return value.map(outputText).filter(Boolean).join("\n");
  return value === null || value === undefined ? "" : String(value);
}

const PROVIDER_PROBE_TIMEOUT_MS = 5_000;
const PROVIDER_PROBE_DIAGNOSTIC_LIMIT = 64 * 1024;
const PROVIDER_RECONCILIATION_BUDGET_MS = 15_000;
const DIAGNOSTIC_PREFIXES = ["error:", "rpc error:", "status:"];
const NOT_FOUND_SUFFIXES = new Set([
  "not found",
  "notfound",
  "is not found",
  "is notfound",
  "was not found",
  "was notfound",
]);

function monotonicNowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

type ProviderProbeOutcome = {
  keep: boolean;
  reason?: IndeterminateProbeReason;
};

type ProviderProbeContext = {
  gatewayName: string;
  name: string;
  runOpenshell: ExtraProviderRunOpenshell;
  nowMs: () => number;
  deadlineMs: number;
};

function stripIssueDecoration(line: string): string {
  const trimmed = line.trim();
  return trimmed.startsWith("│") ? trimmed.slice(1).trimStart() : trimmed;
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
  let changed = true;
  while (changed) {
    changed = false;
    const lower = text.toLowerCase();
    for (const prefix of DIAGNOSTIC_PREFIXES) {
      if (lower.startsWith(prefix)) {
        text = text.slice(prefix.length).trimStart();
        changed = true;
        break;
      }
    }
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
  const lower = line.toLowerCase();
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
  let text = stripDiagnosticPrefixes(line);
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
  const lower = issueDiagnostic.toLowerCase();
  const hasWrappedIssueShape =
    lower.includes("provider ") &&
    lower.includes(" not found and ") &&
    lower.includes(" is not a recognized provider type") &&
    lower.includes("openshell provider create") &&
    lower.includes("--name ");
  if (!hasWrappedIssueShape) return null;

  const firstProvider = readQuotedValue(issueDiagnostic, lower.indexOf("provider "));
  const secondProvider = firstProvider
    ? readQuotedValue(issueDiagnostic, lower.indexOf(" and ", firstProvider.end))
    : null;
  const commandProvider = commandNameAfterMarker(issueDiagnostic, "--name ");
  return (
    firstProvider?.value === providerName &&
    secondProvider?.value === providerName &&
    commandProvider === providerName
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
function reportsExactProviderNotFound(output: string, providerName: string): boolean {
  const lines = output.slice(0, PROVIDER_PROBE_DIAGNOSTIC_LIMIT).split(/\r?\n/);
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

  return diagnosticLines.every((line) => providerNameFromNotFoundLine(line) === providerName);
}

function diagnosticPartsFromProbeResult(result: ReturnType<ExtraProviderRunOpenshell>): string[] {
  const primaryDiagnosticParts = [result.stderr, result.stdout].map(outputText).filter(Boolean);
  return primaryDiagnosticParts.length > 0
    ? primaryDiagnosticParts
    : [outputText(result.output)].filter(Boolean);
}

function probeExtraProvider(context: ProviderProbeContext): ProviderProbeOutcome {
  const remainingMs = context.deadlineMs - context.nowMs();
  if (remainingMs <= 0) return { keep: true, reason: "aggregate-time-budget" };

  let result: ReturnType<ExtraProviderRunOpenshell>;
  try {
    result = context.runOpenshell(["provider", "get", "-g", context.gatewayName, context.name], {
      ignoreError: true,
      maxBuffer: PROVIDER_PROBE_DIAGNOSTIC_LIMIT,
      stdio: ["ignore", "pipe", "pipe"],
      suppressOutput: true,
      timeout: Math.max(1, Math.min(PROVIDER_PROBE_TIMEOUT_MS, Math.floor(remainingMs))),
    });
  } catch {
    return { keep: true, reason: "probe-threw" };
  }
  if (result.error) return { keep: true, reason: "probe-process-error" };
  if (result.status === 0) return { keep: true };
  // OpenShell CLI command errors use exit 1. A null status means timeout or
  // signal termination, while any other exit is outside this diagnostic
  // contract; both are indeterminate and must preserve the provider.
  if (result.status === null) return { keep: true, reason: "timeout-or-signal" };
  if (result.status !== 1) return { keep: true, reason: "unexpected-exit" };

  const diagnosticParts = diagnosticPartsFromProbeResult(result);
  if (diagnosticParts.some((part) => Buffer.byteLength(part) >= PROVIDER_PROBE_DIAGNOSTIC_LIMIT)) {
    return { keep: true, reason: "diagnostic-capture-limit" };
  }
  return reportsExactProviderNotFound(diagnosticParts.join("\n"), context.name)
    ? { keep: false }
    : { keep: true, reason: "ambiguous-diagnostic" };
}

/**
 * Reconcile user-owned registry extras with strict provider-specific probes (#6501).
 *
 * Each recorded name is checked independently in the selected gateway. Only an
 * exact provider-specific not-found diagnostic omits that name from this sandbox
 * create. Successful probes and every indeterminate outcome (including throws,
 * timeouts, transport failures, and missing-gateway diagnostics) preserve the
 * recorded name. Local registry state is never mutated: a provider omitted for
 * this create remains available for later retry. Probes share an aggregate time
 * budget; any names left after that budget are preserved. Sandbox creation is
 * still the final authority if gateway state changes after a probe. Indeterminate
 * outcomes emit one aggregate warning containing reason classes and a count,
 * never gateway names, provider names, or raw diagnostics.
 */
export function reconcileRegisteredExtraProviders(
  gatewayName: string,
  deps: ReconcileExtraProvidersDeps = {},
): string[] {
  const recorded = (deps.listExtraProviders ?? defaultListExtraProviders)();
  if (recorded.length === 0) return recorded;
  if (!gatewayName) throw new Error("OpenShell gateway name is required.");
  assertNoOpenShellGatewayEndpointOverride();

  const runOpenshell = deps.runOpenshell ?? defaultRunOpenshell;
  const nowMs = deps.nowMs ?? monotonicNowMs;
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const deadlineMs = nowMs() + PROVIDER_RECONCILIATION_BUDGET_MS;
  const indeterminateReasons = new Set<IndeterminateProbeReason>();
  let indeterminateProviderCount = 0;

  const recordIndeterminate = (reason: IndeterminateProbeReason): void => {
    indeterminateReasons.add(reason);
    indeterminateProviderCount += 1;
  };

  const reconciled: string[] = [];
  for (const name of recorded) {
    const outcome = probeExtraProvider({ gatewayName, name, runOpenshell, nowMs, deadlineMs });
    if (outcome.reason) recordIndeterminate(outcome.reason);
    if (outcome.keep) reconciled.push(name);
  }

  if (indeterminateProviderCount > 0) {
    warn(
      "  Warning: extra-provider reconciliation preserved indeterminate attachments " +
        `(providerCount=${indeterminateProviderCount}; ` +
        `reasonClasses=${[...indeterminateReasons].sort().join(",")}).`,
    );
  }

  return reconciled;
}
