// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const CONTAINER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;

export interface FailedStartupProcessControlCommands {
  pauseSupervisor: string[];
  resumeSupervisor: string[];
  terminateStartupChild: string[];
}

export async function resumeSupervisorIfPaused(
  paused: boolean,
  resume: () => Promise<void>,
): Promise<void> {
  if (paused) await resume();
}

export function failedStartupProcessControlCommands(
  containerId: string,
  startupPid: number,
): FailedStartupProcessControlCommands {
  if (!CONTAINER_ID_PATTERN.test(containerId)) {
    throw new Error("container id must be a safe Docker identifier");
  }
  if (!Number.isSafeInteger(startupPid) || startupPid <= 1) {
    throw new Error("startup child pid must be a safe integer greater than 1");
  }

  const signal = (name: "CONT" | "STOP" | "TERM", pid: number): string[] => [
    "exec",
    "--user",
    "0",
    containerId,
    "kill",
    `-${name}`,
    String(pid),
  ];

  return {
    pauseSupervisor: signal("STOP", 1),
    resumeSupervisor: signal("CONT", 1),
    terminateStartupChild: signal("TERM", startupPid),
  };
}
