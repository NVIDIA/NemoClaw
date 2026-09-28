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
import { isPortableExperimentalProfile } from "./experimental/portable-profile";
import { printDockerDaemonRecovery } from "./gateway-start-failure";
import {
  noteOnboardResumeHintShown,
  onboardFreshRecoveryCommand,
  onboardResumeRecoveryCommand,
} from "./resume-hint";

export type ReportDockerDriverGatewayStartFailureOpts = {
  exitOnFailure: boolean;
  /** Selected host port, used to print a fresh listener-verification command. */
  gatewayPort?: number;
  /** Byte offset where the current gateway launch began writing the append-only log. */
  launchLogOffset: number;
  /** Identity-aware selected-state ownership probe supplied by the onboarding runtime. */
  isGatewayStateInUse?: () => boolean;
  /** Return a stop command only after the caller proves selected port and state ownership. */
  resolveGatewayStopCommand?: () => string | null;
  printError?: (message?: string) => void;
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
 * A managed service is stopped before onboarding retries only when it owns the
 * selected port and state. The retry re-evaluates ownership before it can
 * offer the state move. Standalone gateways receive the move only after the
 * runtime confirms that no matching gateway process still uses the selected
 * state (#8797, #11720).
 */
function printIncompatibleGatewayDatabaseRecovery(
  logPath: string,
  gatewayPort: number | undefined,
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
  printError(
    "  The database records a migration that this OpenShell version does not include, or defines with different contents.",
  );
  printError("  This can happen after an OpenShell downgrade.");
  const stopCommand = resolveGatewayStopCommand();
  if (stopCommand) {
    printError(
      "  Stop the selected gateway service, then run onboarding again so NemoClaw can verify that no gateway process still uses the selected state:",
    );
    printError(`    ${stopCommand} && ${recoveryCommand}`);
    printError(
      "  The stop command applies only to the verified listener. Onboarding checks all gateway processes again before it offers a state move.",
    );
    noteOnboardResumeHintShown();
    return;
  }
  if (isGatewayStateInUse?.() !== false) {
    printError("  NemoClaw could not confirm that the standalone gateway process stopped.");
    printError("  Inspect the current listener before stopping anything:");
    printError(
      gatewayPort === undefined
        ? "    sudo lsof -iTCP -sTCP:LISTEN -P -n"
        : `    sudo lsof -i :${gatewayPort} -sTCP:LISTEN -P -n`,
    );
    printError("  Verify each listed PID's user and full command:");
    printError("    ps -p <PID> -o user=,args=");
    printError(
      "  Stop it through its verified owning service or installation. Otherwise, repeat both checks immediately before signaling only that PID.",
    );
    printError("  Do not infer ownership from the process name.");
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
  printError("  Create the archive, move the selected gateway state, then continue onboarding:");
  printError(`    ${move}`);
  noteOnboardResumeHintShown();
}

export function reportDockerDriverGatewayStartFailure(
  logPath: string,
  childExit: ChildExitState,
  {
    exitOnFailure,
    gatewayPort,
    launchLogOffset,
    isGatewayStateInUse,
    printError = console.error,
    resolveGatewayStopCommand = () => null,
  }: ReportDockerDriverGatewayStartFailureOpts,
): void {
  const logBytes = fs.existsSync(logPath) ? fs.readFileSync(logPath) : Buffer.alloc(0);
  const currentLaunchLog = logBytes
    .subarray(Math.min(Math.max(launchLogOffset, 0), logBytes.length))
    .toString("utf-8");
  const tail = currentLaunchLog.split("\n").filter(Boolean).slice(-20).join("\n");

  printError("  Docker-driver gateway failed to start.");
  if (childExit.exited) {
    printError(`  Gateway process ${childExit.describeExit()} before becoming ready.`);
  } else {
    printError("  The gateway process did not become healthy within the timeout.");
  }
  if (tail) {
    printError("  Gateway log tail:");
    for (const line of tail.split("\n")) printError(`    ${redact(line)}`);
  }
  const failure = classifyGatewayStartFailure(tail);
  if (failure.kind === "docker_unreachable") {
    printDockerDaemonRecovery(printError);
  } else if (failure.kind === "database_migration_incompatible") {
    printIncompatibleGatewayDatabaseRecovery(
      logPath,
      gatewayPort,
      isGatewayStateInUse,
      resolveGatewayStopCommand,
      printError,
    );
  }
  printError("  Troubleshooting:");
  printError(`    tail -100 ${logPath}`);
  printError("    openshell status");
  printError("    openshell gateway info");
  printError("    docker info --format '{{json .CDISpecDirs}}'");

  if (exitOnFailure) process.exit(1);
}
