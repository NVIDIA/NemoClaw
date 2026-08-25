// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncReturns } from "node:child_process";

import { createArtifactSink } from "./artifacts.ts";

function failureReason(result: SpawnSyncReturns<string>): string {
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return code === "ETIMEDOUT" ? "timed out" : "failed to execute";
  }
  if (result.signal) return `terminated by ${result.signal}`;
  return `exited with status ${String(result.status)}`;
}

export async function requireSuccessfulPolicyBoundaryBuild(
  result: SpawnSyncReturns<string>,
): Promise<void> {
  if (result.status === 0) return;

  const diagnosticPath = await createArtifactSink("hermes-discord-policy-binding").writeText(
    "policy-boundary-build.log",
    [result.stderr, result.stdout, result.error?.message].filter(Boolean).join("\n"),
  );
  throw new Error(
    `Policy boundary build ${failureReason(result)}; see redacted diagnostic artifact: ${diagnosticPath}`,
  );
}
