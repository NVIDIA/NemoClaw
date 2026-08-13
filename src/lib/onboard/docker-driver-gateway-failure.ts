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
};

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
  { exitOnFailure, launchLogOffset }: ReportDockerDriverGatewayStartFailureOpts,
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
  } else if (failure.kind === "database_migration_incompatible" && childExit.exited) {
    const stateDir = path.dirname(logPath);
    const databasePath = path.join(stateDir, "openshell.db");
    console.error("  The installed OpenShell version cannot use the existing gateway database.");
    console.error(`  Database: ${databasePath}`);
    console.error("  The database records a migration that this OpenShell version does not include.");
    console.error("  This can happen after an OpenShell downgrade.");
    const archivePath = findAvailableGatewayStateArchivePath(stateDir);
    if (archivePath) {
      const archivedStatePath = path.join(archivePath, "gateway-state");
      const [stateDirArg, archivePathArg, archivedStatePathArg] = [
        stateDir,
        archivePath,
        archivedStatePath,
      ].map(
        (value) => `'${value.replaceAll("'", `'\\''`)}'`,
      );
      console.error(
        "  The selected gateway state contains credentials and all registrations for this gateway.",
      );
      console.error("  Keep the archive owner-only until every required registration is restored.");
      console.error(
        "  Create the archive, move the selected gateway state, then continue onboarding:",
      );
      console.error(
        `    mkdir -m 700 ${archivePathArg} && mv ${stateDirArg} ${archivedStatePathArg} && ${onboardRecoveryCommand()}`,
      );
      noteOnboardResumeHintShown();
    } else {
      console.error("  NemoClaw could not select an unused archive path for the gateway state.");
      console.error("  Keep the gateway stopped and inspect the state directory before recovery.");
      noteOnboardResumeHintShown();
    }
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
