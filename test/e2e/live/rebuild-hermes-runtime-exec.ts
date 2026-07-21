// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function buildHermesRuntimeExecArgs(containerId: string, command: string[]): string[] {
  return [
    "exec",
    "--user",
    "sandbox",
    "--env",
    "HOME=/sandbox",
    "--env",
    "HERMES_HOME=/sandbox/.hermes",
    containerId,
    ...command,
  ];
}
