// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { recoverNamedGatewayRuntime } from "../actions/global";
import { CLI_DISPLAY_NAME, CLI_NAME } from "../cli/branding";
import { GATEWAY_PORT } from "../core/ports";
import { gatewayStartGuidance } from "../gateway-start-guidance";
import { resolveGatewayName } from "../onboard/gateway-binding";
import { resolveGatewayCredentialMutationAuthority } from "../onboard/gateway-teardown-authority";

export { isBridgeProviderName } from "./provider-list";

export function printCredentialsUsage(log: (message?: string) => void = console.log): void {
  log("");
  log(`  Usage: ${CLI_NAME} credentials <subcommand>`);
  log("");
  log("  Subcommands:");
  log(
    "    list                            List provider credentials registered with the OpenShell gateway",
  );
  log("    add <PROVIDER> --type <TYPE>    Register a provider credential (reads value from env)");
  log("    reset <PROVIDER> [--yes]        Remove a provider credential so onboard re-prompts");
  log("");
  log("  Credentials live in the OpenShell gateway. Inspect with `openshell provider list`.");
  log("  Nothing is persisted to host disk; credential registration reads values from env vars.");
  log("");
}

export function credentialsGatewayRecoveryFailureLines(kind: "query" | "reach"): string[] {
  const action = kind === "query" ? "query" : "reach";
  return [
    `  Could not ${action} the ${CLI_DISPLAY_NAME} OpenShell gateway. Is it running?`,
    `  ${gatewayStartGuidance(resolveGatewayName(GATEWAY_PORT))}`,
  ];
}

export function credentialsGatewayAuthorityFailureLines(
  error: unknown,
  operation: "mutation" | "query" = "mutation",
): string[] {
  const detail = error instanceof Error ? error.message : String(error);
  const action = operation === "query" ? "query" : "change";
  return [
    `  Refusing to ${action} provider credentials because the gateway lifecycle authority could not be revalidated.`,
    `  ${detail}`,
    `  Run '${CLI_NAME} onboard' to bind the current gateway authority before retrying.`,
  ];
}

export async function recoverGatewayOrExit(
  kind: "query" | "reach",
  reportFailure: (lines: readonly string[]) => void = (lines) =>
    lines.forEach((line) => console.error(line)),
): Promise<boolean> {
  const recovery = await recoverNamedGatewayRuntime();
  if (recovery.recovered) return true;

  reportFailure(credentialsGatewayRecoveryFailureLines(kind));
  return false;
}

export type CredentialGatewayTarget = Readonly<{ kind: "named"; gatewayName: string }>;

export async function recoverCredentialGatewayTargetOrExit(
  operation: "mutation" | "query",
  reportFailure: (lines: readonly string[]) => void = (lines) =>
    lines.forEach((line) => console.error(line)),
): Promise<CredentialGatewayTarget | null> {
  if (!(await recoverGatewayOrExit(operation === "query" ? "query" : "reach", reportFailure))) {
    return null;
  }

  const gatewayName = resolveGatewayName(GATEWAY_PORT);
  try {
    resolveGatewayCredentialMutationAuthority({
      gatewayName,
      gatewayPort: GATEWAY_PORT,
    });
    return { kind: "named", gatewayName };
  } catch (error) {
    reportFailure(credentialsGatewayAuthorityFailureLines(error, operation));
    return null;
  }
}
