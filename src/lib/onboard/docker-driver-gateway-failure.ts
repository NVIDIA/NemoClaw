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
import path from "node:path";

import { redact } from "../security/redact";
import { classifyGatewayStartFailure } from "../validation";

import type { ChildExitState } from "./child-exit-tracker";
import { printDockerDaemonRecovery } from "./gateway-start-failure";

export type ReportDockerDriverGatewayStartFailureOpts = {
  /**
   * If true (the default for production call sites), print the failure
   * message set and call `process.exit(1)`. If false (the recovery
   * path), just print and let the caller decide.
   */
  exitOnFailure: boolean;
};

/**
 * Print the recovery choices for a gateway state database that a newer
 * OpenShell wrote.
 *
 * The gateway log sits in the gateway's own state directory, so the caller's
 * log path already locates the database and no extra plumbing is needed.
 *
 * The message names that port-scoped directory rather than
 * `~/.local/state/nemoclaw`, because the parent directory also holds the state
 * of every other gateway port on the host (#4422, #7279).
 */
function printGatewayStateVersionSkewRecovery(
  logPath: string,
  printError: (message?: string) => void,
): void {
  const stateDir = path.dirname(logPath);
  printError(
    "  The gateway state database was written by a newer OpenShell than the installed one.",
  );
  printError(`    State database: ${path.join(stateDir, "openshell.db")}`);
  printError("  Choose one of these actions:");
  printError(
    "    - Install a NemoClaw release that pins the OpenShell version that wrote the database.",
  );
  printError("    - Remove this gateway port's state directory, then onboard again:");
  printError(`        rm -rf ${stateDir}`);
  printError("      The directory holds the OpenShell state for this gateway port only.");
  printError("      Other gateway ports keep their own directories.");
}

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
    ? fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean).slice(-20).join("\n")
    : "";

  console.error("  Docker-driver gateway failed to start.");
  if (childExit.exited) {
    console.error(`  Gateway process ${childExit.describeExit()} before becoming ready.`);
  } else {
    // #5334: the start loop also reaches this reporter when the poll budget is
    // exhausted, or when the process's liveness dropped before its 'exit' event
    // was observed. We therefore do NOT assert the process is "still running"
    // (that would misreport a gateway that already died) and instead state only
    // the observable fact: it never became healthy in time. The status commands
    // in the Troubleshooting footer below are what reveal why.
    console.error("  The gateway process did not become healthy within the timeout.");
  }
  if (tail) {
    console.error("  Gateway log tail:");
    for (const line of tail.split("\n")) console.error(`    ${redact(line)}`);
  }
  const failure = classifyGatewayStartFailure(tail);
  if (failure.kind === "docker_unreachable") {
    printDockerDaemonRecovery(console.error);
  } else if (failure.kind === "gateway_state_version_skew") {
    printGatewayStateVersionSkewRecovery(logPath, console.error);
  }
  console.error("  Troubleshooting:");
  console.error(`    tail -100 ${logPath}`);
  console.error("    openshell status");
  console.error("    openshell gateway info");
  console.error("    docker info --format '{{json .CDISpecDirs}}'");

  if (exitOnFailure) {
    process.exit(1);
  }
}
