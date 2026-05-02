// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- thin oclif adapter covered through CLI integration tests. */

import { Command } from "@oclif/core";

import type { CaptureOpenshellResult } from "./openshell";
import type { RunDebugCommandDeps } from "./debug-command";
import { CLI_NAME } from "./branding";
import { runDebug } from "./debug";
import { runDebugCommand } from "./debug-command";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "./openshell-timeouts";
import { captureOpenshellCommand } from "./openshell";
import { parseLiveSandboxNames } from "./runtime-recovery";
import * as registry from "./registry";
import { resolveOpenshell } from "./resolve-openshell";

const useColor = !process.env.NO_COLOR && !!process.stderr.isTTY;
const B = useColor ? "\x1b[1m" : "";
const R = useColor ? "\x1b[0m" : "";
const RD = useColor ? "\x1b[1;31m" : "";

function captureOpenshell(rootDir: string, args: string[]): CaptureOpenshellResult {
  const openshell = resolveOpenshell();
  if (!openshell) {
    return { status: 1, output: "" };
  }
  return captureOpenshellCommand(openshell, args, {
    cwd: rootDir,
    ignoreError: true,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
}

function buildDebugCommandDeps(rootDir: string): RunDebugCommandDeps {
  const getDefaultSandbox = (): string | undefined => {
    const { defaultSandbox, sandboxes } = registry.listSandboxes();
    if (!defaultSandbox) return undefined;
    if (!sandboxes.find((sandbox) => sandbox.name === defaultSandbox)) {
      console.error(
        `${RD}Warning:${R} default sandbox '${defaultSandbox}' is no longer in the registry.`,
      );
      console.error(
        `  Use ${B}--sandbox NAME${R} to target a specific sandbox, or run ${B}${CLI_NAME} onboard${R} again.\n`,
      );
      return undefined;
    }
    const liveList = captureOpenshell(rootDir, ["sandbox", "list"]);
    if (liveList.status === 0 && !parseLiveSandboxNames(liveList.output).has(defaultSandbox)) {
      console.error(
        `${RD}Warning:${R} default sandbox '${defaultSandbox}' exists in the local registry but not in OpenShell.`,
      );
      console.error(
        `  Use ${B}--sandbox NAME${R} to target a specific sandbox, or run ${B}${CLI_NAME} onboard${R} again.\n`,
      );
      return undefined;
    }
    return defaultSandbox;
  };

  return {
    getDefaultSandbox,
    runDebug,
    log: console.log,
    error: console.error,
    exit: (code: number) => process.exit(code),
  };
}

export default class DebugCliCommand extends Command {
  static id = "debug";
  static strict = false;
  static summary = "Collect diagnostics for bug reports";
  static description = "Collect NemoClaw diagnostic information.";
  static usage = ["debug [--quick] [--output FILE] [--sandbox NAME]"];

  public async run(): Promise<void> {
    this.parsed = true;
    runDebugCommand(this.argv, buildDebugCommandDeps(this.config.root));
  }
}
