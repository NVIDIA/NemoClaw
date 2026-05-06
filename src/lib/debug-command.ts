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

export type DebugParseResult =
  | { ok: true; options: DebugOptions }
  | { ok: false; exitCode: number; kind: "help" | "error"; messages: string[] };

function debugHelpLines(): string[] {
  return [
    "Collect NemoClaw diagnostic information\n",
    "Usage: nemoclaw debug [--quick] [--output FILE] [--sandbox NAME]\n",
    "Options:",
    "  --quick, -q        Only collect minimal diagnostics",
    "  --output, -o FILE  Write a tarball to FILE",
    "  --sandbox NAME     Target sandbox name",
  ];
}

export function printDebugHelp(log: (message?: string) => void = console.log): void {
  for (const line of debugHelpLines()) {
    log(line);
  }
}

export function parseDebugArgsResult(
  args: string[],
  deps: Pick<RunDebugCommandDeps, "getDefaultSandbox">,
): DebugParseResult {
  const opts: DebugOptions = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--help":
      case "-h":
        return { ok: false, exitCode: 0, kind: "help", messages: debugHelpLines() };
      case "--quick":
      case "-q":
        opts.quick = true;
        break;
      case "--output":
      case "-o":
        if (!args[i + 1] || args[i + 1].startsWith("-")) {
          return {
            ok: false,
            exitCode: 1,
            kind: "error",
            messages: ["Error: --output requires a file path argument"],
          };
        }
        opts.output = args[++i];
        break;
      case "--sandbox":
        if (!args[i + 1] || args[i + 1].startsWith("-")) {
          return {
            ok: false,
            exitCode: 1,
            kind: "error",
            messages: ["Error: --sandbox requires a name argument"],
          };
        }
        opts.sandboxName = args[++i];
        break;
      default:
        return {
          ok: false,
          exitCode: 1,
          kind: "error",
          messages: [`Unknown option: ${args[i]}`],
        };
    }
  }

  if (!opts.sandboxName) {
    opts.sandboxName = deps.getDefaultSandbox();
  }

  return { ok: true, options: opts };
}

export function parseDebugArgs(
  args: string[],
  deps: Pick<RunDebugCommandDeps, "getDefaultSandbox" | "log" | "error" | "exit">,
): DebugOptions {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const parsed = parseDebugArgsResult(args, deps);
  if (!parsed.ok) {
    const writer = parsed.kind === "help" ? log : error;
    for (const message of parsed.messages) {
      writer(message);
    }
    return exit(parsed.exitCode);
  }
  return parsed.options;
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
