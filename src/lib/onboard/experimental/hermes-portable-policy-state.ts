// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createCliOpenShellSandboxPolicyReader } from "../../adapters/openshell/sandbox-policy-cli";
import { captureSanitizedResolvedOpenshellAsync } from "../../adapters/openshell/sanitized-capture";
import { namedOpenShellGateway } from "../../adapters/openshell/sandbox-observer";

export interface HermesPortablePolicyCaptureResult {
  readonly status: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly error?: Error;
}

export interface HermesPortablePolicyCapture {
  (
    args: readonly string[],
  ): HermesPortablePolicyCaptureResult | Promise<HermesPortablePolicyCaptureResult>;
}

/** Observe the current OpenShell policy without comparing it with a local desired copy. */
export async function proveHermesPortableLivePolicy(input: {
  readonly gatewayName: string;
  readonly sandboxName: string;
  readonly capture: HermesPortablePolicyCapture;
}): Promise<void> {
  const result = await createCliOpenShellSandboxPolicyReader({
    capture: async (args) => {
      const captured = await input.capture(args);
      return {
        status: captured.status,
        output: captured.stdout.toString(),
        stdout: captured.stdout.toString(),
        stderr: captured.stderr.toString(),
        ...(captured.error ? { error: captured.error } : {}),
      };
    },
  }).readSandboxPolicy({
    target: namedOpenShellGateway(input.gatewayName),
    sandboxName: input.sandboxName,
    scope: "base",
  });
  if (!result.ok) {
    throw new Error("Hermes portable live OpenShell policy read failed");
  }
}

/** Keep policy observation on the receipt-owned executable and child environment. */
export function createHermesPortableAsyncPolicyCapture(
  authority: () => { readonly executablePath: string; readonly env: NodeJS.ProcessEnv },
  timeoutMs: number,
): HermesPortablePolicyCapture {
  return async (args) => {
    const command = authority();
    const result = await captureSanitizedResolvedOpenshellAsync([...args], {
      openshellBinary: command.executablePath,
      env: command.env,
      replaceEnv: true,
      timeout: timeoutMs,
      outputLimitBytes: 512 * 1024,
      includeStreams: true,
      includeStderr: true,
      ignoreError: true,
    });
    return {
      status: result.status,
      stdout: Buffer.from(result.stdout ?? result.output ?? ""),
      stderr: Buffer.from(result.stderr ?? ""),
      ...(result.error ? { error: result.error } : {}),
    };
  };
}
