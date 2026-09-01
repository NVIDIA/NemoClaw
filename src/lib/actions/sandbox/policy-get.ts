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
import { captureRecordedSandboxBasePolicy } from "../../policy/index";
import { getKnownSandboxTargetGatewayName } from "./gateway-target";

export interface PolicyGetResult {
  raw: string;
  yaml: string;
}

export interface RecordedGatewayPolicyGetOptions {
  recordedGatewayOperation: string;
}

/** Read the round-trippable OpenShell base policy and strip its metadata header. */
export function getSandboxPolicy(
  sandboxName: string,
  options: RecordedGatewayPolicyGetOptions,
): PolicyGetResult;
export function getSandboxPolicy(
  sandboxName: string,
  readPolicy?: CliOpenShellSandboxPolicyRead,
): Promise<PolicyGetResult>;
export function getSandboxPolicy(
  sandboxName: string,
  readerOrOptions:
    | CliOpenShellSandboxPolicyRead
    | RecordedGatewayPolicyGetOptions = readCliOpenShellSandboxPolicy,
): PolicyGetResult | Promise<PolicyGetResult> {
  if (typeof readerOrOptions !== "function") {
    const yaml = captureRecordedSandboxBasePolicy(
      sandboxName,
      readerOrOptions.recordedGatewayOperation,
    );
    return { raw: yaml, yaml };
  }

  return readSandboxPolicy(sandboxName, readerOrOptions);
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
