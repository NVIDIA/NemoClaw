// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Failure-reporting helper for the Docker-driver gateway startup path in
 * `onboard.ts:startDockerDriverGateway`.
 */

import fs from "node:fs";
import path from "node:path";

import { redact } from "../security/redact";
import { classifyGatewayStartFailure } from "../validation";

import type { ChildExitState } from "./child-exit-tracker";
import { getOpenShellGatewayServiceStopCommand } from "./docker-driver-gateway-service";
import { isPortableExperimentalProfile } from "./experimental/portable-profile";
import { printDockerDaemonRecovery } from "./gateway-start-failure";
import {
  noteOnboardResumeHintShown,
  onboardFreshRecoveryCommand,
  onboardResumeRecoveryCommand,
} from "./resume-hint";

export type ReportDockerDriverGatewayStartFailureOpts = {
  exitOnFailure: boolean;
  /** Byte offset where the current gateway launch began writing the append-only log. */
  launchLogOffset: number;
  /** Identity-aware selected-state ownership probe supplied by the onboarding runtime. */
  isGatewayStateInUse?: () => boolean;
  /** Resolve the service-manager stop command, or null for a standalone gateway. */
  resolveGatewayStopCommand?: () => string | null;
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
 * Print the incompatible-database diagnosis and its state-move recovery.
 *
 * Managed gateways stop their owning service in the same command chain as the
 * state move, so `Restart=on-failure` cannot replace the process between a
 * separate check and the move. Standalone gateways have no manager to stop and
 * receive the move only after the runtime confirms that no matching gateway
 * process still uses the selected state (#8797; advisor findings PRA-1/PRA-2).
 */
function printIncompatibleGatewayDatabaseRecovery(
  logPath: string,
  isGatewayStateInUse: (() => boolean) | undefined,
  resolveGatewayStopCommand: () => string | null,
  printError: (message?: string) => void,
): void {
  const stateDir = path.dirname(logPath);
  const recoveryCommand = isPortableExperimentalProfile()
    ? onboardFreshRecoveryCommand(true)
    : onboardResumeRecoveryCommand();
  printError("  The installed OpenShell version cannot use the existing gateway database.");
  printError(`  Database: ${path.join(stateDir, "openshell.db")}`);
  printError("  The database records a migration that this OpenShell version does not include.");
  printError("  This can happen after an OpenShell downgrade.");
  const stopCommand = resolveGatewayStopCommand();
  if (!stopCommand && isGatewayStateInUse?.() !== false) {
    printError("  NemoClaw could not confirm that the standalone gateway process stopped.");
    printError("  Stop the gateway, then run onboarding again:");
    printError(`    ${recoveryCommand}`);
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
  const move = `mkdir -m 700 ${archivePathArg} && mv ${stateDirArg} ${archivedStatePathArg} && ${recoveryCommand}`;
  printError(
    stopCommand
      ? "  Stop the gateway, create the archive, move the selected gateway state, then continue onboarding:"
      : "  Create the archive, move the selected gateway state, then continue onboarding:",
  );
  printError(`    ${stopCommand ? `${stopCommand} && ${move}` : move}`);
  noteOnboardResumeHintShown();
}

export function reportDockerDriverGatewayStartFailure(
  logPath: string,
  childExit: ChildExitState,
  {
    exitOnFailure,
    launchLogOffset,
    isGatewayStateInUse,
    resolveGatewayStopCommand = getOpenShellGatewayServiceStopCommand,
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
      isGatewayStateInUse,
      resolveGatewayStopCommand,
      console.error,
    );
  }
  console.error("  Troubleshooting:");
  console.error(`    tail -100 ${logPath}`);
  console.error("    openshell status");
  console.error("    openshell gateway info");
  console.error("    docker info --format '{{json .CDISpecDirs}}'");

  if (exitOnFailure) process.exit(1);
}
