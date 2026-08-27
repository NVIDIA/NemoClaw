// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { MessagingSetupApplier, type SandboxMessagingPlan } from "../../messaging";
import { filterEnabledPlanEntries } from "../../messaging/applier/plan-filter";
import { isProviderPlaceholderForEnvKey } from "../../messaging/provider-placeholders";
import { MESSAGING_CREDENTIAL_PROVIDER_TYPE } from "../../messaging/provider-profile";
import type { SandboxEntry } from "../../state/registry/types";
import { inspectGatewayCredentialOnlyProviderAuthority } from "../gateway-provider-metadata";
import {
  messagingBridgeProfilesForAgent,
  staticMessagingProviderTypeForChannel,
} from "../messaging-bridge-provider";
import type { OpenshellCliHelpers } from "../openshell-cli";
import { resolveRegisteredRuntimeProvider } from "../runtime-provider/selection";
import { createGatewayScopedOpenshellRunner } from "../setup-inference";

const SAFE_ENV_KEY = /^[A-Z][A-Z0-9_]{0,127}$/u;
const REVISION = /^openshell:resolve:env:v[0-9]{1,20}_([A-Z][A-Z0-9_]{0,127})$/u;
const DURABLE_REVISION =
  /(?:^openshell:resolve:env:|OPENSHELL-RESOLVE-ENV-)v[0-9]{1,20}_[A-Z][A-Z0-9_]{0,127}$/u;

type CredentialObservation = "absent" | "canonical" | `openshell:resolve:env:v${number}_${string}`;

export interface ManagedMessagingCredentialConvergenceInput {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly openshellDriver: SandboxEntry["openshellDriver"];
  readonly plan: SandboxMessagingPlan | null;
  readonly expectedProviderIds: ReadonlyMap<string, string>;
}

export interface ManagedMessagingCredentialConvergenceDeps {
  readonly runOpenshell: OpenshellCliHelpers["runOpenshell"];
  readonly restartManagedGateway: (sandboxName: string) => {
    readonly ok: boolean;
    readonly detail?: string;
  };
}

export type ManagedMessagingCredentialConvergenceResult =
  | { readonly kind: "skipped" }
  | {
      readonly kind: "converged";
      readonly updatedProviders: readonly string[];
      readonly projectedTargets: readonly string[];
      readonly restartRequired: boolean;
    };

type CredentialBinding = SandboxMessagingPlan["credentialBindings"][number];

function canonicalPlaceholder(envKey: string): string {
  return `openshell:resolve:env:${envKey}`;
}

function validateBinding(binding: CredentialBinding): void {
  if (
    !SAFE_ENV_KEY.test(binding.providerEnvKey) ||
    binding.providerName.length === 0 ||
    binding.providerName !== binding.providerName.trim() ||
    !isProviderPlaceholderForEnvKey(binding.placeholder, binding.providerEnvKey) ||
    DURABLE_REVISION.test(binding.placeholder)
  ) {
    throw new Error("Managed messaging credential binding is not canonical.");
  }
}

function observationScript(envKey: string): string {
  if (!SAFE_ENV_KEY.test(envKey)) {
    throw new Error("Managed messaging credential env key is invalid.");
  }
  const canonical = canonicalPlaceholder(envKey);
  const prefix = "openshell:resolve:env:v";
  const suffix = `_${envKey}`;
  return [
    `if [ -z "\${${envKey}+x}" ]; then printf '%s\\n' absent; exit 0; fi`,
    `value="\${${envKey}}"`,
    `if [ "$value" = "${canonical}" ]; then printf '%s\\n' canonical; exit 0; fi`,
    `case "$value" in "${prefix}"*"${suffix}") ;; *) exit 1 ;; esac`,
    `revision="\${value#${prefix}}"`,
    `revision="\${revision%${suffix}}"`,
    `case "$revision" in ''|*[!0-9]*) exit 1 ;; esac`,
    `[ "\${#revision}" -le 20 ] || exit 1`,
    `printf '%s\\n' "$value"`,
  ].join("\n");
}

function observeCredential(
  sandboxName: string,
  envKey: string,
  runOpenshell: OpenshellCliHelpers["runOpenshell"],
): CredentialObservation {
  const result = runOpenshell(
    ["sandbox", "exec", "-n", sandboxName, "--", "sh", "-lc", observationScript(envKey)],
    { ignoreError: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const output = String(result.stdout ?? "")
    .replace(/\r/g, "")
    .trim();
  if (
    result.status !== 0 ||
    (!REVISION.test(output) && output !== "absent" && output !== "canonical")
  ) {
    throw new Error(
      `Could not observe the current OpenShell messaging credential revision for '${envKey}'.`,
    );
  }
  if (output === "absent" || output === "canonical") return output;
  if (output.match(REVISION)?.[1] !== envKey) {
    throw new Error(`OpenShell returned a messaging credential revision for the wrong env key.`);
  }
  return output as CredentialObservation;
}

function genericCredentialBindings(plan: SandboxMessagingPlan): CredentialBinding[] {
  const profiles = messagingBridgeProfilesForAgent(plan.agent);
  const bindings = filterEnabledPlanEntries(plan, plan.credentialBindings).filter(
    (binding) =>
      staticMessagingProviderTypeForChannel(binding.channelId, plan.agent, profiles) === null,
  );
  for (const binding of bindings) validateBinding(binding);
  const providerNames = new Set(bindings.map((binding) => binding.providerName));
  const envKeys = new Set(bindings.map((binding) => binding.providerEnvKey));
  if (providerNames.size !== bindings.length || envKeys.size !== bindings.length) {
    throw new Error("Managed messaging credential bindings are ambiguous.");
  }
  return bindings;
}

/**
 * Converge generic messaging credentials only after the final bound policy is
 * active. Durable plans retain canonical placeholders. When OpenShell exposes
 * a revision-scoped value, an ephemeral projection carries that exact revision
 * into agent-owned config before one managed gateway restart.
 */
export async function convergeManagedMessagingCredentials(
  input: ManagedMessagingCredentialConvergenceInput,
  deps: ManagedMessagingCredentialConvergenceDeps,
): Promise<ManagedMessagingCredentialConvergenceResult> {
  const provider = resolveRegisteredRuntimeProvider(input.openshellDriver);
  if (
    !input.plan ||
    input.plan.sandboxName !== input.sandboxName ||
    !provider ||
    provider.gateway.launcher !== "nemoclaw" ||
    provider.bootstrap.supported !== true
  ) {
    return { kind: "skipped" };
  }
  const bindings = genericCredentialBindings(input.plan);
  if (bindings.length === 0) return { kind: "skipped" };

  const runOpenshell = createGatewayScopedOpenshellRunner(deps.runOpenshell, input.gatewayName);
  const placeholders = new Map<string, string>();
  const expectedVersions = new Map<string, number>();
  const updatedProviders: string[] = [];

  for (const binding of bindings) {
    const expected = {
      name: binding.providerName,
      type: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
      credentialKey: binding.providerEnvKey,
    };
    const expectedProviderId = input.expectedProviderIds.get(binding.providerName);
    if (!expectedProviderId) {
      throw new Error(
        `Managed messaging provider '${binding.providerName}' has no registration ownership receipt.`,
      );
    }
    const providerState = inspectGatewayCredentialOnlyProviderAuthority(expected, runOpenshell);
    if (providerState.kind !== "exact" || providerState.id !== expectedProviderId) {
      throw new Error(
        `Managed messaging provider '${binding.providerName}' no longer matches its immutable registration authority.`,
      );
    }
    const current = observeCredential(input.sandboxName, binding.providerEnvKey, runOpenshell);
    if (current.startsWith("openshell:resolve:env:v")) {
      placeholders.set(binding.providerEnvKey, current);
    }
    expectedVersions.set(binding.providerName, providerState.resourceVersion);
  }

  const projection = MessagingSetupApplier.applyCredentialProjectionAtOpenShell(
    input.plan,
    placeholders,
    { runOpenshell: (args, options) => runOpenshell([...args], options) },
  );
  const restartRequired = updatedProviders.length > 0 || projection.appliedTargets.length > 0;
  if (restartRequired) {
    const restarted = deps.restartManagedGateway(input.sandboxName);
    if (!restarted.ok) {
      throw new Error(
        `Managed messaging credential convergence could not restart the agent gateway: ${restarted.detail ?? "restart failed"}`,
      );
    }
  }
  for (const binding of bindings) {
    const authority = inspectGatewayCredentialOnlyProviderAuthority(
      {
        name: binding.providerName,
        type: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
        credentialKey: binding.providerEnvKey,
      },
      runOpenshell,
    );
    if (
      authority.kind !== "exact" ||
      authority.id !== input.expectedProviderIds.get(binding.providerName) ||
      authority.resourceVersion !== expectedVersions.get(binding.providerName)
    ) {
      throw new Error(
        `Managed messaging provider '${binding.providerName}' changed during final credential activation.`,
      );
    }
  }
  return {
    kind: "converged",
    updatedProviders,
    projectedTargets: projection.appliedTargets,
    restartRequired,
  };
}
