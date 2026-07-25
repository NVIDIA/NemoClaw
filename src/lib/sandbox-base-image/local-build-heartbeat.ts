// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_CHILD_SCRIPT = [
  "const intervalMs = Number(process.argv[1]);",
  "const parentPid = Number(process.argv[2]);",
  "const startedAt = Date.now();",
  "const stop = () => process.exit(0);",
  'process.on("SIGINT", stop);',
  'process.on("SIGTERM", stop);',
  "setInterval(() => {",
  "  try { process.kill(parentPid, 0); } catch { stop(); return; }",
  "  const elapsedSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));",
  "  process.stdout.write(`  ⏳ Still working on sandbox base image build… (${elapsedSeconds}s elapsed)\\n`);",
  "}, intervalMs);",
].join("\n");

type SpawnHeartbeat = typeof spawn;

export interface LocalBuildHeartbeatOptions {
  intervalMs?: number;
  nodeExecutable?: string;
  parentPid?: number;
  spawnImpl?: SpawnHeartbeat;
}

/** Keep quiet synchronous Docker builds observable without exposing their captured logs. */
export function withLocalBuildHeartbeat<T>(
  build: () => T,
  options: LocalBuildHeartbeatOptions = {},
): T {
  const intervalMs =
    typeof options.intervalMs === "number" && options.intervalMs > 0
      ? Math.floor(options.intervalMs)
      : DEFAULT_HEARTBEAT_INTERVAL_MS;
  let child: ReturnType<SpawnHeartbeat> | null = null;
  try {
    child = (options.spawnImpl ?? spawn)(
      options.nodeExecutable ?? process.execPath,
      ["-e", HEARTBEAT_CHILD_SCRIPT, String(intervalMs), String(options.parentPid ?? process.pid)],
      { env: {}, stdio: ["ignore", "inherit", "inherit"] },
    );
    child.on("error", () => undefined);
    child.unref();
  } catch {
    child = null;
  }

  try {
    return build();
  } finally {
    try {
      child?.kill("SIGTERM");
    } catch {
      // Progress reporting must never replace the Docker build result.
    }
  }
}
