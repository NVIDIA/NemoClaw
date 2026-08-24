// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isPortableExperimentalProfile } from "./experimental/portable-profile";
import { onboardResumeRecoveryCommand } from "./resume-hint";

export function normalizeGatewayStartError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function printDockerDaemonRecovery(
  printError: (message?: string) => void,
  platform: NodeJS.Platform = process.platform,
  portable = isPortableExperimentalProfile(),
): void {
  if (portable) {
    printError("  The rootless Podman API service is not reachable.");
    printError("");
    printError(`  Start Podman, then rerun: ${onboardResumeRecoveryCommand()}`);
    return;
  }

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
