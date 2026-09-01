// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  redactOpenShellSandboxPolicyReadForDisplay,
  type CliOpenShellSandboxPolicyRead,
  readCliOpenShellSandboxPolicy,
} from "../../adapters/openshell/sandbox-policy-cli";
import {
  namedOpenShellGateway,
  selectedOpenShellGateway,
} from "../../adapters/openshell/sandbox-observer";
import { assertNoOpenShellGatewayEndpointOverride } from "../../openshell-gateway-endpoint-guard";
import { getKnownSandboxTargetGatewayName } from "./gateway-target";

export interface PolicyGetResult {
  raw: string;
  yaml: string;
}

/** Read the round-trippable OpenShell base policy and strip its metadata header. */
export function getSandboxPolicy(
  sandboxName: string,
  readPolicy: CliOpenShellSandboxPolicyRead = readCliOpenShellSandboxPolicy,
): Promise<PolicyGetResult> {
  return readSandboxPolicy(sandboxName, readPolicy);
}

async function readSandboxPolicy(
  sandboxName: string,
  readPolicy: CliOpenShellSandboxPolicyRead,
): Promise<PolicyGetResult> {
  const recordedGatewayName = getKnownSandboxTargetGatewayName(sandboxName);
  if (recordedGatewayName) assertNoOpenShellGatewayEndpointOverride();
  const read = await readPolicy({
    target: recordedGatewayName
      ? namedOpenShellGateway(recordedGatewayName)
      : selectedOpenShellGateway(),
    sandboxName,
    scope: "base",
  });
  if (!read.result.ok) {
    throw new Error(
      `Failed to retrieve base policy for sandbox '${sandboxName}'. ${read.result.error.message}`,
    );
  }
  const display = redactOpenShellSandboxPolicyReadForDisplay({
    displayOutput: read.displayOutput,
    document: read.result.value.document,
  });
  if (display === null) {
    throw new Error(
      `Failed to retrieve base policy for sandbox '${sandboxName}'. OpenShell returned an invalid sandbox policy document.`,
    );
  }
  return display;
}
