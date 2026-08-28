// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";
import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";

import { CLI_NAME } from "../lib/cli/branding";
import { runDebug } from "../lib/diagnostics/debug";
import type { DebugOptions } from "../lib/diagnostics/debug";
import type { RunDebugCommandDeps } from "../lib/diagnostics/debug-command";
import { runDebugCommandWithOptions } from "../lib/diagnostics/debug-command";
import { captureOpenshellCommand } from "../lib/adapters/openshell/client";
import { resolveOpenshell } from "../lib/adapters/openshell/resolve";
import { createCliOpenShellSandboxObserver } from "../lib/adapters/openshell/sandbox-observer-cli";
import { selectedOpenShellGateway } from "../lib/adapters/openshell/sandbox-observer";
import * as registry from "../lib/state/registry";

const useColor = !process.env.NO_COLOR && !!process.stderr.isTTY;
const B = useColor ? "\x1b[1m" : "";
const R = useColor ? "\x1b[0m" : "";
const RD = useColor ? "\x1b[1;31m" : "";

function buildDebugCommandDeps(rootDir: string): RunDebugCommandDeps {
  const sandboxObserver = createCliOpenShellSandboxObserver({
    capture: (args, options) => {
      const openshell = resolveOpenshell();
      if (!openshell) return { status: 1, output: "" };
      return captureOpenshellCommand(openshell, args, { cwd: rootDir, ...options });
    },
  });

  const liveSandboxNames = async (): Promise<ReadonlySet<string> | undefined> => {
    const result = await sandboxObserver.listSandboxes({ target: selectedOpenShellGateway() });
    if (!result.ok) return undefined;
    return new Set(result.value.sandboxes.map((sandbox) => sandbox.name));
  };

  const getDefaultSandbox = async (): Promise<string | undefined> => {
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
    const liveNames = await liveSandboxNames();
    if (liveNames && !liveNames.has(defaultSandbox)) {
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

  const isSandboxKnown = async (name: string): Promise<boolean> => {
    const { sandboxes } = registry.listSandboxes();
    if (!sandboxes.find((sandbox) => sandbox.name === name)) return false;
    const liveNames = await liveSandboxNames();
    return !liveNames || liveNames.has(name);
  };

  return {
    getDefaultSandbox,
    isSandboxKnown,
    runDebug,
  };
}

export default class DebugCliCommand extends NemoClawCommand {
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
    await runDebugCommandWithOptions(options, buildDebugCommandDeps(this.config.root));
  }
}
