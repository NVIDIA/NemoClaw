// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createCliOpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter-cli";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import { recoverCredentialGatewayTargetOrExit } from "../../credentials/command-support";
import { classifyGatewayProviderNames } from "../../credentials/provider-list";
import { gatewayStartGuidance } from "../../gateway-start-guidance";

export type CredentialsListResult = {
  exitCode: number;
  outputLines: readonly string[];
  failureLines: readonly string[];
};

export type CredentialsListDeps = Readonly<{
  providerAdapter?: OpenShellProviderAdapter;
}>;

function fail(failureLines: readonly string[]): CredentialsListResult {
  return { exitCode: 1, outputLines: [], failureLines };
}

export async function runCredentialsListAction(
  cliName: string,
  deps: CredentialsListDeps = {},
): Promise<CredentialsListResult> {
  const recoveryFailureLines: string[] = [];
  const target = await recoverCredentialGatewayTargetOrExit("query", (lines) => {
    recoveryFailureLines.push(...lines);
  });
  if (!target) return fail(recoveryFailureLines);

  const providerAdapter = deps.providerAdapter ?? createCliOpenShellProviderAdapter();
  const result = await providerAdapter.listProviders({
    target,
    timeoutMs: OPENSHELL_OPERATION_TIMEOUT_MS,
  });
  if (!result.ok) {
    const failureLines = [
      `  Could not query OpenShell providers on gateway '${target.gatewayName}'.`,
      `  ${result.error.message}`,
    ];
    if (result.error.kind === "transport" && result.error.reason === "unreachable") {
      failureLines.push(`  ${gatewayStartGuidance()}`);
    }
    return fail(failureLines);
  }

  const { bridgeNames, credentialNames } = classifyGatewayProviderNames(result.value.names);
  const outputLines: string[] = [];
  if (credentialNames.length === 0) {
    outputLines.push(
      `  No provider credentials registered with OpenShell gateway '${target.gatewayName}'.`,
    );
  } else {
    outputLines.push(`  Providers registered with OpenShell gateway '${target.gatewayName}':`);
    outputLines.push(...credentialNames.map((name) => `    ${name}`));
  }
  if (bridgeNames.length > 0) {
    outputLines.push(
      "",
      `  ${String(bridgeNames.length)} per-sandbox messaging bridge(s) are also registered.`,
      `    Inspect: \`${cliName} <sandbox> channels list\``,
      `    Retire and clear credentials: \`${cliName} <sandbox> channels remove <channel>\``,
      `    Pause without clearing credentials: \`${cliName} <sandbox> channels stop <channel>\``,
    );
  }
  return { exitCode: 0, outputLines, failureLines: [] };
}
