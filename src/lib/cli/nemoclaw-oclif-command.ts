// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command, Flags, type Interfaces } from "@oclif/core";
import { redactForLog } from "../security/redact";
import { log } from "./logger";

export type CommandExitResult = {
  exitCode?: number | null;
  message?: string | null;
  status?: number | null;
};

/**
 * Shared oclif base for NemoClaw commands.
 *
 * Keep CLI-wide parser conventions here so individual command classes only
 * describe their own grammar.
 */
export abstract class NemoClawCommand extends Command {
  static baseFlags = {
    help: Flags.help({ char: "h" }),
    // Hidden logging flags. Universal visible flags would have to be
    // documented in every command section of docs/reference/commands.mdx
    // (cli-parity gate), so the documented interface is
    // NEMOCLAW_LOG_LEVEL/NEMOCLAW_DEBUG; the flags remain as a convenience.
    debug: Flags.boolean({
      description: "Enable debug output (equivalent to NEMOCLAW_LOG_LEVEL=debug)",
      default: false,
      hidden: true,
      exclusive: ["quiet"],
    }),
    quiet: Flags.boolean({
      description: "Suppress informational output; show only warnings and errors",
      default: false,
      hidden: true,
      exclusive: ["debug"],
    }),
  };

  protected override async init(): Promise<void> {
    await super.init();
    // Every invocation starts from the current environment. Raw-argv
    // passthrough commands intentionally stop here: only environment-based
    // logging configuration applies to them.
    log.configure({ debug: false, quiet: false });
  }

  protected override async parse<
    F extends Interfaces.OutputFlags<Interfaces.FlagInput>,
    B extends Interfaces.OutputFlags<Interfaces.FlagInput>,
    A extends Interfaces.OutputArgs<Interfaces.ArgInput>,
  >(
    options?: Interfaces.Input<F, B, A>,
    argv?: string[],
  ): Promise<Interfaces.ParserOutput<F, B, A>> {
    const parsed = await super.parse(options, argv);

    // Logging flags belong to the host only when a command invokes oclif's
    // parser. Commands that deliberately consume raw argv (for example
    // `sandbox agent` and `uninstall`) must forward similarly named flags
    // without changing host logging. Using parser output also honors `--`:
    // downstream flags after the boundary never acquire host meaning.
    log.configure({
      debug: parsed.flags.debug === true,
      quiet: parsed.flags.quiet === true,
    });

    return parsed;
  }

  protected logJson(json: unknown): void {
    console.log(JSON.stringify(redactForLog(json), null, 2));
  }

  protected setExitCode(code: number): void {
    process.exitCode = code;
  }

  protected failWithLines(lines: readonly string[], code = 1): void {
    for (const line of lines) console.error(line);
    this.setExitCode(code);
  }

  protected applyExitResult(result: CommandExitResult): void {
    const code =
      typeof result.exitCode === "number"
        ? result.exitCode
        : typeof result.status === "number"
          ? result.status
          : 0;
    if (code !== 0 && result.message) this.failWithLines([result.message], code);
    else this.setExitCode(code);
  }
}
