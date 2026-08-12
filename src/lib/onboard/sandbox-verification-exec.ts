// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Run a shell snippet inside the named sandbox for verifyDeployment probes.
 * Returns null when the OpenShell exec itself fails to spawn or times out —
 * the verify layer treats that as "sandbox unreachable" rather than a probe
 * result, so we deliberately swallow spawn errors here.
 */

import { spawnSync } from "node:child_process";

import { getOpenshellBinary } from "../adapters/openshell/runtime";

const SANDBOX_EXEC_TIMEOUT_MS = 15000;
type Capture = (cmd: readonly string[], options: { ignoreError: boolean }) => string;

export function executeSandboxCommandForVerification(
  sandboxName: string,
  script: string,
): { status: number; stdout: string; stderr: string } | null {
  try {
    const result = spawnSync(
      getOpenshellBinary(),
      ["sandbox", "exec", "-n", sandboxName, "--", "sh", "-c", script],
      { encoding: "utf-8", timeout: SANDBOX_EXEC_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] },
    );
    if (result.error) return null;
    return {
      status: result.status ?? 1,
      stdout: (result.stdout || "").trim(),
      stderr: (result.stderr || "").trim(),
    };
  } catch {
    return null;
  }
}

export function probeHostPortForVerification(port: number, path: string, capture: Capture): number {
  const result = capture(
    [
      "curl",
      "-so",
      "/dev/null",
      "-w",
      "%{http_code}",
      "--max-time",
      "3",
      `http://127.0.0.1:${port}${path}`,
    ],
    { ignoreError: true },
  );
  return parseInt(result.trim(), 10) || 0;
}
