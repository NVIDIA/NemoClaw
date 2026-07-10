// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { compactText } from "../core/url-utils";
import { redact } from "../security/redact";
import { classifyGatewayStartFailure } from "../validation";

const ANSI_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])/g;

export type FinalGatewayStartFailureOptions = {
  retries: number;
  dockerUnreachable?: boolean;
  collectDiagnostics?: () => string | null | undefined;
  cleanupGateway?: () => void;
  exitProcess?: (code: number) => never;
  printError?: (message?: string) => void;
};

export type FinalGatewayStartFailureDeps = {
  getGatewayName(): string;
  collectDiagnostics(): string | null | undefined;
  cleanupGateway(): void;
};

export function normalizeGatewayStartError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function reportLegacyGatewayStartResultFailure(
  output: string,
  log: (message: string) => void,
) {
  const cleanedOutput = String(output || "").replace(ANSI_RE, "");
  const lines = redact(cleanedOutput)
    .split("\n")
    .map((l) => compactText(l))
    .filter(Boolean)
    .map((l) => `    ${l}`);
  if (lines.length > 0) {
    log(`  Gateway start returned before healthy:\n${lines.join("\n")}`);
  }
  return classifyGatewayStartFailure(cleanedOutput);
}

export function printDockerDaemonRecovery(
  printError: (message?: string) => void,
  platform: NodeJS.Platform = process.platform,
): void {
  printError("  Docker daemon is not running — cannot start the gateway.");
  printError("");
  printError("  Start Docker, then rerun `nemoclaw onboard`:");
  if (platform === "darwin") {
    printError("    colima start            # or start Docker Desktop");
  } else if (platform === "linux") {
    printError("    sudo systemctl start docker");
  } else {
    printError("    Start the Docker daemon.");
  }
}

export function createFinalGatewayStartFailureHandler(deps: FinalGatewayStartFailureDeps) {
  return function handleFinalGatewayStartFailure({
    retries,
    dockerUnreachable = false,
    collectDiagnostics = deps.collectDiagnostics,
    cleanupGateway = deps.cleanupGateway,
    exitProcess = (code) => process.exit(code),
    printError = (message = "") => console.error(message),
  }: FinalGatewayStartFailureOptions): never {
    if (dockerUnreachable) {
      printDockerDaemonRecovery(printError);
      return exitProcess(1);
    }

    const gatewayName = deps.getGatewayName();
    printError(`  Gateway failed to start after ${retries + 1} attempts.`);
    printError("  Gateway state preserved until diagnostics are collected.");
    printError("");

    try {
      const normalizedLogs = String(collectDiagnostics() || "")
        .replace(/\r/g, "")
        .replace(ANSI_RE, "");
      const logs = redact(normalizedLogs);
      if (logs) {
        printError("  Gateway logs:");
        for (const line of logs.split("\n").filter(Boolean)) {
          printError(`    ${line}`);
        }
        printError("");
      }
    } catch {
      // doctor logs unavailable — continue to best-effort cleanup and manual instructions
    }

    printError("  Cleaning up failed gateway state...");
    try {
      cleanupGateway();
      printError("  Cleanup attempted.");
    } catch (error) {
      const message = compactText(error instanceof Error ? error.message : String(error));
      printError(message ? `  Cleanup attempt failed: ${message}` : "  Cleanup attempt failed.");
    }
    printError("");
    printError("  Diagnostic command attempted before cleanup:");
    printError(`    openshell doctor logs --name ${gatewayName}`);
    printError("    openshell doctor check");
    printError("");
    printError("  If gateway cleanup did not complete, run:");
    printError(`    openshell gateway remove ${gatewayName}`);
    printError("    # For OpenShell releases that still expose lifecycle commands:");
    printError(`    openshell gateway destroy -g ${gatewayName}`);
    if (process.platform === "linux") {
      printError(
        "    sudo pkill -f openshell-gateway  # if a privileged host gateway process remains",
      );
    }
    printError(
      `    docker volume ls -q --filter "name=openshell-cluster-${gatewayName}" | xargs -r docker volume rm`,
    );
    printError("    nemoclaw onboard --resume");
    return exitProcess(1);
  };
}
