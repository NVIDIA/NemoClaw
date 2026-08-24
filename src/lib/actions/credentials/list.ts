// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createCliOpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter-cli";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import { selectedOpenShellGateway } from "../../adapters/openshell/sandbox-observer";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import { CLI_NAME } from "../../cli/branding";
import { recoverGatewayOrExit } from "../../credentials/command-support";
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
  deps: CredentialsListDeps = {},
): Promise<CredentialsListResult> {
  const recoveryFailureLines: string[] = [];
  const recovered = await recoverGatewayOrExit("query", (lines) => {
    recoveryFailureLines.push(...lines);
  });
  if (!recovered) return fail(recoveryFailureLines);

  const providerAdapter = deps.providerAdapter ?? createCliOpenShellProviderAdapter();
  const result = await providerAdapter.listProviders({
    target: selectedOpenShellGateway(),
    timeoutMs: OPENSHELL_OPERATION_TIMEOUT_MS,
  });
  if (!result.ok) {
    return fail([
      "  Could not query OpenShell gateway. Is it running?",
      `  ${gatewayStartGuidance()}`,
    ]);
  }

  const { bridgeNames, credentialNames } = classifyGatewayProviderNames(result.value.names);
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
      `  Manage those with \`${CLI_NAME} <sandbox> channels list/remove/stop\` — not this command.`,
    );
  }
  return { exitCode: 0, outputLines, failureLines: [] };
}
