// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DebugOptions } from "./debug";

export interface RunDebugCommandDeps {
  getDefaultSandbox: () => string | undefined;
  runDebug: (options: DebugOptions) => void;
  log?: (message?: string) => void;
  error?: (message?: string) => void;
  exit?: (code: number) => never;
}

export function printDebugHelp(log: (message?: string) => void = console.log): void {
  log("Collect NemoClaw diagnostic information\n");
  log("Usage: nemoclaw debug [--quick] [--output FILE] [--sandbox NAME]\n");
  log("Options:");
  log("  --quick, -q        Only collect minimal diagnostics");
  log("  --output, -o FILE  Write a tarball to FILE");
  log("  --sandbox NAME     Target sandbox name");
}

export function parseDebugArgs(
  args: string[],
  deps: Pick<RunDebugCommandDeps, "getDefaultSandbox" | "log" | "error" | "exit">,
): DebugOptions {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const opts: DebugOptions = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--help":
      case "-h":
        printDebugHelp(log);
        exit(0);
      case "--quick":
      case "-q":
        opts.quick = true;
        break;
      case "--output":
      case "-o":
        if (!args[i + 1] || args[i + 1].startsWith("-")) {
          error("Error: --output requires a file path argument");
          exit(1);
        }
        opts.output = args[++i];
        break;
      case "--sandbox":
        if (!args[i + 1] || args[i + 1].startsWith("-")) {
          error("Error: --sandbox requires a name argument");
          exit(1);
        }
        opts.sandboxName = args[++i];
        break;
      default:
        error(`Unknown option: ${args[i]}`);
        exit(1);
    }
  }

  if (!opts.sandboxName) {
    opts.sandboxName = deps.getDefaultSandbox();
  }

  return opts;
}

export function runDebugCommandWithOptions(options: DebugOptions, deps: RunDebugCommandDeps): void {
  const opts = { ...options };
  if (!opts.sandboxName) {
    opts.sandboxName = deps.getDefaultSandbox();
  }
  deps.runDebug(opts);
}

export function runDebugCommand(args: string[], deps: RunDebugCommandDeps): void {
  const opts = parseDebugArgs(args, deps);
  deps.runDebug(opts);
}
