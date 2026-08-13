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
import { NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE } from "./docker-driver-gateway-service";
import { printDockerDaemonRecovery } from "./gateway-start-failure";
import { noteOnboardResumeHintShown, onboardRecoveryCommand } from "./resume-hint";

export type ReportDockerDriverGatewayStartFailureOpts = {
  /**
   * If true (the default for production call sites), print the failure
   * message set and call `process.exit(1)`. If false (the recovery
   * path), just print and let the caller decide.
   */
  exitOnFailure: boolean;
  /** Byte offset where the current gateway launch began writing the append-only log. */
  launchLogOffset: number;
  /**
   * Override the recorded-process liveness check. Tests inject it; production
   * uses {@link recordedGatewayProcessStopped}.
   */
  isGatewayProcessStopped?: (stateDir: string) => boolean;
};

/**
 * Report whether the gateway process recorded for `stateDir` has stopped.
 *
 * `childExit.exited` alone cannot answer this: the reporter is also reached
 * after the health poll budget expires. `process.kill(pid, 0)` cannot answer it
 * either, because `startDockerDriverGateway` spawns the gateway detached and
 * never reaps it, so a crashed gateway stays a zombie and reports as alive.
 * Reading the process state directly separates a zombie from a live gateway.
 *
 * An unreadable or absent record returns false. The caller then withholds the
 * state move, because a missing record is not evidence that no gateway runs
 * (#8797, advisor finding PRA-1).
 */
export function recordedGatewayProcessStopped(stateDir: string): boolean {
  let pid: number;
  try {
    pid = Number.parseInt(
      fs.readFileSync(path.join(stateDir, "openshell-gateway.pid"), "utf-8").trim(),
      10,
    );
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Field 3 of /proc/<pid>/stat is the process state. `Z` marks a zombie,
    // which holds no state directory.
    return fs.readFileSync(`/proc/${String(pid)}/stat`, "utf-8").split(" ")[2] === "Z";
  } catch {
    // The recorded process is gone, so nothing holds the state directory.
    return true;
  }
}

function findAvailableGatewayStateArchivePath(stateDir: string): string | null {
  for (let suffix = 1; suffix <= 100; suffix += 1) {
    const candidate = `${stateDir}.incompatible${suffix === 1 ? "" : `-${suffix}`}`;
    try {
      fs.lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidate;
      return null;
    }
  }
  return null;
}

/**
 * Print the incompatible-database diagnosis and its state-move recovery.
 *
 * The diagnosis prints whether or not this process observed the gateway exit.
 * `startDockerDriverGateway` also reaches this reporter after the poll budget
 * expires, and after the child's liveness dropped before its `exit` event
 * arrived (#5334). A gateway that dies on this failure therefore reports
 * `childExit.exited === false` on the reported downgrade path, and gating the
 * whole diagnosis on that flag left that path with no diagnosis at all (#8797).
 *
 * The state move needs stronger evidence than the diagnosis, because moving the
 * directory while a gateway process still runs leaves that process without its
 * state. This helper prints the move only when the reporter itself established
 * that no gateway process holds the directory: either the child's `exit` event
 * fired, or the recorded gateway process is gone. A user-run check cannot carry
 * that weight, because `Restart=on-failure` in the managed unit can start a
 * replacement between the check and the move.
 */
function printIncompatibleGatewayDatabaseRecovery(
  logPath: string,
  childExit: ChildExitState,
  isGatewayProcessStopped: (stateDir: string) => boolean,
  printError: (message?: string) => void,
): void {
  const stateDir = path.dirname(logPath);
  printError("  The installed OpenShell version cannot use the existing gateway database.");
  printError(`  Database: ${path.join(stateDir, "openshell.db")}`);
  printError("  The database records a migration that this OpenShell version does not include.");
  printError("  This can happen after an OpenShell downgrade.");
  const gatewayStopped = childExit.exited || isGatewayProcessStopped(stateDir);
  if (!gatewayStopped) {
    printError("  NemoClaw could not confirm that the gateway process stopped.");
    printError("  Stop the gateway, then run onboarding again:");
    printError(`    systemctl --user stop ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE}`);
    printError(`    ${onboardRecoveryCommand()}`);
    printError(
      "  A gateway process that keeps running after the move writes to a path that no longer holds its state.",
    );
    noteOnboardResumeHintShown();
    return;
  }
  const archivePath = findAvailableGatewayStateArchivePath(stateDir);
  if (!archivePath) {
    printError("  NemoClaw could not select an unused archive path for the gateway state.");
    printError("  Keep the gateway stopped and inspect the state directory before recovery.");
    noteOnboardResumeHintShown();
    return;
  }
  const [stateDirArg, archivePathArg, archivedStatePathArg] = [
    stateDir,
    archivePath,
    path.join(archivePath, "gateway-state"),
  ].map((value) => `'${value.replaceAll("'", `'\\''`)}'`);
  printError(
    "  The selected gateway state contains credentials and all registrations for this gateway.",
  );
  printError("  Keep the archive owner-only until every required registration is restored.");
  printError("  Create the archive, move the selected gateway state, then continue onboarding:");
  printError(
    `    mkdir -m 700 ${archivePathArg} && mv ${stateDirArg} ${archivedStatePathArg} && ${onboardRecoveryCommand()}`,
  );
  noteOnboardResumeHintShown();
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
  {
    exitOnFailure,
    launchLogOffset,
    isGatewayProcessStopped = recordedGatewayProcessStopped,
  }: ReportDockerDriverGatewayStartFailureOpts,
): void {
  const logBytes = fs.existsSync(logPath) ? fs.readFileSync(logPath) : Buffer.alloc(0);
  const currentLaunchLog = logBytes
    .subarray(Math.min(Math.max(launchLogOffset, 0), logBytes.length))
    .toString("utf-8");
  const tail = currentLaunchLog.split("\n").filter(Boolean).slice(-20).join("\n");

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
  } else if (failure.kind === "database_migration_incompatible") {
    printIncompatibleGatewayDatabaseRecovery(
      logPath,
      childExit,
      isGatewayProcessStopped,
      console.error,
    );
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
