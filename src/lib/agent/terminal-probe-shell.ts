// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "./defs";

export function terminalProbeShell(agent: AgentDefinition): {
  readonly execArgs: readonly string[];
  readonly nestedCommandUsesLoginShell: boolean;
} {
  if (agent.name === "pi") {
    return {
      execArgs: [
        "--env",
        "BASH_ENV=",
        "--env",
        "ENV=",
        "--",
        "bash",
        "--noprofile",
        "--norc",
        "-c",
      ],
      nestedCommandUsesLoginShell: false,
    };
  }
  return {
    execArgs: ["--", "sh", "-lc"],
    nestedCommandUsesLoginShell: true,
  };
}
