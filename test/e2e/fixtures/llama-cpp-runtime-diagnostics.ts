// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ContainerEngine } from "../../../src/lib/adapters/container-engine.ts";
import type { ArtifactSink } from "./artifacts.ts";

export async function captureManagedLlamaCppRuntimeLogs(
  engine: Pick<ContainerEngine, "capture">,
  artifacts: Pick<ArtifactSink, "writeJson">,
  runtime: { providerId: string; runtimeId: string },
  phase: "setup" | "post-agent" | "failure",
): Promise<void> {
  const logs = engine.capture(["container", "logs", "--tail", "20000", runtime.runtimeId], 30_000);
  await artifacts.writeJson(`managed-runtime-logs-${phase}.json`, {
    ...runtime,
    status: logs.status,
    error: logs.error?.message ?? null,
    stdout: logs.stdout,
    stderr: logs.stderr,
  });
}

/** Keep the owned backend's failure evidence before registered teardown removes it. */
export async function withManagedLlamaCppFailureDiagnostics(
  run: () => Promise<void>,
  engine: Pick<ContainerEngine, "capture">,
  artifacts: Pick<ArtifactSink, "writeJson">,
  runtime: { providerId: string; runtimeId: string },
): Promise<void> {
  let completed = false;
  try {
    await run();
    completed = true;
  } finally {
    if (!completed) {
      try {
        await captureManagedLlamaCppRuntimeLogs(engine, artifacts, runtime, "failure");
      } catch {
        // Diagnostic transport or storage failure must preserve the original assertion.
      }
    }
  }
}
