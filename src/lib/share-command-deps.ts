// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { OPENSHELL_PROBE_TIMEOUT_MS } from "./openshell-timeouts";
import { CLI_NAME } from "./branding";

export interface ShareCommandDeps {
  /** Run `openshell sandbox ssh-config <name>` and return output. */
  getSshConfig: (sandboxName: string) => { status: number; output: string };
  /** Ensure the sandbox is live, exit process if not. */
  ensureLive: (sandboxName: string) => Promise<void>;
  /** NVIDIA-green ANSI code (empty string if color disabled). */
  colorGreen: string;
  /** ANSI reset code (empty string if color disabled). */
  colorReset: string;
  /** CLI executable name for user-facing messages (supports alias launchers). */
  cliName: string;
}

interface ShareRuntimeBridge {
  captureOpenshell: (
    args: string[],
    opts?: { ignoreError?: boolean; timeout?: number },
  ) => { status: number; output: string };
  ensureLiveSandboxOrExit: (sandboxName: string) => Promise<void>;
  G: string;
  R: string;
}

function getRuntimeBridge(): ShareRuntimeBridge {
  return require("../nemoclaw") as ShareRuntimeBridge;
}

export function buildShareCommandDeps(): ShareCommandDeps {
  const runtime = getRuntimeBridge();

  return {
    getSshConfig: (sandboxName: string) =>
      runtime.captureOpenshell(["sandbox", "ssh-config", sandboxName], {
        ignoreError: true,
        timeout: OPENSHELL_PROBE_TIMEOUT_MS,
      }),
    ensureLive: (sandboxName: string) => runtime.ensureLiveSandboxOrExit(sandboxName),
    colorGreen: runtime.G,
    colorReset: runtime.R,
    cliName: CLI_NAME,
  };
}
