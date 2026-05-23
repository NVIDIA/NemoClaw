// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Failure-reporting helper for the Docker-driver gateway startup path in
 * `onboard.ts:startDockerDriverGateway`.
 *
 * When the gateway fails to become healthy within the poll budget, users
 * need three things to debug:
 *
 *   1. The fact of failure ("Docker-driver gateway failed to start.").
 *   2. **Why** the child process died — signal or exit code — when
 *      applicable. Surfaced via `ChildExitState.describeExit()` so users
 *      don't have to `tail` the gateway log just to learn "the binary
 *      was killed by SIGKILL" or "exited with code 127" (#3111).
 *   3. The tail of the gateway log plus a couple of troubleshooting
 *      commands so they know where to look next.
 *
 * Separated from `onboard.ts` because (a) it's a cohesive unit that
 * doesn't depend on any onboard-private state besides the inputs, and
 * (b) `onboard.ts` is the God Object being decomposed — new diagnostic
 * logic should land in focused modules.
 */

import fs from "node:fs";

import { redact } from "../security/redact";

import type { ChildExitState } from "./child-exit-tracker";

export type ReportDockerDriverGatewayStartFailureOpts = {
  /**
   * If true (the default for production call sites), print the failure
   * message set and call `process.exit(1)`. If false (the recovery
   * path), just print and let the caller decide.
   */
  exitOnFailure: boolean;
};

/**
 * Print the standard Docker-driver-gateway-start failure diagnostic set
 * to stderr and either exit or return. Always prints:
 *
 *   - the "failed to start" header,
 *   - the child-exit descriptor when available,
 *   - the last 20 non-blank lines of the gateway log (redacted), and
 *   - a short Troubleshooting footer with the log path and a docker CDI
 *     inspection command.
 */
export function reportDockerDriverGatewayStartFailure(
  logPath: string,
  childExit: ChildExitState,
  { exitOnFailure }: ReportDockerDriverGatewayStartFailureOpts,
): void {
  const tail = fs.existsSync(logPath)
    ? fs
        .readFileSync(logPath, "utf-8")
        .split("\n")
        .filter(Boolean)
        .slice(-20)
        .join("\n")
    : "";

  console.error("  Docker-driver gateway failed to start.");
  if (childExit.exited) {
    console.error(
      `  Gateway process ${childExit.describeExit()} before becoming ready.`,
    );
  }
  if (tail) {
    console.error("  Gateway log tail:");
    for (const line of tail.split("\n")) console.error(`    ${redact(line)}`);
  }
  console.error("  Troubleshooting:");
  console.error(`    tail -100 ${logPath}`);
  console.error("    docker info --format '{{json .CDISpecDirs}}'");

  if (exitOnFailure) {
    process.exit(1);
  }
}
