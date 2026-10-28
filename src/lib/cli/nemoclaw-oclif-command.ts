// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command, Flags, type Interfaces } from "@oclif/core";
import os from "node:os";
import path from "node:path";
import {
  assertHermesPortableCommandSupported,
  assertHermesPortableCommandUnavailable,
  classifyHermesPortableCommand,
  HERMES_PORTABLE_UNSUPPORTED_COMMAND_MESSAGE,
  HERMES_PORTABLE_UNSUPPORTED_DOCTOR_FIX_MESSAGE,
} from "../onboard/experimental/portable-agent-lifecycle";
import { HERMES_PORTABLE_RECEIPT_DIRECTORY } from "../onboard/experimental/hermes-portable-receipt";
import {
  defaultPortableDemoStateDir,
  portableDemoReceiptDirectory,
} from "../onboard/experimental/portable-runtime-receipt-readiness";
import { redactForLog } from "../security/redact";
import {
  assertNoHermesPortableHostAuthority,
  PORTABLE_HOST_FENCE_BUSY_MESSAGE,
  readPortableAuthorityDirectory,
  samePortableAuthorityDirectory,
  type PortableAuthorityDirectorySnapshot,
  withCurrentPortableHostFence,
  withCurrentPortableHostFenceTry,
} from "../state/portable-uninstall-retirement";
import { withSandboxLifecycleLock } from "../actions/sandbox/lifecycle/lock";
import { withUnlockedSandboxStatusRead } from "../actions/sandbox/status-snapshot";
import { listInferenceRouteOwnersAcrossGatewayRoots } from "../state/registry/cross-port";
import {
  enforceRemovedImmutabilityMigrationBoundary,
  reportRemovedImmutabilityUpgrade,
} from "../state/migrations/removed-immutability";
import { log } from "./logger";
import { withTelemetryOperation } from "../actions/telemetry/operation";
import { isTelemetryConfigurationKey, type TelemetryOperation } from "../domain/telemetry/event";

function telemetryOperation(
  commandId: string | undefined,
  argv: readonly string[],
): TelemetryOperation | null {
  if (argv.includes("--help") || argv.includes("-h")) return null;
  const operations: Record<string, TelemetryOperation> = {
    onboard: "sandbox_create",
    update: "update",
    "upgrade-sandboxes": "upgrade_sandboxes",
    "sandbox:rebuild": "sandbox_rebuild",
    "sandbox:destroy": "sandbox_destroy",
    "sandbox:recover": "sandbox_recover",
    "inference:set": "inference_set",
    "sandbox:inference:set": "inference_set",
    "sandbox:agents:add": "agent_add",
    "sandbox:agents:delete": "agent_delete",
    "sandbox:agents:apply": "agents_apply",
    "sandbox:channels:add": "messaging_add",
    "sandbox:channels:remove": "messaging_remove",
    "sandbox:channels:stop": "messaging_pause",
    "sandbox:channels:start": "messaging_resume",
    "sandbox:policy:add": "policy_change",
    "sandbox:policy:remove": "policy_change",
    "sandbox:policy:exclude": "policy_change",
    "sandbox:policy:restore": "policy_change",
  };
  if (commandId === "sandbox:config:set") {
    const keyIndex = argv.indexOf("--key");
    const key =
      argv.find((argument) => argument.startsWith("--key="))?.slice(6) ??
      (keyIndex >= 0 ? argv[keyIndex + 1] : undefined);
    return isTelemetryConfigurationKey(key) ? "settings_change" : null;
  }
  return commandId ? (operations[commandId] ?? null) : null;
}

export type CommandExitResult = {
  exitCode?: number | null;
  message?: string | null;
  status?: number | null;
};

export { HERMES_PORTABLE_UNSUPPORTED_COMMAND_MESSAGE };
export { assertHermesPortableCommandUnavailable };
export const withSandboxCommandLifecycleLock = withSandboxLifecycleLock;
export { HERMES_PORTABLE_UNSUPPORTED_DOCTOR_FIX_MESSAGE };

const REMOVED_IMMUTABILITY_REMEDIATION_COMMANDS = new Set([
  "sandbox:destroy",
  "sandbox:logs",
  "sandbox:rebuild",
  "sandbox:status",
  "sandbox:stop",
]);

function hasPortableRegistryAuthorityOnHost(): boolean {
  return listInferenceRouteOwnersAcrossGatewayRoots(process.env.HOME || os.homedir()).some(
    (entry) => entry.portableLifecycleProfile !== undefined,
  );
}

type PortableAuthorityDirectories = {
  readonly hermes: PortableAuthorityDirectorySnapshot;
  readonly openclaw: PortableAuthorityDirectorySnapshot;
};

function readPortableAuthorityDirectories(stateDir: string): PortableAuthorityDirectories {
  return {
    hermes: readPortableAuthorityDirectory(
      path.join(stateDir, HERMES_PORTABLE_RECEIPT_DIRECTORY),
      false,
    ),
    openclaw: readPortableAuthorityDirectory(portableDemoReceiptDirectory(stateDir), false),
  };
}

function hasPortableReceiptAuthority(directories: PortableAuthorityDirectories): boolean {
  return directories.hermes.entries.length > 0 || directories.openclaw.entries.length > 0;
}

function samePortableAuthorityDirectories(
  left: PortableAuthorityDirectories,
  right: PortableAuthorityDirectories,
): boolean {
  return (
    samePortableAuthorityDirectory(left.hermes, right.hermes) &&
    samePortableAuthorityDirectory(left.openclaw, right.openclaw)
  );
}

function canUseUnlockedSandboxStatusRead(): boolean {
  const stateDir = defaultPortableDemoStateDir(process.env);
  try {
    const before = readPortableAuthorityDirectories(stateDir);
    if (hasPortableReceiptAuthority(before) || hasPortableRegistryAuthorityOnHost()) return false;

    const after = readPortableAuthorityDirectories(stateDir);
    return (
      !hasPortableReceiptAuthority(after) &&
      samePortableAuthorityDirectories(before, after) &&
      !hasPortableRegistryAuthorityOnHost()
    );
  } catch {
    return false;
  }
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
    return withTelemetryOperation(telemetryOperation(this.id, this.argv), () =>
      this.runLifecycleBoundary<T>(),
    );
  }

  private async runLifecycleBoundary<T>(): Promise<T> {
    if (await this.runBeforeLifecycleBoundary()) return undefined as T;
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
    if (this.isInteractiveSession(commandId)) {
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
    if (commandId === "sandbox:status") {
      let fencedOperationStarted = false;
      try {
        return await withCurrentPortableHostFenceTry(() => {
          fencedOperationStarted = true;
          return withSandboxLifecycleLock(sandboxName, runLocked);
        });
      } catch (error) {
        if (
          fencedOperationStarted ||
          !(error instanceof Error) ||
          error.message !== PORTABLE_HOST_FENCE_BUSY_MESSAGE
        ) {
          throw error;
        }
        if (!canUseUnlockedSandboxStatusRead()) {
          throw new Error(
            "Another NemoClaw lifecycle operation is in progress on this host. Wait for it to finish, then retry status.",
            { cause: error },
          );
        }
        return await withUnlockedSandboxStatusRead(async () => {
          const result = await runLocked();
          if (!canUseUnlockedSandboxStatusRead()) {
            throw new Error(
              "Another NemoClaw lifecycle operation is in progress on this host. Wait for it to finish, then retry status.",
              { cause: error },
            );
          }
          return result;
        });
      }
    }
    return await withSandboxLifecycleLock(sandboxName, runLocked);
  }

  /** Allow a command to transfer complete ownership before host-wide fences are acquired. */
  protected async runBeforeLifecycleBoundary(): Promise<boolean> {
    return false;
  }

  /** Reuse an early command parse when the ordinary lifecycle wrapper continues. */
  protected retainLifecycleParserOutput<
    F extends Interfaces.OutputFlags<Interfaces.FlagInput>,
    B extends Interfaces.OutputFlags<Interfaces.FlagInput>,
    A extends Interfaces.OutputArgs<Interfaces.ArgInput>,
  >(parsed: Interfaces.ParserOutput<F, B, A>): void {
    this.lifecycleParserOutput = parsed as Interfaces.ParserOutput<
      Interfaces.OutputFlags<Interfaces.FlagInput>,
      Interfaces.OutputFlags<Interfaces.FlagInput>,
      Interfaces.OutputArgs<Interfaces.ArgInput>
    >;
  }

  private isInteractiveSession(commandId: string | undefined): boolean {
    return (
      commandId === "launch" ||
      (commandId === "sandbox:connect" && this.lifecycleParserOutput?.flags["probe-only"] !== true)
    );
  }

  private async resolveLifecycleSandboxName(
    portablePolicy: ReturnType<typeof classifyHermesPortableCommand> | null,
  ): Promise<string | null> {
    const commandId = this.id;
    if (
      typeof commandId !== "string" ||
      (commandId !== "launch" && !commandId.startsWith("sandbox:")) ||
      !portablePolicy
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

  protected override toErrorJson(error: unknown): unknown {
    // Error.message is not enumerable, so retain it before JSON redaction.
    return super.toErrorJson(error instanceof Error ? { ...error, message: error.message } : error);
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
