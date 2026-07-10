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

function monotonicNowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
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
  const diagnosticLines = lines.map((line) => line.trim()).filter(Boolean);
  if (diagnosticLines.length === 0) return false;
  const hasMissingGatewayDiagnostic = lines.some(
    (line) =>
      /\bunknown\s+gateway\b/i.test(line) ||
      /\bno\s+such\s+gateway\b/i.test(line) ||
      /\bgateway\b[^\r\n]{0,200}\bdoes\s+not\s+exist\b/i.test(line) ||
      /\bgateway(?:\s+["'`][^"'`\r\n]+["'`])?\s+(?:(?:was|is)\s+)?(?:not\s+found|NotFound)\b/i.test(
        line,
      ) ||
      /\bNotFound\b\s*:\s*gateway\b/i.test(line),
  );
  if (hasMissingGatewayDiagnostic) return false;

  const hasConflictingStructuredStatus = lines.some((line) => {
    const status = line.match(/\b(?:status|code)\s*[:=]\s*["']?([a-z][a-z_-]*)/i)?.[1];
    return Boolean(status && status.replaceAll("_", "").toLowerCase() !== "notfound");
  });
  if (hasConflictingStructuredStatus) return false;

  const providerThenMissing =
    /^(?:(?:error|rpc\s+error)\s*:\s*)?provider\s+(["'`])([^"'`\r\n]+)\1\s+(?:(?:was|is)\s+)?(?:not\s+found|notfound)[.!]?\s*$/i;
  const structuredMissingThenProvider =
    /^(?:(?:error|rpc\s+error)\s*:\s*)*(?:status\s*:\s*)?notfound\s*:\s*provider\s+(["'`])([^"'`\r\n]+)\1(?:\s+(?:(?:was|is)\s+)?(?:not\s+found|notfound))?[.!]?\s*$/i;
  const issueDiagnostic = diagnosticLines
    .map((line) => line.replace(/^│\s*/u, ""))
    .reduce((message, line) => {
      const part = line.trim();
      if (!part) return message;
      return message.endsWith("-") ? `${message}${part}` : `${message} ${part}`;
    }, "")
    .trim();
  const missingAndUnrecognized =
    /^(?:error\s*:\s*)?(?:×\s*)?provider\s+(["'`])([^"'`\r\n]+)\1\s+not\s+found\s+and\s+(["'`])([^"'`\r\n]+)\3\s+is\s+not\s+a\s+recognized\s+provider\s+type\.\s+Create\s+it\s+first\s+with\s+`openshell\s+provider\s+create\s+--type\s+<type>\s+--name\s+([^`\s]+)`[.!]?\s*$/i;
  const issueMatch = missingAndUnrecognized.exec(issueDiagnostic);
  if (issueMatch) {
    return (
      issueMatch[2] === providerName &&
      issueMatch[4] === providerName &&
      issueMatch[5] === providerName
    );
  }

  return diagnosticLines.every((line) => {
    const match = providerThenMissing.exec(line) ?? structuredMissingThenProvider.exec(line);
    return match?.[2] === providerName;
  });
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
  const preserveIndeterminate = (reason: IndeterminateProbeReason): true => {
    indeterminateReasons.add(reason);
    indeterminateProviderCount += 1;
    return true;
  };

  const reconciled = recorded.filter((name) => {
    const remainingMs = deadlineMs - nowMs();
    if (remainingMs <= 0) return preserveIndeterminate("aggregate-time-budget");

    let result: ReturnType<ExtraProviderRunOpenshell>;
    try {
      result = runOpenshell(["provider", "get", "-g", gatewayName, name], {
        ignoreError: true,
        maxBuffer: PROVIDER_PROBE_DIAGNOSTIC_LIMIT,
        stdio: ["ignore", "pipe", "pipe"],
        suppressOutput: true,
        timeout: Math.max(1, Math.min(PROVIDER_PROBE_TIMEOUT_MS, Math.floor(remainingMs))),
      });
    } catch {
      return preserveIndeterminate("probe-threw");
    }
    if (result.error) return preserveIndeterminate("probe-process-error");
    if (result.status === 0) return true;
    // OpenShell CLI command errors use exit 1. A null status means timeout or
    // signal termination, while any other exit is outside this diagnostic
    // contract; both are indeterminate and must preserve the provider.
    if (result.status === null) return preserveIndeterminate("timeout-or-signal");
    if (result.status !== 1) return preserveIndeterminate("unexpected-exit");

    const primaryDiagnosticParts = [result.stderr, result.stdout].map(outputText).filter(Boolean);
    const diagnosticParts =
      primaryDiagnosticParts.length > 0
        ? primaryDiagnosticParts
        : [outputText(result.output)].filter(Boolean);
    if (
      diagnosticParts.some((part) => Buffer.byteLength(part) >= PROVIDER_PROBE_DIAGNOSTIC_LIMIT)
    ) {
      return preserveIndeterminate("diagnostic-capture-limit");
    }
    const diagnostic = diagnosticParts.join("\n");
    return reportsExactProviderNotFound(diagnostic, name)
      ? false
      : preserveIndeterminate("ambiguous-diagnostic");
  });

  if (indeterminateProviderCount > 0) {
    warn(
      "  Warning: extra-provider reconciliation preserved indeterminate attachments " +
        `(providerCount=${indeterminateProviderCount}; ` +
        `reasonClasses=${[...indeterminateReasons].sort().join(",")}).`,
    );
  }

  return reconciled;
}
