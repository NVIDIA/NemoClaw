// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command, Flags } from "@oclif/core";

import { log } from "./logger";
import { redactForLog } from "../security/redact";

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
    debug: Flags.boolean({
      description: "Enable debug output (equivalent to NEMOCLAW_LOG_LEVEL=debug)",
      env: "NEMOCLAW_DEBUG",
      default: false,
      hidden: false,
    }),
    quiet: Flags.boolean({
      char: "q",
      description: "Suppress informational output; show only warnings and errors",
      default: false,
    }),
  };

  async init(): Promise<void> {
    await super.init();
    const { flags } = await this.parse(this.constructor as typeof NemoClawCommand);
    if ((flags as { debug?: boolean }).debug) log.setDebug(true);
    if ((flags as { quiet?: boolean }).quiet) log.setQuiet(true);
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
