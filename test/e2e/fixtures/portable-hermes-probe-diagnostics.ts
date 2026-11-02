// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ArtifactSink } from "./artifacts.ts";

export async function recordPortableHermesGatewayProbeFailure(
  artifacts: ArtifactSink,
  sandboxToken: string,
  result: { status: number | null; stdout: string; stderr: string },
): Promise<void> {
  if (result.status === 0) return;
  artifacts.addRedactionValues([sandboxToken]);
  await artifacts.writeJson("portable-hermes-gateway-probe-failure.json", {
    schemaVersion: 1,
    status: result.status,
    stdoutTail: artifacts.redact(result.stdout).slice(-1_024),
    stderrTail: artifacts.redact(result.stderr).slice(-2_048),
  });
}
