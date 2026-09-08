// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command, Flags, type Interfaces } from "@oclif/core";
import {
  assertHermesPortableCommandSupported,
  assertHermesPortableCommandUnavailable,
  classifyHermesPortableCommand,
  HERMES_PORTABLE_UNSUPPORTED_COMMAND_MESSAGE,
  HERMES_PORTABLE_UNSUPPORTED_DOCTOR_FIX_MESSAGE,
} from "../onboard/experimental/portable-agent-lifecycle";
import { hasHermesPortableReceiptCandidate } from "../onboard/experimental/hermes-portable-receipt";
import { defaultPortableDemoStateDir } from "../onboard/experimental/portable-runtime-receipt-readiness";
import { redactForLog } from "../security/redact";
import {
  assertNoHermesPortableHostAuthority,
  withCurrentPortableHostFence,
} from "../state/portable-uninstall-retirement";
import { withMcpLifecycleLock } from "../state/mcp-lifecycle-lock";
import {
  enforceRemovedImmutabilityMigrationBoundary,
  reportRemovedImmutabilityUpgrade,
} from "../state/migrations/removed-immutability";
import { log } from "./logger";

export type CommandExitResult = {
  exitCode?: number | null;
  message?: string | null;
  status?: number | null;
};

export { HERMES_PORTABLE_UNSUPPORTED_COMMAND_MESSAGE };
export { assertHermesPortableCommandUnavailable };
export const withSandboxCommandLifecycleLock = withMcpLifecycleLock;
export { HERMES_PORTABLE_UNSUPPORTED_DOCTOR_FIX_MESSAGE };

const REMOVED_IMMUTABILITY_REMEDIATION_COMMANDS = new Set([
  "sandbox:destroy",
  "sandbox:logs",
  "sandbox:rebuild",
  "sandbox:snapshot",
  "sandbox:snapshot:create",
  "sandbox:snapshot:list",
  "sandbox:status",
  "sandbox:stop",
]);

/** Compact, serializable description of a command failure reported under `--json`. */
export type CommandErrorJson = {
  message: string;
  code?: string;
  exit?: number;
  suggestions?: string[];
};

function errorSuggestions(err: unknown): string[] | undefined {
  const raw =
    err !== null && typeof err === "object"
      ? (err as { suggestions?: unknown }).suggestions
      : undefined;
  if (!Array.isArray(raw)) return undefined;
  const suggestions = raw.filter((entry): entry is string => typeof entry === "string");
  return suggestions.length > 0 ? suggestions : undefined;
}

type ParsedFlagInput = {
  input?: { flags?: Record<string, { exclusive?: unknown } | undefined> };
  output?: { raw?: unknown };
};

/**
 * Name the flags a caller passed together that the command declares exclusive.
 *
 * The parser already rejects the pair; this reads its record of the rejection
 * rather than its prose. `output.raw` holds exactly the flags the caller typed,
 * so a flag that is merely defaulted (`--debug`/`--quiet` default to false)
 * never counts, and `input.flags[name].exclusive` is the declaration itself.
 * Returns null for any failure that is not an exclusive-flag violation.
 */
export function mutuallyExclusiveFlagStatement(err: unknown): string | null {
  const parse = (err as { parse?: ParsedFlagInput } | null)?.parse;
  const declared = parse?.input?.flags;
  const raw = parse?.output?.raw;
  if (!declared || !Array.isArray(raw)) return null;
  const provided = new Set<string>();
  for (const entry of raw) {
    const token = (entry as { type?: unknown; flag?: unknown } | null) ?? {};
    if (token.type === "flag" && typeof token.flag === "string") provided.add(token.flag);
  }
  const pairs = new Set<string>();
  for (const name of provided) {
    const exclusive = declared[name]?.exclusive;
    if (!Array.isArray(exclusive)) continue;
    for (const other of exclusive) {
      if (typeof other !== "string" || !provided.has(other)) continue;
      pairs.add([name, other].sort().join("|"));
    }
  }
  if (pairs.size === 0) return null;
  const sentences = [...pairs].map((pair) => {
    const [first, second] = pair.split("|");
    return `--${first} and --${second} are mutually exclusive. Use one or the other.`;
  });
  return sentences.join("\n");
}

/**
 * Describe a command failure as data a `--json` caller can act on.
 *
 * The message is the whole point and it is the one field the default envelope
 * loses: `Error.prototype.message` is not enumerable, so serializing the error
 * drops it. Everything else is narrowed on purpose — see `toErrorJson`.
 *
 * An exclusive-flag violation leads with a plain statement of which flags
 * collided. The parser's own text follows, so its `--help` pointer survives.
 */
export function describeCommandErrorForJson(err: unknown): CommandErrorJson {
  const original =
    err instanceof Error && err.message
      ? err.message
      : typeof err === "string" && err
        ? err
        : "The command failed without reporting a reason.";
  // Only the parser's text can carry user argv, so only it is redacted. The
  // statement is built from declared flag names, and running prose through
  // the redactor is how "Pass one" became "Pass <REDACTED>".
  const redactedOriginal = String(redactForLog(original));
  const statement = mutuallyExclusiveFlagStatement(err);
  const message = statement ? `${statement}\n${redactedOriginal}` : redactedOriginal;
  // A thrown `undefined` still has to produce an envelope: the error path is
  // the last thing standing between a caller and an unexplained exit code.
  const detail: { code?: unknown; oclif?: { exit?: unknown } } =
    err !== null && typeof err === "object" ? err : {};
  const code = detail.code;
  const exit = detail.oclif?.exit;
  const suggestions = errorSuggestions(err);
  return {
    message,
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof exit === "number" ? { exit } : {}),
    ...(suggestions
      ? { suggestions: suggestions.map((entry) => String(redactForLog(entry))) }
      : {}),
  };
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

  /**
   * Report a failed `--json` invocation as a small envelope instead of the raw error.
   *
   * oclif's default is `toErrorJson(err) { return { error: err } }`, and
   * `logJson` serializes that straight to stdout. Two things go wrong at once.
   * `Error.prototype.message` is not enumerable, so the one field a caller
   * needs is dropped. And a flag-validation failure carries `parse.input.
   * context` — the command instance — which reaches `this.config` and pulls
   * the plugin manifest and `package.json` in with it.
   *
   * `nemoclaw doctor --text --json` therefore wrote ~500 KB of structure to
   * stdout, with no statement of what was rejected, and nothing on stderr. Any
   * caller piping the command into a JSON parser got that payload instead of a
   * report. The same held for every `--json` command with a mutually exclusive
   * pair, including the hidden `--debug`/`--quiet` pair on this base (#11150).
   */
  protected override toErrorJson(err: unknown): unknown {
    return { error: describeCommandErrorForJson(err) };
  }

  /**
   * Keep the diagnostic on stderr while stdout stays parseable JSON.
   *
   * oclif's `catch` swallows the rethrow under `--json`, so nothing reached
   * stderr at all and the exit code was the only signal the caller got.
   */
  protected override async catch(err: Interfaces.CommandError): Promise<unknown> {
    const described = describeCommandErrorForJson(err);
    if (this.jsonEnabled()) {
      console.error(described.message);
    } else if (mutuallyExclusiveFlagStatement(err)) {
      // The human path rethrows and lets oclif print `err.message`, so the
      // same statement has to travel on the error itself.
      err.message = described.message;
    }
    return await super.catch(err);
  }

  protected override async init(): Promise<void> {
    await super.init();
    try {
      reportRemovedImmutabilityUpgrade();
    } catch (error) {
      console.warn(
        `Shields has been retired from NemoClaw, but legacy upgrade state could not be inspected safely: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Every invocation starts from the current environment. Raw-argv
    // passthrough commands intentionally stop here: only environment-based
    // logging configuration applies to them.
    log.configure({ debug: false, quiet: false });
    const commandId = this.id;
    const sandboxName = this.argv[0];
    const portablePolicy =
      typeof commandId === "string" ? classifyHermesPortableCommand(commandId, this.argv) : null;
    if (
      typeof commandId === "string" &&
      sandboxName &&
      (commandId === "launch" || commandId.startsWith("sandbox:")) &&
      !portablePolicy?.helpRequested
    ) {
      assertHermesPortableCommandSupported(commandId, sandboxName, this.argv);
    }
  }

  protected override async _run<T>(): Promise<T> {
    const commandId = this.id;
    const portablePolicy =
      typeof commandId === "string" ? classifyHermesPortableCommand(commandId, this.argv) : null;
    if (portablePolicy?.hostFence === "read" && !portablePolicy.helpRequested) {
      return await withCurrentPortableHostFence(() => super._run<T>());
    }
    if (
      typeof commandId === "string" &&
      portablePolicy?.hostFence === "deny" &&
      !portablePolicy.helpRequested
    ) {
      return await withCurrentPortableHostFence(() => {
        assertNoHermesPortableHostAuthority(defaultPortableDemoStateDir(process.env), commandId);
        return super._run<T>();
      });
    }
    const sandboxName = await this.resolveLifecycleSandboxName(portablePolicy);
    if (!sandboxName) return await super._run<T>();
    const allowRemovedImmutabilityStateRecord =
      (typeof commandId === "string" && REMOVED_IMMUTABILITY_REMEDIATION_COMMANDS.has(commandId)) ||
      (commandId === "sandbox:doctor" && this.lifecycleParserOutput?.flags["fix"] !== true);
    enforceRemovedImmutabilityMigrationBoundary(sandboxName, {
      allowStateRecord: allowRemovedImmutabilityStateRecord,
    });
    if (this.isInteractiveConnect(commandId)) {
      return await super._run<T>();
    }
    const runLocked = () => {
      enforceRemovedImmutabilityMigrationBoundary(sandboxName, {
        allowStateRecord: allowRemovedImmutabilityStateRecord,
      });
      if (typeof commandId === "string" && portablePolicy?.rawSandboxName) {
        assertHermesPortableCommandSupported(commandId, sandboxName, this.argv);
      }
      return super._run<T>();
    };
    const runWithLifecycleFence = async () => {
      return await withMcpLifecycleLock(sandboxName, runLocked);
    };
    if (
      this.isProbeOnlyConnect(commandId) &&
      hasHermesPortableReceiptCandidate(sandboxName, defaultPortableDemoStateDir(process.env))
    ) {
      return await withCurrentPortableHostFence(runWithLifecycleFence);
    }
    return await runWithLifecycleFence();
  }

  private isProbeOnlyConnect(commandId: string | undefined): boolean {
    return (
      commandId === "sandbox:connect" && this.lifecycleParserOutput?.flags["probe-only"] === true
    );
  }

  private isInteractiveConnect(commandId: string | undefined): boolean {
    return (
      commandId === "sandbox:connect" && this.lifecycleParserOutput?.flags["probe-only"] !== true
    );
  }

  private async resolveLifecycleSandboxName(
    portablePolicy: ReturnType<typeof classifyHermesPortableCommand> | null,
  ): Promise<string | null> {
    const commandId = this.id;
    if (
      typeof commandId !== "string" ||
      (commandId !== "launch" && !commandId.startsWith("sandbox:")) ||
      !portablePolicy ||
      portablePolicy.multiSandboxLifecycle
    ) {
      return null;
    }
    if (portablePolicy.rawSandboxName) {
      const sandboxName = this.argv[0];
      return sandboxName && sandboxName !== "--help" && sandboxName !== "-h" ? sandboxName : null;
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
