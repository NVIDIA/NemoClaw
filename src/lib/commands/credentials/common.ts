// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_DISPLAY_NAME, CLI_NAME } from "../../cli/branding";
import { recoverNamedGatewayRuntime } from "../../actions/global";

// Suffixes that mark per-sandbox messaging integrations in the gateway's
// provider list. These are managed by `channels`, not `credentials`.
const BRIDGE_PROVIDER_SUFFIXES: readonly string[] = [
  "-telegram-bridge",
  "-discord-bridge",
  "-slack-bridge",
  "-slack-app",
];

export function isBridgeProviderName(name: string): boolean {
  return BRIDGE_PROVIDER_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

export function printCredentialsUsage(log: (message?: string) => void = console.log): void {
  log("");
  log(`  Usage: ${CLI_NAME} credentials <subcommand>`);
  log("");
  log("  Subcommands:");
  log("    list                  List provider credentials registered with the OpenShell gateway");
  log("    reset <PROVIDER> [--yes]   Remove a provider credential so onboard re-prompts");
  log("");
  log("  Credentials live in the OpenShell gateway. Inspect with `openshell provider list`.");
  log("  Nothing is persisted to host disk; deploy/non-onboard commands read from env vars.");
  log("");
}

export function credentialsGatewayRecoveryFailureLines(kind: "query" | "reach"): string[] {
  const action = kind === "query" ? "query" : "reach";
  return [
    `  Could not ${action} the ${CLI_DISPLAY_NAME} OpenShell gateway. Is it running?`,
    `  Run 'openshell gateway start --name nemoclaw' or '${CLI_NAME} onboard' first.`,
  ];
}

export async function recoverGatewayOrExit(
  kind: "query" | "reach",
  reportFailure: (lines: readonly string[]) => void = (lines) => lines.forEach((line) => console.error(line)),
): Promise<boolean> {
  const recovery = await recoverNamedGatewayRuntime();
  if (recovery.recovered) return true;

  reportFailure(credentialsGatewayRecoveryFailureLines(kind));
  return false;
}
