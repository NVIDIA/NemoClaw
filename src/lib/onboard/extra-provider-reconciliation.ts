// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { assertNoOpenShellGatewayEndpointOverride } from "../openshell-gateway-endpoint-guard";
import { reportsExactProviderNotFound } from "./extra-provider-diagnostic-parser";

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
  removeExtraProvider?: (name: string) => boolean;
  nowMs?: () => number;
  warn?: (message: string) => void;
};

export type ExtraProviderReconciliationPlan = {
  readonly extraProviders: readonly string[];
  readonly staleExtraProviders: readonly string[];
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

function defaultRemoveExtraProvider(name: string): boolean {
  const { removeExtraProvider } = require("../state/registry") as {
    removeExtraProvider: (name: string) => boolean;
  };
  return removeExtraProvider(name);
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
  return reportsExactProviderNotFound(
    diagnosticParts.join("\n"),
    context.name,
    PROVIDER_PROBE_DIAGNOSTIC_LIMIT,
  )
    ? { keep: false }
    : { keep: true, reason: "ambiguous-diagnostic" };
}

/**
 * Reconcile user-owned registry extras with strict provider-specific probes (#6501).
 *
 * Each recorded name is checked independently in the selected gateway. Only an
 * exact provider-specific not-found diagnostic omits that name from this sandbox
 * create plan. Applying the completed plan later prunes it from the local
 * extra-provider registry, so retries and `--fresh` starts no longer inherit
 * the stale attachment. Successful probes and every indeterminate outcome
 * (including throws, timeouts, transport failures,
 * and missing-gateway diagnostics) preserve the recorded name. Probes share an
 * aggregate time budget; any names left after that budget are preserved. Sandbox
 * creation is still the final authority if gateway state changes after a probe.
 * Indeterminate outcomes emit one aggregate warning containing reason classes
 * and a count, never gateway names, provider names, or raw diagnostics.
 *
 * Removal condition: delete this defensive prune once OpenShell/NemoClaw gateway
 * reset owns extra-provider lifecycle cleanup before sandbox creation (#6501).
 */
export function planRegisteredExtraProviders(
  gatewayName: string,
  deps: ReconcileExtraProvidersDeps = {},
): ExtraProviderReconciliationPlan {
  const recorded = (deps.listExtraProviders ?? defaultListExtraProviders)();
  if (recorded.length === 0) {
    return { extraProviders: [], staleExtraProviders: [] };
  }
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
  const staleExtraProviders: string[] = [];
  for (const name of recorded) {
    const outcome = probeExtraProvider({
      gatewayName,
      name,
      runOpenshell,
      nowMs,
      deadlineMs,
    });
    if (outcome.reason) recordIndeterminate(outcome.reason);
    if (outcome.keep) {
      reconciled.push(name);
    } else {
      staleExtraProviders.push(name);
    }
  }

  if (indeterminateProviderCount > 0) {
    warn(
      "  Warning: extra-provider reconciliation preserved indeterminate attachments " +
        `(providerCount=${indeterminateProviderCount}; ` +
        `reasonClasses=${[...indeterminateReasons].sort().join(",")}).`,
    );
  }

  return { extraProviders: reconciled, staleExtraProviders };
}

export function applyExtraProviderReconciliation(
  plan: ExtraProviderReconciliationPlan,
  deps: Pick<ReconcileExtraProvidersDeps, "removeExtraProvider"> = {},
): void {
  const removeExtraProvider = deps.removeExtraProvider ?? defaultRemoveExtraProvider;
  for (const name of plan.staleExtraProviders) removeExtraProvider(name);
}

export function reconcileRegisteredExtraProviders(
  gatewayName: string,
  deps: ReconcileExtraProvidersDeps = {},
): string[] {
  // Compatibility wrapper for focused #6501 tests; remove with that defensive prune.
  const plan = planRegisteredExtraProviders(gatewayName, deps);
  applyExtraProviderReconciliation(plan, deps);
  return [...plan.extraProviders];
}
