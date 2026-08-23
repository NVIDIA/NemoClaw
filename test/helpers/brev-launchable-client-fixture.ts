// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Mock } from "vitest";

import type { ShellProbeResult } from "../e2e/fixtures/shell-probe.ts";

export function lifecycleCommand(): {
  command: Mock<(...args: any[]) => Promise<ShellProbeResult>>;
  absentReads: () => number;
} {
  let present = false;
  let absent = 0;
  return {
    absentReads: () => absent,
    command: async (_binary: string, args: string[]) => {
      switch (args[0]) {
        case "ls":
          if (!present) {
            absent += 1;
            return result({ workspaces: [] });
          }
          return workspaceResult("workspace-id");
        case "create":
          present = true;
          return result("");
        case "delete":
          present = false;
          return result("");
        case "refresh":
          return result("");
        default:
          throw new Error(`unexpected command: ${args.join(" ")}`);
      }
    },
  } as unknown as {
    command: Mock<(...args: any[]) => Promise<ShellProbeResult>>;
    absentReads: () => number;
  };
}

export function workspaceResult(id: string): ShellProbeResult {
  return result({
    workspaces: [
      {
        name: "fixture-workspace",
        id,
        status: "RUNNING",
        build_status: "COMPLETED",
        shell_status: "READY",
      },
    ],
  });
}

export function result(stdout: string | unknown): ShellProbeResult {
  return {
    command: [],
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
    stderr: "",
    artifacts: { stdout: "", stderr: "", result: "" },
  };
}
