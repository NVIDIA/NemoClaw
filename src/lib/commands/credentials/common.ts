// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_DISPLAY_NAME, CLI_NAME } from "../../branding";
import { recoverNamedGatewayRuntime } from "../../global-cli-actions";

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

export async function recoverGatewayOrExit(kind: "query" | "reach"): Promise<void> {
  const recovery = await recoverNamedGatewayRuntime();
  if (recovery.recovered) return;

  if (kind === "query") {
    console.error(`  Could not query the ${CLI_DISPLAY_NAME} OpenShell gateway. Is it running?`);
  } else {
    console.error(`  Could not reach the ${CLI_DISPLAY_NAME} OpenShell gateway. Is it running?`);
  }
  console.error(`  Run 'openshell gateway start --name nemoclaw' or '${CLI_NAME} onboard' first.`);
  process.exit(1);
}
