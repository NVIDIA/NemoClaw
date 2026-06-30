// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  flush as flushOclif,
  handle as handleOclif,
  Config as OclifConfig,
  run as runOclif,
} from "@oclif/core";

import { CLI_NAME } from "./branding";

export interface OclifCommandRunOptions {
  rootDir: string;
  error?: (message?: string) => void;
  exit?: (code: number) => never;
}

function getOclifExitCode(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const oclif = (error as { oclif?: { exit?: number } }).oclif;
  return typeof oclif?.exit === "number" ? oclif.exit : null;
}

function isOclifParseError(error: unknown): boolean {
  const name =
    error && typeof error === "object"
      ? (error as { constructor?: { name?: string } }).constructor?.name
      : "";
  const message = error instanceof Error ? error.message : "";
  return (
    name === "NonExistentFlagsError" ||
    name === "RequiredArgsError" ||
    name === "UnexpectedArgsError" ||
    name === "FailedFlagValidationError" ||
    name === "CLIError" ||
    message.startsWith("Parsing --")
  );
}

function isOclifExitError(error: unknown): boolean {
  const name =
    error && typeof error === "object"
      ? (error as { constructor?: { name?: string } }).constructor?.name
      : "";
  return name === "ExitError";
}

function formatOclifError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.trim();
  }

  return String(error).trim();
}

function applyBrandedBin(config: OclifConfig): void {
  const pjson = {
    ...config.pjson,
    oclif: {
      ...config.pjson.oclif,
      bin: CLI_NAME,
    },
  };
  // config.runCommand() calls Command.run(), which reloads from the root
  // plugin. Patch both config and root plugin metadata so alias launchers keep
  // branded oclif help output.
  config.bin = CLI_NAME;
  config.pjson = pjson;
  config.options.pjson = pjson;
  for (const plugin of config.plugins.values()) {
    if (plugin.root === config.root) {
      plugin.pjson = pjson;
      plugin.options.pjson = pjson;
    }
  }
}

// Direct command-id execution for routes that cannot safely go through oclif's
// flexible-taxonomy argv resolver. Prefer runOclifArgv() for normal execution
// so oclif owns command lookup, parsing, help, and error handling.
export async function runOclifCommandById(
  commandId: string,
  args: string[],
  opts: OclifCommandRunOptions,
): Promise<void> {
  const config = await OclifConfig.load(opts.rootDir);
  applyBrandedBin(config);
  const errorLine = opts.error ?? console.error;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const originalArgv = process.argv;
  const nativeArgv = [...commandId.split(":"), ...args];
  process.argv = [originalArgv[0] ?? process.execPath, originalArgv[1] ?? CLI_NAME, ...nativeArgv];

  try {
    await config.runCommand(commandId, args);
  } catch (error) {
    const exitCode = getOclifExitCode(error);
    if (exitCode === 0) {
      // Only oclif's own ExitError(0) is an intentional graceful exit (e.g.
      // Command.exit(0) / --help — its message is the synthetic "EEXIT: 0",
      // which must stay silent). Keep that path at exit 0.
      if (isOclifExitError(error)) {
        process.exitCode = 0;
        return;
      }
      // #5974: any OTHER error that merely happens to carry oclif.exit === 0
      // is a genuine failure that bubbled out of a command's run(). #2666
      // stopped it being silently swallowed (exit 0 + empty output); here we
      // also refuse to report success for it — surface its message AND exit
      // non-zero so `$?` stays scriptable. Fall back to a generic line if
      // formatOclifError() returns empty so a blank message never reintroduces
      // the silent path.
      const message = formatOclifError(error) || "Command exited with no output.";
      errorLine(`  ${message}`);
      process.exitCode = 1;
      return;
    }

    if (isOclifParseError(error)) {
      errorLine(`  ${formatOclifError(error)}`);
      exit(exitCode ?? 1);
    }

    // NCQ #3180: oclif's Command.exit(code) throws an ExitError carrying
    // `oclif.exit`. Treat that as a graceful exit with the requested code
    // so we don't leak a raw `at Object.exit (... /@oclif/core/...)` stack
    // trace to the user. Other oclif error classes (e.g. RequiredArgsError)
    // are left to bubble up so oclif's own handler still prints them.
    if (isOclifExitError(error) && typeof exitCode === "number") {
      exit(exitCode);
    }

    throw error;
  } finally {
    process.argv = originalArgv;
  }
}

export async function runOclifArgv(args: string[], opts: OclifCommandRunOptions): Promise<void> {
  const config = await OclifConfig.load(opts.rootDir);
  applyBrandedBin(config);
  const errorLine = opts.error ?? console.error;
  const originalArgv = process.argv;
  // oclif's parse-error help renderer consults process.argv, not just the
  // explicit run() args, so keep both views on the native route.
  process.argv = [originalArgv[0] ?? process.execPath, originalArgv[1] ?? CLI_NAME, ...args];
  try {
    // Mirror @oclif/core's execute() (run → flush → handle) by hand so the
    // native argv path keeps oclif's command lookup, parsing, help rendering,
    // and pretty-printed errors while letting us intercept one case below.
    await runOclif(args, { root: opts.rootDir, pjson: config.pjson });
    await flushOclif();
  } catch (error) {
    await flushOclif();
    // #5974: same hardening as runOclifCommandById. oclif's own handle() would
    // run Exit.exit(err.oclif?.exit ?? 1) here, so a non-ExitError that merely
    // carries oclif.exit === 0 (propagated out of a command's run()) would
    // silently exit 0 — reporting success for a real failure on the native
    // `internal`/`sandbox` routes. Surface the message and force a non-zero
    // exit instead; only a genuine ExitError(0) stays a graceful exit.
    //
    // Mechanism asymmetry (why process.exitCode here, exit()/throw in
    // runOclifCommandById): this native path mirrors oclif's execute() (run →
    // flush → handle), so for the intercepted case we set process.exitCode and
    // return rather than delegating to handleOclif() (the non-intercepted
    // branch below). handleOclif() IS oclif's handle(), which would re-run
    // Exit.exit(0) for this error and undo the fix, so process.exitCode +
    // return is the only way to force a non-zero code without re-entering
    // handle(). runOclifCommandById does not route through handle() at all — it
    // maps errors to codes by hand (its injected exit() for parse/ExitError, a
    // re-throw otherwise) — but applies the identical oclif.exit === 0 guard.
    // Removal condition: drop this guard once @oclif/core's handle() no longer
    // exits 0 for a non-ExitError that carries oclif.exit === 0.
    const exitCode = getOclifExitCode(error);
    if (exitCode === 0 && !isOclifExitError(error)) {
      const message = formatOclifError(error) || "Command exited with no output.";
      errorLine(`  ${message}`);
      process.exitCode = 1;
      return;
    }
    // Everything else (parse errors, ExitError, ordinary failures) keeps
    // oclif's standard handling: pretty-print, optional help, and process exit.
    await handleOclif(error as Parameters<typeof handleOclif>[0]);
  } finally {
    process.argv = originalArgv;
  }
}
