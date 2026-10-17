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

/** OpenShell 0.1.3 composes attached providers unless a global policy overrides them. */
export async function requireSandboxPolicyAuthority(run: PolicyCommand): Promise<void> {
  const history = document(
    await run(["policy", "list", "--global", "--page-size", "1", "--output", "json"]),
  );
  if (
    !Array.isArray(history.revisions) ||
    history.revisions.length > 1 ||
    typeof history.next_page_token !== "string"
  )
    throw new Error("OpenShell returned invalid global policy history.");
  if (history.revisions.length === 0) {
    if (history.next_page_token !== "")
      throw new Error("OpenShell returned incomplete global policy history.");
    return;
  }
  const policy = document(await run(["policy", "get", "--global", "--output", "json"]));
  if (policy.scope === "global" && policy.status === "superseded") return;
  throw new Error(
    "Native inference requires sandbox-owned policy. This gateway has a global policy override; ask its administrator to prepare the gateway before retrying.",
  );
}

/** Read-only prerequisite on existing gateways. Never changes sibling policy. */
export async function requireNativeProviderPolicy(
  gatewayName: string,
  command?: PolicyCommand,
): Promise<void> {
  await requireSandboxPolicyAuthority(commandForGateway(gatewayName, command));
}

/** Verify fresh gateway policy authority without changing gateway settings. */
export async function initializeNativeProviderPolicy(
  gatewayName: string,
  command?: PolicyCommand,
): Promise<void> {
  await requireNativeProviderPolicy(gatewayName, command);
}
