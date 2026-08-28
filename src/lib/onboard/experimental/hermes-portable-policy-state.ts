// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseOpenShellPolicy } from "../../policy/merge";

export interface HermesPortablePolicyCaptureResult {
  readonly status: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly error?: Error;
}

export interface HermesPortablePolicyCapture {
  (args: readonly string[]): HermesPortablePolicyCaptureResult;
}

function validatePolicy(raw: string | Buffer): void {
  parseOpenShellPolicy(raw.toString());
}

/** Observe the current OpenShell policy without comparing it with a local desired copy. */
export function proveHermesPortableLivePolicy(input: {
  readonly gatewayName: string;
  readonly sandboxName: string;
  readonly capture: HermesPortablePolicyCapture;
}): void {
  const result = input.capture([
    "policy",
    "get",
    "-g",
    input.gatewayName,
    "--base",
    input.sandboxName,
  ]);
  if (result.status !== 0 || result.error) {
    throw new Error("Hermes portable live OpenShell policy read failed");
  }
  validatePolicy(result.stdout);
}
