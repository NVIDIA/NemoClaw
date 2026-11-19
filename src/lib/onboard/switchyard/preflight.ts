// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  createCliOpenShellProviderAdapter,
  type CliOpenShellProviderAdapterDeps,
} from "../../adapters/openshell/provider-adapter-cli";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import { parseCheckedInProviderProfileContract } from "../../adapters/openshell/provider-profile";
import {
  assertPolicyRequirementContainment,
  type OpenShellPolicyInspection,
} from "../../adapters/openshell/policy-boundary";
import { cliOpenShellSandboxPolicyReader } from "../../adapters/openshell/sandbox-policy-cli";
import type { OpenShellSandboxPolicyReader } from "../../adapters/openshell/sandbox-policy";
import { executePrivilegedSandboxCommand } from "../../sandbox/privileged-exec";
import type { SandboxEntry } from "../../state/registry";
import {
  fingerprintHermesSwitchyardRouting,
  serializeHermesSwitchyardRouting,
  validateSwitchyardBindingState,
  type SwitchyardBindingState,
} from "../../hermes-switchyard-routing";
import { nativeProviderLifecycle } from "../../inference/native-provider";
import { decodeManagedStartupProfile } from "../managed-startup/profile";
import { switchyardProviderDefinition, verifySwitchyardProviderBindings } from "./bindings";

export type SwitchyardPreflightCategory =
  | "configuration"
  | "providers"
  | "policy"
  | "runtime"
  | "changed";

export class SwitchyardPreflightError extends Error {
  constructor(readonly category: SwitchyardPreflightCategory) {
    super(
      `Switchyard preflight failed (${category}). Inspect the existing gateway log and restore the recorded routing inputs before retrying.`,
    );
    this.name = "SwitchyardPreflightError";
  }
}

/** Persisted intent remains authoritative when runtime routing files disappear. */
export type SwitchyardEntry = Pick<
  SandboxEntry,
  "agent" | "workload" | "hermesSwitchyard" | "gatewayName" | "provider" | "model"
>;

export function switchyardStateForEntry(entry: SwitchyardEntry): SwitchyardBindingState | null {
  let profileState: unknown = null;
  try {
    if (entry.agent === "hermes" && entry.workload?.kind === "managed-image") {
      const config = decodeManagedStartupProfile(entry.workload.encodedProfile).agentConfig;
      if (config.agent === "hermes" && config.switchyardRouting) {
        profileState = { routing: config.switchyardRouting, bindings: config.switchyardBindings };
      }
    }
    if (!entry.hermesSwitchyard && !profileState) return null;
    const state = validateSwitchyardBindingState(entry.hermesSwitchyard);
    if (
      entry.agent !== "hermes" ||
      !entry.gatewayName ||
      entry.provider !== state.routing.capable.provider ||
      entry.model !== state.routing.capable.model ||
      !isDeepStrictEqual(profileState, state)
    )
      throw new Error("inconsistent route");
    return state;
  } catch {
    throw new SwitchyardPreflightError("configuration");
  }
}

export interface SwitchyardPreflightDeps {
  providerAdapter?: OpenShellProviderAdapter;
  providerCommand?: CliOpenShellProviderAdapterDeps["run"];
  policyReader?: OpenShellSandboxPolicyReader;
  execute?: typeof executePrivilegedSandboxCommand;
}

/** Require the provider-composed endpoint/rule/binary contract for every role. */
export function requireSwitchyardPolicy(
  inspection: OpenShellPolicyInspection,
  state: SwitchyardBindingState,
): void {
  if (inspection.policySource !== "sandbox") throw new SwitchyardPreflightError("policy");
  const required: Record<string, unknown> = {};
  for (const binding of state.bindings.providers) {
    const definition = switchyardProviderDefinition(binding.logicalProvider);
    const profile = parseCheckedInProviderProfileContract(
      readFileSync(nativeProviderLifecycle(definition).nativeProviderProfilePath(), "utf8"),
    );
    if (!profile) throw new SwitchyardPreflightError("policy");
    // OpenShell 0.0.116 compose::provider_rule_name; binding names contain only
    // lowercase ASCII letters, digits and hyphens, so this is the complete map.
    required[`_provider_${binding.providerName.replaceAll("-", "_")}`] = {
      endpoints: profile.boundary.endpoints,
      binaries: profile.boundary.binaries.map((path) => ({ path })),
    };
  }
  assertPolicyRequirementContainment(inspection, { network_policies: required });
}

type RuntimeEvidence = {
  version: 1;
  configuration: string;
  package: string;
  gateway: { pid: number; startTime: number };
  credentialReferences: Record<string, string>;
};
const SHA256 = /^[a-f0-9]{64}$/u;

function parseRuntimeEvidence(raw: string, state: SwitchyardBindingState): RuntimeEvidence {
  const result = JSON.parse(raw) as { ok?: unknown; evidence?: RuntimeEvidence };
  const evidence = result.evidence;
  const files = serializeHermesSwitchyardRouting(state.routing, state.bindings);
  if (
    result.ok !== true ||
    !evidence ||
    evidence.version !== 1 ||
    evidence.configuration !== fingerprintHermesSwitchyardRouting(files) ||
    typeof evidence.package !== "string" ||
    !SHA256.test(evidence.package) ||
    !Number.isSafeInteger(evidence.gateway?.pid) ||
    evidence.gateway.pid <= 0 ||
    !Number.isSafeInteger(evidence.gateway.startTime) ||
    evidence.gateway.startTime < 0 ||
    !evidence.credentialReferences ||
    !isDeepStrictEqual(
      Object.keys(evidence.credentialReferences).sort(),
      state.bindings.providers.map((p) => p.credentialEnv).sort(),
    ) ||
    Object.values(evidence.credentialReferences).some(
      (value) => typeof value !== "string" || !SHA256.test(value),
    )
  ) {
    throw new SwitchyardPreflightError("runtime");
  }
  // Reconstruct a bounded allowlist. Extra helper output cannot enter a receipt.
  return {
    version: 1,
    configuration: evidence.configuration,
    package: evidence.package,
    gateway: { pid: evidence.gateway.pid, startTime: evidence.gateway.startTime },
    credentialReferences: evidence.credentialReferences,
  };
}

/** One observation, used on both sides of a verification attempt; never cached. */
export async function observeSwitchyardPreflight(
  entry: SwitchyardEntry,
  sandboxName: string,
  deps: SwitchyardPreflightDeps = {},
): Promise<string> {
  const state = switchyardStateForEntry(entry);
  if (!state || !entry.gatewayName) throw new SwitchyardPreflightError("configuration");
  const target = { kind: "named" as const, gatewayName: entry.gatewayName };
  try {
    await verifySwitchyardProviderBindings({
      routing: state.routing,
      expected: state.bindings,
      sandboxName,
      target,
      adapter:
        deps.providerAdapter ??
        createCliOpenShellProviderAdapter({ run: deps.providerCommand, defaultTimeoutMs: 15_000 }),
      providerNames: Object.fromEntries(
        state.bindings.providers.map((p) => [p.logicalProvider, p.providerName]),
      ),
    });
  } catch {
    throw new SwitchyardPreflightError("providers");
  }
  let policy: OpenShellPolicyInspection;
  try {
    const result = await (
      deps.policyReader ?? cliOpenShellSandboxPolicyReader
    ).inspectSandboxPolicy({ target, sandboxName });
    if (!result.ok) throw new Error("policy unavailable");
    policy = result.value;
    requireSwitchyardPolicy(policy, state);
  } catch {
    throw new SwitchyardPreflightError("policy");
  }
  let runtime: RuntimeEvidence;
  try {
    const result = (deps.execute ?? executePrivilegedSandboxCommand)(
      sandboxName,
      [
        "/opt/hermes/.venv/bin/python",
        "-I",
        "/opt/nemoclaw-hermes-config/switchyard-preflight.py",
        "inspect",
      ],
      {
        input: JSON.stringify(serializeHermesSwitchyardRouting(state.routing, state.bindings)),
        sanitizeEnvironment: true,
        timeout: 50_000,
        maxOutputBytes: 4096,
      },
    );
    if (result.status !== 0 || result.signal || result.error)
      throw new Error("runtime unavailable");
    runtime = parseRuntimeEvidence(result.stdout.toString("utf8"), state);
  } catch {
    throw new SwitchyardPreflightError("runtime");
  }
  return createHash("sha256").update(JSON.stringify({ state, policy, runtime })).digest("hex");
}

/** Success applies only to this request and these unchanged observations. */
export async function withSwitchyardPreflight<T>(
  entry: SwitchyardEntry,
  sandboxName: string,
  operation: () => Promise<T>,
  observe: typeof observeSwitchyardPreflight = observeSwitchyardPreflight,
): Promise<T> {
  const before = await observe(entry, sandboxName);
  const result = await operation();
  if ((await observe(entry, sandboxName)) !== before) throw new SwitchyardPreflightError("changed");
  return result;
}

export async function verifySwitchyardRequest(
  entry: SwitchyardEntry,
  sandboxName: string,
  request: () => Promise<{ ok: boolean; detail?: string }>,
  observe: typeof observeSwitchyardPreflight = observeSwitchyardPreflight,
): Promise<{ ok: boolean; preflightOk: boolean; requestSent: boolean; detail: string }> {
  let sent = false;
  try {
    const result = await withSwitchyardPreflight(
      entry,
      sandboxName,
      async () => {
        sent = true;
        try {
          return await request();
        } catch {
          return { ok: false };
        }
      },
      observe,
    );
    return {
      ok: result.ok,
      preflightOk: true,
      requestSent: true,
      detail: result.ok
        ? "Capable provider request succeeded; routing preflight remained current."
        : "Routing preflight passed; the capable provider request failed.",
    };
  } catch (error) {
    return {
      ok: false,
      preflightOk: false,
      requestSent: sent,
      detail: `${error instanceof SwitchyardPreflightError ? error.message : "Switchyard verification is unavailable."} ${
        sent
          ? "A request was attempted; its result is not accepted as current verification."
          : "No inference request was sent."
      }`,
    };
  }
}
