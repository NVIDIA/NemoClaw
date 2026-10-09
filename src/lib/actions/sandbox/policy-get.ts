// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellSandboxPolicyReader } from "../../adapters/openshell/sandbox-policy";

import {
  redactOpenShellSandboxPolicyDocumentForDisplay,
  cliOpenShellSandboxPolicyReader,
} from "../../adapters/openshell/sandbox-policy-cli";
import { PolicyObservationError } from "../../adapters/openshell/policy-state";
import { formatOpenShellPolicyRecoveryAction } from "../../gateway-start-guidance";
import { assertNoOpenShellGatewayEndpointOverride } from "../../openshell-gateway-endpoint-guard";
import { getKnownSandboxTargetGatewayName } from "./gateway-target";

export interface PolicyGetResult {
  raw: string;
  yaml: string;
}

/** Read the round-trippable OpenShell base policy and strip its metadata header. */
export async function getSandboxPolicy(
  sandboxName: string,
  readPolicy: OpenShellSandboxPolicyReader["readSandboxPolicy"] = cliOpenShellSandboxPolicyReader.readSandboxPolicy,
): Promise<PolicyGetResult> {
  return await readSandboxPolicy(sandboxName, readPolicy);
}

async function readSandboxPolicy(
  sandboxName: string,
  readPolicy: OpenShellSandboxPolicyReader["readSandboxPolicy"],
): Promise<PolicyGetResult> {
  const recordedGatewayName = getKnownSandboxTargetGatewayName(sandboxName);
  if (recordedGatewayName) assertNoOpenShellGatewayEndpointOverride();
  const read = await readPolicy({
    target: recordedGatewayName
      ? { kind: "named", gatewayName: recordedGatewayName }
      : { kind: "selected" },
    sandboxName,
    scope: "base",
  });
  if (!read.ok) {
    const policyReadError = read.error;
    const recovery = formatOpenShellPolicyRecoveryAction(
      policyReadError,
      `nemoclaw ${sandboxName} policy get`,
      recordedGatewayName ?? undefined,
      recordedGatewayName
        ? "Restore the sandbox's recorded OpenShell gateway."
        : "Restore the selected OpenShell gateway.",
    );
    const gatewayContext = recordedGatewayName
      ? `The policy read targeted the recorded gateway '${recordedGatewayName}'. `
      : "";
    throw new PolicyObservationError(
      `Failed to retrieve base policy for sandbox '${sandboxName}'. ${policyReadError.message} ${gatewayContext}${recovery}`,
      { policyReadError },
    );
  }
  const yaml = redactOpenShellSandboxPolicyDocumentForDisplay(read.value.document);
  if (yaml === null) {
    throw new Error(
      `Failed to retrieve base policy for sandbox '${sandboxName}'. OpenShell returned an invalid sandbox policy document.`,
    );
  }
  const metadata = (read.value.metadata ?? [])
    .map(({ field, value }) => `${field}: ${value}`)
    .join("\n");
  return { yaml, raw: metadata ? `${metadata}\n---\n${yaml}` : yaml };
}
