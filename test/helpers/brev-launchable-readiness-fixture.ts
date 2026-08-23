// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ShellProbeResult } from "../e2e/fixtures/shell-probe.ts";
import { result, workspaceResult } from "./brev-launchable-client-fixture.ts";

export function failingReadinessCommand(): {
  command: (_binary: string, args: string[]) => Promise<ShellProbeResult>;
  replace(): void;
} {
  let id = "owned-id";
  let created = false;
  return {
    replace() {
      id = "replacement-id";
    },
    async command(_binary, args) {
      switch (args[0]) {
        case "ls": {
          if (!created) return result({ workspaces: [] });
          const record = JSON.parse(workspaceResult(id).stdout) as {
            workspaces: Array<Record<string, unknown>>;
          };
          record.workspaces[0]!.status = "FAILED";
          return result(record);
        }
        case "create":
          created = true;
          return result("");
        default:
          throw new Error(`unexpected command: ${args.join(" ")}`);
      }
    },
  };
}
