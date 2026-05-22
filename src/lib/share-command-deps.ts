// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "./cli/branding";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "./adapters/openshell/timeouts";
import { G, R } from "./cli/terminal-style";

export interface ShareCommandDeps {
  /** Run `openshell sandbox ssh-config <name>` and return output. */
  getSshConfig: (sandboxName: string) => { status: number | null; output: string };
  /** Ensure the sandbox is live, exit process if not. */
  ensureLive: (sandboxName: string) => Promise<void>;
  /**
   * Check whether `remotePath` exists inside the sandbox via
   * `openshell sandbox exec -n <name> -- test -e <remotePath>`. Returns true when
   * the path exists; false when it is missing, when the sandbox is unreachable,
   * or when the exec itself fails. Used by `share mount` as a pre-flight
   * before invoking `sshfs`, which exits non-zero with empty stderr on a
   * missing remote path and leaves the user with nothing actionable. See #3414.
   */
  checkSandboxPathExists: (sandboxName: string, remotePath: string) => boolean;
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
  const { ensureLiveSandboxOrExit } = require("./actions/sandbox/gateway-state") as {
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
    checkSandboxPathExists: (sandboxName: string, remotePath: string) => {
      const result = captureOpenshell(
        ["sandbox", "exec", "-n", sandboxName, "--", "test", "-e", remotePath],
        { ignoreError: true, timeout: OPENSHELL_PROBE_TIMEOUT_MS },
      );
      return result.status === 0;
    },
    colorGreen: G,
    colorReset: R,
    cliName: CLI_NAME,
  };
}
