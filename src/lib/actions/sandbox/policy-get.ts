// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createCliOpenShellSandboxPolicyRead,
  type CapturePolicyCommand,
  type CliOpenShellSandboxPolicyRead,
} from "../../adapters/openshell/sandbox-policy-cli";
import { buildOpenshellCommand } from "../../adapters/openshell/command-argv";
import { selectedOpenShellGateway } from "../../adapters/openshell/sandbox-observer";
import { runCaptureEx } from "../../runner";

export interface PolicyGetResult {
  raw: string;
  yaml: string;
}

const capturePolicyWithRunner: CapturePolicyCommand = (args, options) => {
  const captured = runCaptureEx(buildOpenshellCommand(args), { timeout: options.timeout });
  const output = [captured.stdout, captured.stderr].filter(Boolean).join("\n");
  const error = captured.timedOut
    ? Object.assign(new Error("OpenShell policy read timed out"), { code: "ETIMEDOUT" })
    : undefined;
  return {
    status: captured.exitCode,
    output,
    stdout: captured.stdout,
    stderr: captured.stderr,
    ...(error ? { error } : {}),
  };
};

/** Read the round-trippable OpenShell base policy and strip its metadata header. */
export async function getSandboxPolicy(
  sandboxName: string,
  readPolicy: CliOpenShellSandboxPolicyRead = createCliOpenShellSandboxPolicyRead({
    capture: capturePolicyWithRunner,
  }),
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
