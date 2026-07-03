// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { compactText } from "../core/url-utils";
import { redact } from "../security/redact";
import { classifyGatewayStartFailure } from "../validation";

const ANSI_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])/g;

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
