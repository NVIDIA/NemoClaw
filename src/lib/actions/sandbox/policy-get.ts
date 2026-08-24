// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type CliOpenShellSandboxPolicyRead,
  readCliOpenShellSandboxPolicy,
} from "../../adapters/openshell/sandbox-policy-cli";
import { selectedOpenShellGateway } from "../../adapters/openshell/sandbox-observer";

export interface PolicyGetResult {
  raw: string;
  yaml: string;
}

/** Read the round-trippable OpenShell base policy and strip its metadata header. */
export async function getSandboxPolicy(
  sandboxName: string,
  readPolicy: CliOpenShellSandboxPolicyRead = readCliOpenShellSandboxPolicy,
): Promise<PolicyGetResult> {
  const read = await readPolicy({
    target: selectedOpenShellGateway(),
    sandboxName,
    scope: "base",
  });
  if (!read.result.ok) {
    if (read.result.error.kind === "schema") {
      return { raw: read.displayOutput, yaml: "" };
    }
    throw new Error(
      `Failed to retrieve base policy for sandbox '${sandboxName}'. ${read.result.error.message}`,
    );
  }
  return { raw: read.displayOutput, yaml: read.result.value.document };
}
