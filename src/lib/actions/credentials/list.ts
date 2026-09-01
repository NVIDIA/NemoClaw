// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshellProviderCommand } from "../../adapters/openshell/provider-command";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import { recoverGatewayOrExit } from "../../credentials/command-support";
import { parseGatewayProviderNames } from "../../credentials/provider-list";
import { gatewayStartGuidance } from "../../gateway-start-guidance";

export type CredentialsListResult = {
  exitCode: number;
  outputLines: readonly string[];
  failureLines: readonly string[];
};

function fail(failureLines: readonly string[]): CredentialsListResult {
  return { exitCode: 1, outputLines: [], failureLines };
}

export async function runCredentialsListAction(cliName: string): Promise<CredentialsListResult> {
  const recoveryFailureLines: string[] = [];
  const recovered = await recoverGatewayOrExit("query", (lines) => {
    recoveryFailureLines.push(...lines);
  });
  if (!recovered) return fail(recoveryFailureLines);

  const result = runOpenshellProviderCommand(["provider", "list", "--names"], {
    ignoreError: true,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    return fail([
      "  Could not query OpenShell gateway. Is it running?",
      `  ${gatewayStartGuidance()}`,
    ]);
  }

  const { bridgeNames, credentialNames } = parseGatewayProviderNames(result.stdout);
  const outputLines: string[] = [];
  if (credentialNames.length === 0) {
    outputLines.push("  No provider credentials registered.");
  } else {
    outputLines.push("  Providers registered with the OpenShell gateway:");
    outputLines.push(...credentialNames.map((name) => `    ${name}`));
  }
  if (bridgeNames.length > 0) {
    outputLines.push(
      "",
      `  ${String(bridgeNames.length)} per-sandbox messaging bridge(s) are also registered.`,
      `  Manage those with \`${cliName} <sandbox> channels list/remove/stop\` — not this command.`,
    );
  }
  return { exitCode: 0, outputLines, failureLines: [] };
}
