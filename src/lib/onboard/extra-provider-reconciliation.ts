// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellProviderAdapter } from "../adapters/openshell/provider-adapter";
import { createCliOpenShellProviderAdapter } from "../adapters/openshell/provider-adapter-cli";
import { namedOpenShellGateway } from "../adapters/openshell/sandbox-observer";

type ExtraProviderRunOpenshell = (
  args: string[],
  opts?: Record<string, unknown>,
) => {
  status: number | null;
  error?: Error;
  output?: unknown;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
};

export type ReconcileExtraProvidersDeps = {
  runOpenshell?: ExtraProviderRunOpenshell;
  providerAdapter?: OpenShellProviderAdapter;
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
  | "probe-process-error"
  | "timeout-or-signal";

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

const PROVIDER_PROBE_TIMEOUT_MS = 5_000;
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
  providerAdapter: OpenShellProviderAdapter;
  nowMs: () => number;
  deadlineMs: number;
};

async function probeExtraProvider(context: ProviderProbeContext): Promise<ProviderProbeOutcome> {
  const remainingMs = context.deadlineMs - context.nowMs();
  if (remainingMs <= 0) return { keep: true, reason: "aggregate-time-budget" };

  const result = await context.providerAdapter.getProvider({
    target: namedOpenShellGateway(context.gatewayName),
    providerName: context.name,
    timeoutMs: Math.max(1, Math.min(PROVIDER_PROBE_TIMEOUT_MS, Math.floor(remainingMs))),
  });
  if (result.ok) return { keep: true };
  if (
    result.error.kind === "validation" ||
    (result.error.kind === "transport" && result.error.reason === "identity_mismatch")
  ) {
    throw new Error(result.error.message);
  }
  if (result.error.kind === "command" && result.error.reason === "not_found") {
    return { keep: false };
  }
  if (result.error.kind === "timeout") return { keep: true, reason: "timeout-or-signal" };
  if (result.error.kind === "transport" && result.error.reason === "process_start") {
    return { keep: true, reason: "probe-process-error" };
  }
  return { keep: true, reason: "ambiguous-diagnostic" };
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
export async function planRegisteredExtraProviders(
  gatewayName: string,
  deps: ReconcileExtraProvidersDeps = {},
): Promise<ExtraProviderReconciliationPlan> {
  const recorded = (deps.listExtraProviders ?? defaultListExtraProviders)();
  if (recorded.length === 0) {
    return { extraProviders: [], staleExtraProviders: [] };
  }
  if (!gatewayName) throw new Error("OpenShell gateway name is required.");
  const runOpenshell = deps.runOpenshell ?? defaultRunOpenshell;
  const providerAdapter =
    deps.providerAdapter ?? createCliOpenShellProviderAdapter({ run: runOpenshell });
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
    const outcome = await probeExtraProvider({
      gatewayName,
      name,
      providerAdapter,
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
