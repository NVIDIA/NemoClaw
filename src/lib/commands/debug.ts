// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command, Flags } from "@oclif/core";

import { CLI_NAME } from "../branding";
import { runDebug } from "../debug";
import type { DebugOptions } from "../debug";
import type { RunDebugCommandDeps } from "../debug-command";
import { runDebugCommandWithOptions } from "../debug-command";
import type { CaptureOpenshellResult } from "../adapters/openshell/client";
import { captureOpenshellCommand } from "../adapters/openshell/client";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../adapters/openshell/timeouts";
import * as registry from "../registry";
import { resolveOpenshell } from "../adapters/openshell/resolve";
import { parseLiveSandboxNames } from "../runtime-recovery";

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
  static strict = true;
  static summary = "Collect diagnostics for bug reports";
  static description = "Collect NemoClaw diagnostic information.";
  static usage = ["debug [--quick|-q] [--output FILE|-o FILE] [--sandbox NAME]"];
  static examples = [
    "<%= config.bin %> debug --quick",
    "<%= config.bin %> debug --sandbox alpha",
    "<%= config.bin %> debug --output /tmp/nemoclaw-debug.tar.gz",
  ];
  static flags = {
    help: Flags.help({ char: "h" }),
    quick: Flags.boolean({ char: "q", description: "Only collect minimal diagnostics" }),
    output: Flags.string({ char: "o", description: "Write a tarball to FILE" }),
    sandbox: Flags.string({ description: "Target sandbox name" }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(DebugCliCommand);
    const options: DebugOptions = {};
    if (flags.quick) options.quick = true;
    if (flags.output) options.output = flags.output;
    if (flags.sandbox) options.sandboxName = flags.sandbox;
    runDebugCommandWithOptions(options, buildDebugCommandDeps(this.config.root));
  }
}
