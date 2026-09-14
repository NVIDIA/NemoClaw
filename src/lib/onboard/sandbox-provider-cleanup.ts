// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { listMessagingProviderSuffixes } from "../messaging/channels";
import { listMessagingBridgeProfiles } from "./messaging-bridge-provider";
import { createManagedProviderAdapter } from "../adapters/openshell/managed-provider-adapter";
import type {
  OpenShellProviderAdapter,
  OpenShellProviderMutationResult,
} from "../adapters/openshell/provider-adapter";

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
  /** Only detach attachments in this set. An omitted set authorizes gateway-wide recovery. */
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

/** Deletes registrations after sandbox removal. Failures can leave stale registrations. */
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
 * Detach owned messaging and search providers before sandbox removal.
 * Return failures to the lifecycle owner; it decides whether cleanup can continue.
 * Missing sandboxes are tolerated only by the explicit resume-after-prune caller.
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

/** Report bounded, redacted detach failures; the following lifecycle mutation remains authoritative. */
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

export type ProviderDeleteWithRecoveryResult = OpenShellProviderMutationResult & {
  recoveryFailures: Array<{ sandbox: string; output: string }>;
};

/**
 * Delete once. On a confirmed attachment failure, detach only authorized sandboxes,
 * then retry once after every detach succeeds. Preserve uncertain or partial failures.
 */
export async function deleteProviderWithRecovery(
  providerName: string,
  deps: DeleteProviderWithRecoveryDeps = {},
): Promise<ProviderDeleteWithRecoveryResult> {
  const adapter = deps.providerAdapter ?? createManagedProviderAdapter(deps.runOpenshell);
  const request = { target: { kind: "selected" as const }, providerName };
  let result = await adapter.deleteProvider(request);
  const recoveryFailures: Array<{ sandbox: string; output: string }> = [];
  if (!result.ok && result.error.kind === "command" && result.error.reason === "attached") {
    const attached = [...(result.error.attachedSandboxes ?? [])];
    // Fail closed when the diagnostic names any sandbox outside the caller's
    // authorized set: force-detaching it could break an unrelated sandbox.
    const allowed = deps.allowedSandboxes;
    const outsideAuthorizedSet =
      allowed !== undefined && attached.some((name) => !allowed.includes(name));
    if (attached.length > 0 && !outsideAuthorizedSet) {
      for (const sandboxName of attached) {
        const detached = await adapter.detachProvider({ ...request, sandboxName });
        if (
          !detached.ok &&
          !(detached.error.kind === "command" && detached.error.reason === "not_found")
        ) {
          recoveryFailures.push({ sandbox: sandboxName, output: detached.error.message });
        }
      }
      if (recoveryFailures.length === 0) result = await adapter.deleteProvider(request);
    }
  }
  return { ...result, recoveryFailures };
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
