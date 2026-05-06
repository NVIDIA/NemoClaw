// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "./branding";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "./adapters/openshell/timeouts";
import { G, R } from "./terminal-style";

export interface ShareCommandDeps {
  /** Run `openshell sandbox ssh-config <name>` and return output. */
  getSshConfig: (sandboxName: string) => { status: number | null; output: string };
  /** Ensure the sandbox is live, exit process if not. */
  ensureLive: (sandboxName: string) => Promise<void>;
  /** NVIDIA-green ANSI code (empty string if color disabled). */
  colorGreen: string;
  /** ANSI reset code (empty string if color disabled). */
  colorReset: string;
  /** CLI executable name for user-facing messages (supports alias launchers). */
  cliName: string;
}

export function buildShareCommandDeps(): ShareCommandDeps {
  const { captureOpenshell } = require("./adapters/openshell/runtime") as {
    captureOpenshell: (
      args: string[],
      opts?: { ignoreError?: boolean; timeout?: number },
    ) => { status: number | null; output: string };
  };
  const { ensureLiveSandboxOrExit } = require("./sandbox-gateway-state-action") as {
    ensureLiveSandboxOrExit: (sandboxName: string) => Promise<unknown>;
  };

  return {
    getSshConfig: (sandboxName: string) =>
      captureOpenshell(["sandbox", "ssh-config", sandboxName], {
        ignoreError: true,
        timeout: OPENSHELL_PROBE_TIMEOUT_MS,
      }),
    ensureLive: async (sandboxName: string) => {
      await ensureLiveSandboxOrExit(sandboxName);
    },
    colorGreen: G,
    colorReset: R,
    cliName: CLI_NAME,
  };
}
