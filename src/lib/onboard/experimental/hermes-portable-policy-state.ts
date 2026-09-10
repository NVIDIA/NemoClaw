// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createSyncCliOpenShellSandboxPolicyReader } from "../../adapters/openshell/sandbox-policy-cli";
import { namedOpenShellGateway } from "../../adapters/openshell/sandbox-observer";

export interface HermesPortablePolicyCaptureResult {
  readonly status: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly error?: Error;
}

export interface HermesPortablePolicyCapture {
  (args: readonly string[]): HermesPortablePolicyCaptureResult;
}

/** Observe the current OpenShell policy without comparing it with a local desired copy. */
export function proveHermesPortableLivePolicy(input: {
  readonly gatewayName: string;
  readonly sandboxName: string;
  readonly capture: HermesPortablePolicyCapture;
}): void {
  const result = createSyncCliOpenShellSandboxPolicyReader({
    capture: (args) => {
      const captured = input.capture(args);
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
