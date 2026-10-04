// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const PROCESS_LIST_ARGS = ["ps", "-axo", "pid=,ppid=,command="] as const;

export type ProcessListCapture = (args: typeof PROCESS_LIST_ARGS) => string;

export function hasOpenShellVmDriverChildProcessFromPsOutput(
  gatewayPid: number,
  psOutput: string,
): boolean {
  if (!Number.isInteger(gatewayPid) || gatewayPid <= 0) return false;
  return psOutput.split(/\r?\n/).some((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) return false;
    const childPid = Number.parseInt(match[1], 10);
    const parentPid = Number.parseInt(match[2], 10);
    const command = match[3];
    return (
      Number.isInteger(childPid) &&
      childPid > 0 &&
      parentPid === gatewayPid &&
      command.includes("openshell-driver-vm")
    );
  });
}

export function hasOpenShellVmDriverChildProcess(
  gatewayPid: number,
  captureProcessList: ProcessListCapture,
): boolean {
  return hasOpenShellVmDriverChildProcessFromPsOutput(
    gatewayPid,
    captureProcessList(PROCESS_LIST_ARGS),
  );
}
