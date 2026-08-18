// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command, Flags, type Interfaces } from "@oclif/core";
import { inspectPortableAgentReceiptAuthority } from "../onboard/experimental/hermes-portable-receipt";
import {
  assertHermesPortableCommandUnavailable,
  HERMES_PORTABLE_UNSUPPORTED_COMMAND_MESSAGE,
} from "../onboard/experimental/portable-agent-lifecycle";
import { defaultPortableDemoStateDir } from "../onboard/experimental/portable-runtime-receipt-readiness";
import { redactForLog } from "../security/redact";
import { isDeferredShieldsExit } from "../shields/deferred-exit";
import { withMcpLifecycleLock } from "../state/mcp-lifecycle-lock-acquisition";
import { log } from "./logger";

export type CommandExitResult = {
  exitCode?: number | null;
  message?: string | null;
  status?: number | null;
};

const HERMES_PORTABLE_COMMANDS = new Set([
  "launch",
  "sandbox:connect",
  "sandbox:doctor",
  "sandbox:recover",
  "sandbox:start",
  "sandbox:status",
  "sandbox:stop",
]);

const RAW_SANDBOX_NAME_COMMANDS = new Set([
  "sandbox:agent",
  "sandbox:agents",
  "sandbox:agents:add",
  "sandbox:agents:apply",
  "sandbox:agents:delete",
  "sandbox:agents:list",
  "sandbox:mcp",
  "sandbox:sessions",
  "sandbox:sessions:list",
  "sandbox:skill",
]);

const MULTI_SANDBOX_LIFECYCLE_COMMANDS = new Set(["sandbox:snapshot:restore"]);

export { HERMES_PORTABLE_UNSUPPORTED_COMMAND_MESSAGE };
export { assertHermesPortableCommandUnavailable };
export const withSandboxCommandLifecycleLock = withMcpLifecycleLock;
export const HERMES_PORTABLE_UNSUPPORTED_DOCTOR_FIX_MESSAGE =
  "The --fix option is not supported for an experimental Hermes portable sandbox.";

function assertHermesPortableCommandSupported(
  commandId: string,
  sandboxName: string,
  argv: readonly string[],
): void {
  const authority = inspectPortableAgentReceiptAuthority(
    sandboxName,
    defaultPortableDemoStateDir(process.env),
  );
  const supported =
    HERMES_PORTABLE_COMMANDS.has(commandId) &&
    !(commandId === "sandbox:doctor" && argv.includes("--fix"));
  if (authority.kind !== "hermes" || supported) return;
  if (commandId === "sandbox:doctor" && argv.includes("--fix")) {
    throw new Error(`${HERMES_PORTABLE_UNSUPPORTED_DOCTOR_FIX_MESSAGE} Command: ${commandId}`);
  }
  throw new Error(`${HERMES_PORTABLE_UNSUPPORTED_COMMAND_MESSAGE} Command: ${commandId}`);
}

/**
 * Shared oclif base for NemoClaw commands.
 *
 * Keep CLI-wide parser conventions here so individual command classes only
 * describe their own grammar.
 */
export abstract class NemoClawCommand extends Command {
  private lifecycleParserOutput: Interfaces.ParserOutput<
    Interfaces.OutputFlags<Interfaces.FlagInput>,
    Interfaces.OutputFlags<Interfaces.FlagInput>,
    Interfaces.OutputArgs<Interfaces.ArgInput>
  > | null = null;

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
    const commandId = this.id;
    const sandboxName = this.argv[0];
    if (
      typeof commandId === "string" &&
      sandboxName &&
      (commandId === "launch" || commandId.startsWith("sandbox:")) &&
      !this.argv.includes("--help") &&
      !this.argv.includes("-h")
    ) {
      assertHermesPortableCommandSupported(commandId, sandboxName, this.argv);
    }
  }

  protected override async _run<T>(): Promise<T> {
    const sandboxName = await this.resolveLifecycleSandboxName();
    if (!sandboxName) return await super._run<T>();
    return await withMcpLifecycleLock(sandboxName, () => super._run<T>());
  }

  private async resolveLifecycleSandboxName(): Promise<string | null> {
    const commandId = this.id;
    if (
      typeof commandId !== "string" ||
      (commandId !== "launch" && !commandId.startsWith("sandbox:")) ||
      MULTI_SANDBOX_LIFECYCLE_COMMANDS.has(commandId)
    ) {
      return null;
    }
    if (RAW_SANDBOX_NAME_COMMANDS.has(commandId)) {
      const sandboxName = this.argv[0];
      return sandboxName && sandboxName !== "--help" && sandboxName !== "-h"
        ? sandboxName
        : null;
    }
    try {
      const parsed = await super.parse();
      this.lifecycleParserOutput = parsed;
      const parsedSandboxName = (parsed.args as Record<string, unknown>).sandboxName;
      const sandboxName =
        typeof parsedSandboxName === "string" ? parsedSandboxName : parsed.argv[0];
      return typeof sandboxName === "string" && sandboxName.trim() !== "" ? sandboxName : null;
    } catch {
      return null;
    }
  }

  protected override async parse<
    F extends Interfaces.OutputFlags<Interfaces.FlagInput>,
    B extends Interfaces.OutputFlags<Interfaces.FlagInput>,
    A extends Interfaces.OutputArgs<Interfaces.ArgInput>,
  >(
    options?: Interfaces.Input<F, B, A>,
    argv?: string[],
  ): Promise<Interfaces.ParserOutput<F, B, A>> {
    const parsed = this.lifecycleParserOutput
      ? (this.lifecycleParserOutput as Interfaces.ParserOutput<F, B, A>)
      : await super.parse(options, argv);
    this.lifecycleParserOutput = null;

    const commandId = this.id;
    const parsedSandboxName = (parsed.args as Record<string, unknown>).sandboxName;
    if (
      typeof commandId === "string" &&
      typeof parsedSandboxName === "string" &&
      (commandId === "launch" || commandId.startsWith("sandbox:"))
    ) {
      assertHermesPortableCommandSupported(commandId, parsedSandboxName, this.argv);
    }

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

  protected override async catch(error: unknown): Promise<unknown> {
    // Shields transitions defer process.exit through a sentinel so an exit
    // cannot strand the transition lock (see failShieldsCommand). By the time
    // oclif routes the rejection here every lock has been released, and the
    // failure lines were already printed at the throw site, so only the exit
    // code remains to record. Everything else keeps oclif's default handling.
    if (isDeferredShieldsExit(error)) {
      this.setExitCode(error.exitCode);
      return;
    }
    return super.catch(error as Error & { exitCode?: number });
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
