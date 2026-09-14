// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

export function directoryChain(directory: string): string[] {
  const parent = path.dirname(directory);
  return parent === directory ? [directory] : [directory, ...directoryChain(parent)];
}

export function poisonUnexpectedCommand(scope: string, args: readonly string[]): never {
  throw new Error(`unexpected ${scope} command: ${args.join(" ")}`);
}

export function startupArgv(sandboxName: string) {
  return [
    "env",
    "NEMOCLAW_HERMES_API_PORT=8642",
    `NEMOCLAW_SANDBOX_NAME=${sandboxName}`,
    "/usr/local/bin/nemoclaw-start",
  ];
}

export function createSandboxListJson(sandboxName: string) {
  return (sandboxId: string, phase: string): string =>
    JSON.stringify([
      {
        id: sandboxId,
        name: sandboxName,
        labels: {},
        resource_version: 1,
        created_at: "2026-01-01T00:00:00Z",
        phase,
        current_policy_version: 1,
      },
    ]);
}

export function openshellMutationCalls(
  capture: { readonly mock: { readonly calls: readonly unknown[][] } },
  operation: "start" | "stop",
) {
  return capture.mock.calls.filter(
    (call) => (call[0] as readonly string[]).slice(0, 2).join(":") === `sandbox:${operation}`,
  );
}
