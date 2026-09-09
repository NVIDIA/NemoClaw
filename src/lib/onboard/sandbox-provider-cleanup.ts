// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { listMessagingProviderSuffixes } from "../messaging/channels";
import { listMessagingBridgeProfiles } from "./messaging-bridge-provider";
import { createManagedProviderAdapter } from "../adapters/openshell/managed-provider-adapter";
import type { OpenShellProviderAdapter } from "../adapters/openshell/provider-adapter";

export {
  applyExtraProviderReconciliation,
  type ExtraProviderReconciliationPlan,
  planRegisteredExtraProviders,
  type ReconcileExtraProvidersDeps,
} from "./extra-provider-reconciliation";
export function removeManagedHermesStateVolume(
  context: import("./managed-workload/hermes-state-volume").ManagedHermesStateVolumeContext,
  deps: import("./managed-workload/hermes-state-volume").ManagedHermesStateVolumeDeps = {},
): import("./managed-workload/hermes-state-volume").ManagedHermesStateVolumeCleanupResult {
  const volumeModule =
    require("./managed-workload/hermes-state-volume") as typeof import("./managed-workload/hermes-state-volume");
  return volumeModule.removeManagedHermesStateVolume(context, deps);
}

export function removeManagedAgentStateVolumes(
  context: import("./managed-workload/hermes-state-volume").ManagedHermesStateVolumeContext,
  deps: import("./managed-workload/hermes-state-volume").ManagedHermesStateVolumeDeps = {},
): readonly import("./managed-workload/hermes-state-volume").ManagedAgentStateVolumeCleanupResult[] {
  const volumeModule =
    require("./managed-workload/hermes-state-volume") as typeof import("./managed-workload/hermes-state-volume");
  return volumeModule.removeManagedAgentStateVolumes(context, deps);
}

export type SandboxProviderRunOpenshell = (
  args: string[],
  opts?: Record<string, unknown>,
) => {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
};

export type DetachSandboxProvidersDeps = {
  runOpenshell?: SandboxProviderRunOpenshell;
  providerAdapter?: OpenShellProviderAdapter;
  revalidateSandboxIdentity?: (operation: string) => void;
  /**
   * Treat OpenShell `sandbox not found` outputs as success-equivalent. Used
   * by the resume-after-prune call site where the sandbox is expected to be
   * gone — the call exists only to clear any stale gateway-side attachment
   * record, so a missing-sandbox response means there is nothing to clean.
   */
  tolerateMissingSandbox?: boolean;
};

export type DeleteProviderWithRecoveryDeps = DetachSandboxProvidersDeps & {
  /**
   * Security containment for the force-detach recovery path. When provided,
   * `deleteProviderWithRecovery` may only force-detach sandboxes whose names
   * appear in this set — the authorized set for the onboarding operation
   * (normally exactly the sandbox being onboarded). If the gateway's
   * FailedPrecondition diagnostic lists ANY sandbox outside this set, the
   * recovery fails closed (no detach is issued) so a mis-parsed, racing, or
   * otherwise unexpected attachment can never silently detach an unrelated
   * sandbox. When omitted, recovery is unconstrained — callers that own the
   * whole gateway (resume-after-prune / credential-reset) opt out explicitly.
   */
  allowedSandboxes?: readonly string[];
};

export type DetachSandboxProvidersResult = {
  detached: string[];
  failures: Array<{ name: string; output: string }>;
};

export type SandboxRecreateCleanupDeps = DetachSandboxProvidersDeps & {
  warn?: (message: string) => void;
  redact?: (input: string) => string;
};

export const SANDBOX_PROVIDER_SUFFIXES = [
  ...new Set([
    ...listMessagingProviderSuffixes().map((suffix) => suffix.replace(/^-/, "")),
    // Bridge-profile channels mint their provider outside the manifest credentials
    // (nothing is delivered into the sandbox), so the credential-derived suffixes
    // above can miss them. Some static profiles also describe a manifest provider,
    // so deduplicate the combined inventory before cleanup issues detach commands.
    ...listMessagingBridgeProfiles().map((profile) => `${profile.channelId}-bridge`),
    "brave-search",
    "tavily-search",
  ]),
] as readonly string[];

export type SandboxProviderSuffix = string;

/** Best-effort registration cleanup after the owning sandbox has been removed. */
export async function deleteSandboxProviderRegistrations(
  sandboxName: string,
  scope: "messaging" | "all",
  deps: DetachSandboxProvidersDeps = {},
): Promise<void> {
  const adapter = deps.providerAdapter ?? createManagedProviderAdapter(deps.runOpenshell);
  const suffixes =
    scope === "messaging"
      ? listMessagingProviderSuffixes().map((suffix) => suffix.replace(/^-/, ""))
      : SANDBOX_PROVIDER_SUFFIXES;
  for (const suffix of suffixes) {
    await adapter.deleteProvider({
      target: { kind: "selected" },
      providerName: `${sandboxName}-${suffix}`,
    });
  }
}

const MAX_WARNING_OUTPUT_CHARS = 500;

function identityRedact(input: string): string {
  return input;
}

/**
 * Detach every per-sandbox messaging and search provider before the sandbox
 * itself is removed. OpenShell `sandbox delete` does not auto-detach
 * providers, so a follow-up `provider delete` (or `provider create` after a
 * `replaceExisting` upsert) trips on FailedPrecondition with
 * "is attached to sandbox(es): <name>" — the canonical pattern is detach
 * first, then delete the sandbox, then delete the provider.
 *
 * Source boundary and removal condition: this helper owns the
 * NemoClaw-side workaround for OpenShell's sandbox-deletion lifecycle. The
 * source-of-truth fix lives in OpenShell — `sandbox delete` should either
 * fail fast on attached providers or release the attachment as part of the
 * deletion. When OpenShell guarantees one of those behaviours (released by
 * a future gateway/CLI version that surfaces a structured "detached on
 * delete" signal), this helper and both production call sites can be
 * removed in one pass.
 *
 * Best-effort across the full suffix set. Tolerated diagnostics are
 * narrowly scoped — `NotAttached` / "not attached" (the attachment is
 * already gone) and `provider … NotFound` / `provider … not found` (the
 * provider itself never existed or has already been deleted). Bare
 * `NotFound` is intentionally NOT tolerated because the same wording is
 * also used for missing-sandbox errors during the resume / pruned-sandbox
 * path, where the attachment may still be stale and require manual recovery.
 * Non-matching failures are returned in `failures` for the caller to
 * surface; the caller decides whether to abort or continue.
 */
export async function detachSandboxProviders(
  sandboxName: string,
  deps: DetachSandboxProvidersDeps = {},
): Promise<DetachSandboxProvidersResult> {
  const adapter = deps.providerAdapter ?? createManagedProviderAdapter(deps.runOpenshell);
  const detached: string[] = [];
  const failures: Array<{ name: string; output: string }> = [];
  for (const suffix of SANDBOX_PROVIDER_SUFFIXES) {
    const name = `${sandboxName}-${suffix}`;
    // OpenShell resolves provider detach by mutable sandbox name. These checks detect
    // replacement and stop later detaches; they do not make this command an atomic,
    // identity-bound mutation. Operators must not mutate the sandbox concurrently.
    deps.revalidateSandboxIdentity?.(`detaching provider '${name}' from sandbox '${sandboxName}'`);
    const result = await adapter.detachProvider({
      target: { kind: "selected" },
      sandboxName,
      providerName: name,
    });
    deps.revalidateSandboxIdentity?.(
      `confirming provider '${name}' detach from sandbox '${sandboxName}'`,
    );
    if (result.ok) {
      if (result.value.changed) detached.push(name);
      continue;
    }
    const output = result.error.message;
    if (result.error.kind === "command" && result.error.reason === "not_found") continue;
    if (
      deps.tolerateMissingSandbox &&
      result.error.kind === "command" &&
      result.error.reason === "sandbox_not_found"
    ) {
      continue;
    }
    failures.push({ name, output: output.trim() });
  }
  return { detached, failures };
}

export type RecoverProviderResult = {
  detached: string[];
  failures: Array<{ sandbox: string; output: string }>;
};

/**
 * Recovery path for `provider delete` failures whose attachment list points
 * at a sandbox that the local recreate / destroy pass could not reach (the
 * resume-after-prune case: sandbox already gone, but the gateway still
 * tracks the orphaned attachment). Issues `sandbox provider detach
 * <sandbox> <provider>` for each listed sandbox, then returns the per-name
 * outcome so the caller can retry the original delete.
 */
export async function recoverAttachedProvider(
  providerName: string,
  attachedSandboxes: string[],
  deps: DetachSandboxProvidersDeps = {},
): Promise<RecoverProviderResult> {
  const adapter = deps.providerAdapter ?? createManagedProviderAdapter(deps.runOpenshell);
  const detached: string[] = [];
  const failures: Array<{ sandbox: string; output: string }> = [];
  for (const sandbox of attachedSandboxes) {
    const result = await adapter.detachProvider({
      target: { kind: "selected" },
      sandboxName: sandbox,
      providerName,
    });
    if (result.ok || (result.error.kind === "command" && result.error.reason === "not_found")) {
      detached.push(sandbox);
      continue;
    }
    failures.push({ sandbox, output: result.error.message });
  }
  return { detached, failures };
}

/**
 * Run the recreate / destroy preflight that detaches every per-sandbox
 * messaging and search provider, then surfaces any non-tolerated failure
 * through the injected `warn` channel with the failure output redacted and
 * length-capped. Returns the same result as `detachSandboxProviders` so
 * callers can inspect / re-test specific names if they want to short-circuit
 * downstream work.
 *
 * Non-tolerated detach failures are advisory rather than fatal because the
 * downstream operations that immediately follow the cleanup already surface
 * the same residual attachment with an actionable, name-scoped error:
 *
 *   - The onboard recreate path runs typed messaging provider application with
 *     `replaceExisting: true` next; a residual attachment rejects with a
 *     name-scoped `MessagingProviderApplyError` and preserves retry state.
 *   - The destroy path runs `runOpenshell(["sandbox", "delete", sandboxName])`
 *     next; that call hard-fails on non-`alreadyGone` errors before any
 *     registry state is removed, so a real gateway outage stops destroy
 *     before it can drop state needed for retry.
 *
 * Treating a non-tolerated detach return as a hard failure here would
 * regress the merely-flaky-gateway case (where the subsequent operation
 * succeeds) without gaining any signal that the immediately-following step
 * does not already provide. Callers that want stricter semantics inspect
 * the returned `failures` array directly.
 */
export async function runSandboxProviderPreDeleteCleanup(
  sandboxName: string,
  deps: SandboxRecreateCleanupDeps = {},
): Promise<DetachSandboxProvidersResult> {
  const result = await detachSandboxProviders(sandboxName, {
    providerAdapter: deps.providerAdapter,
    runOpenshell: deps.runOpenshell,
    revalidateSandboxIdentity: deps.revalidateSandboxIdentity,
    tolerateMissingSandbox: deps.tolerateMissingSandbox,
  });
  if (result.failures.length === 0) return result;
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const redact = deps.redact ?? identityRedact;
  for (const failure of result.failures) {
    const safeOutput = redact(failure.output).slice(0, MAX_WARNING_OUTPUT_CHARS);
    warn(
      `  Warning: failed to detach provider '${failure.name}' before sandbox delete: ${safeOutput}`,
    );
  }
  return result;
}

export type ProviderDeleteWithRecoveryResult = {
  ok: boolean;
  status: number | null;
  stderr: string;
  stdout: string;
  recoveryFailures: Array<{ sandbox: string; output: string }>;
};

/**
 * Delete an OpenShell provider, recovering from a FailedPrecondition that
 * reports the provider as still attached to one or more sandboxes. The
 * source-of-truth fix lives in OpenShell: `provider delete` should either
 * cascade through the gateway-side attachment record or expose a structured
 * "force" path. Until that lands, the adapter validates the attached-sandbox
 * list. This helper detaches each authorized entry and retries deletion once
 * only after every detach is confirmed. Removable in the same future
 * OpenShell version that lets `runSandboxProviderPreDeleteCleanup` go away.
 *
 * Security containment: when `deps.allowedSandboxes` is supplied, the typed
 * attachment list is revalidated against that authorized set BEFORE any
 * detach is issued. If any listed sandbox falls outside the set, the recovery
 * fails closed — no detach runs and the original delete failure is returned —
 * so a stale, racing, or mis-parsed diagnostic can never force-detach a
 * sandbox the caller did not authorize. Callers that omit `allowedSandboxes`
 * (they own the whole gateway) keep the unconstrained behaviour.
 *
 * Returns the final `provider delete` outcome plus the list of per-sandbox
 * detach failures, so the caller can fold those into the user-facing error
 * if the retry still doesn't land.
 */
export async function deleteProviderWithRecovery(
  providerName: string,
  deps: DeleteProviderWithRecoveryDeps = {},
): Promise<ProviderDeleteWithRecoveryResult> {
  const adapter = deps.providerAdapter ?? createManagedProviderAdapter(deps.runOpenshell);
  const request = { target: { kind: "selected" as const }, providerName };
  let result = await adapter.deleteProvider(request);
  let recoveryFailures: Array<{ sandbox: string; output: string }> = [];
  if (!result.ok && result.error.kind === "command" && result.error.reason === "attached") {
    const attached = [...(result.error.attachedSandboxes ?? [])];
    // Fail closed when the diagnostic names any sandbox outside the caller's
    // authorized set: force-detaching it could break an unrelated sandbox.
    const allowed = deps.allowedSandboxes;
    const outsideAuthorizedSet =
      allowed !== undefined && attached.some((name) => !allowed.includes(name));
    if (attached.length > 0 && !outsideAuthorizedSet) {
      const recovery = await recoverAttachedProvider(providerName, attached, {
        providerAdapter: adapter,
      });
      recoveryFailures = recovery.failures;
      if (recoveryFailures.length === 0) result = await adapter.deleteProvider(request);
    }
  }
  return {
    ok: result.ok,
    status: result.ok ? 0 : 1,
    stderr: result.ok ? "" : result.error.message,
    stdout: "",
    recoveryFailures,
  };
}

/**
 * Emit a destroy-time residual cleanup hint when non-tolerated detach
 * failures left providers stuck attached. The hint guides the user through
 * the detach-then-delete sequence that OpenShell requires.
 */
export function emitProviderDetachResidualHint(
  sandboxName: string,
  failures: Array<{ name: string; output: string }>,
  warn?: (message: string) => void,
): void {
  if (failures.length === 0) return;
  const emit = warn ?? ((m: string) => console.warn(m));
  const names = failures.map((f) => f.name).join(", ");
  emit(`  Residual provider state may remain in the OpenShell gateway: ${names}.`);
  emit(
    `  Run 'openshell sandbox provider detach ${sandboxName} <name>' then 'openshell provider delete <name>' for each before the next onboard.`,
  );
}
