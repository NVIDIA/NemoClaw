// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isValidName } from "../../../../nemoclaw/dist/shared/sandbox-name.cjs";
import {
  assertNoOpenShellGatewayEndpointOverride,
  scopeGatewayOpenshellArgs,
} from "./gateway-scope";
import { captureSanitizedResolvedOpenshellAsync } from "./sanitized-capture";

type PolicyCommandResult = {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: unknown;
};
type PolicyCommand = (args: string[]) => Promise<PolicyCommandResult>;

function commandForGateway(gatewayName: string, run?: PolicyCommand): PolicyCommand {
  if (!isValidName(gatewayName)) throw new Error("Invalid native inference gateway name.");
  assertNoOpenShellGatewayEndpointOverride(process.env);
  return (args) =>
    (
      run ??
      ((scoped) =>
        captureSanitizedResolvedOpenshellAsync(scoped, {
          ignoreError: true,
          includeStreams: true,
          includeStderr: true,
          timeout: 30_000,
          outputLimitBytes: 65_536,
        }))
    )(scopeGatewayOpenshellArgs(args, gatewayName, 2));
}

function requireSuccessfulCommand(result: PolicyCommandResult): void {
  if (result.status !== 0 || result.error)
    throw new Error(
      "Could not inspect OpenShell provider-policy prerequisites. No inference selection was changed.",
    );
}

function document(result: PolicyCommandResult): Record<string, unknown> {
  requireSuccessfulCommand(result);
  const text = String(result.stdout ?? "");
  if (Buffer.byteLength(text) > 65_536)
    throw new Error("OpenShell provider-policy response exceeded its limit.");
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    /* Reject an incomplete or incompatible response. */
  }
  throw new Error("OpenShell returned invalid provider-policy prerequisites.");
}

async function requireSandboxPolicyAuthority(run: PolicyCommand): Promise<void> {
  const result = await run(["policy", "list", "--global", "--limit", "1"]);
  requireSuccessfulCommand(result);
  // The pinned server returns NotFound for get when no revision exists.
  // Only a successful history read proves absence without treating errors as permission.
  if (
    !String(result.stdout ?? "").trim() &&
    String(result.stderr ?? "").trim() === "No global policy history found"
  )
    return;
  const policy = document(await run(["policy", "get", "--global", "--output", "json"]));
  if (policy.scope === "global" && policy.status === "superseded") return;
  throw new Error(
    "Native local inference requires sandbox-owned policy. This gateway has a global policy override; ask its administrator to prepare the gateway before retrying.",
  );
}

/** Read-only prerequisite on existing gateways. Never changes sibling policy. */
export async function requireNativeProviderPolicy(
  gatewayName: string,
  command?: PolicyCommand,
): Promise<void> {
  const run = commandForGateway(gatewayName, command);
  const state = document(await run(["settings", "get", "--global", "--json"]));
  const settings = state.settings;
  if (
    state.scope !== "global" ||
    !settings ||
    typeof settings !== "object" ||
    Array.isArray(settings) ||
    (settings as Record<string, unknown>).providers_v2_enabled !== "true"
  ) {
    throw new Error(
      `Native local inference requires providers_v2_enabled=true on gateway '${gatewayName}'. Ask its administrator to review attached providers and enable composition with 'openshell settings set -g ${gatewayName} --global --key providers_v2_enabled --value true --yes', then retry. NemoClaw does not activate it on existing gateways.`,
    );
  }
  await requireSandboxPolicyAuthority(run);
}

/** Called only by the owner immediately after creating a fresh gateway. */
export async function initializeNativeProviderPolicy(
  gatewayName: string,
  command?: PolicyCommand,
): Promise<"disabled" | void> {
  const run = commandForGateway(gatewayName, command);
  await requireSandboxPolicyAuthority(run);
  await run([
    "settings",
    "set",
    "--global",
    "--key",
    "providers_v2_enabled",
    "--value",
    "true",
    "--yes",
  ]).catch(() => undefined);
  // Observe even when the mutation response reports failure; never repeat the write.
  const state = document(await run(["settings", "get", "--global", "--json"]));
  const settings = state.settings;
  const enabled =
    state.scope === "global" && settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>).providers_v2_enabled
      : undefined;
  if (enabled !== "true" && enabled !== "false")
    throw new Error("Could not verify native provider composition after gateway initialization.");
  await requireSandboxPolicyAuthority(run);
  if (enabled === "false") return "disabled";
}
