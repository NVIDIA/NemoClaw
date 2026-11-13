// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";
import { execSandbox, execUsage } from "../../lib/actions/sandbox/exec";
import {
  assertHermesPortableCommandUnavailable,
  NemoClawCommand,
  withSandboxCommandLifecycleLock,
} from "../../lib/cli/nemoclaw-oclif-command";

type ParsedToken = Awaited<ReturnType<SandboxExecCommand["parse"]>>["raw"][number];

/** True when the command began before the first `--`, so that `--` is the command's own. */
function commandStartsBeforeSeparator(
  raw: readonly ParsedToken[],
  originalArgv: readonly string[],
  separatorIndex: number,
): boolean {
  if (separatorIndex === -1) return false;
  const commandTokenCount = raw.filter(
    (token) => token.type === "arg" && token.arg !== "sandboxName",
  ).length;
  return commandTokenCount > originalArgv.length - separatorIndex - 1;
}

export default class SandboxExecCommand extends NemoClawCommand {
  static id = "sandbox:exec";
  static strict = false;
  static summary = "Run a command non-interactively in a running sandbox";
  static description =
    "Run a single command inside a running sandbox via the OpenShell exec endpoint. The command runs as the sandbox user (HOME=/sandbox) and exits with the remote command's exit code. Use `--` to separate exec options from the user command; arguments after it preserve embedded line endings and quotes. NUL bytes are rejected, and `--workdir` must remain single-line. Stdin is inherited by default only when it is a terminal; pass `--stdin` to forward an intentional pipe. The command runs without a pseudo-terminal unless you pass `--tty`, so stdout and stderr stay separate streams and width-formatted output keeps its non-terminal layout.";
  static usage = [
    "<name> [--workdir <dir>] [--tty|--no-tty] [--timeout <s>] [--stdin|--no-stdin] -- <cmd> [args...]",
  ];
  static examples = [
    "<%= config.bin %> sandbox exec alpha -- openclaw agent --agent main -m hi",
    "<%= config.bin %> sandbox exec alpha --workdir /sandbox -- ls -la",
    "printf 'hello' | <%= config.bin %> sandbox exec alpha --stdin -- cat",
  ];
  static args = {
    sandboxName: Args.string({ name: "sandbox", description: "Sandbox name", required: true }),
  };
  static flags = {
    workdir: Flags.string({ description: "Working directory inside the sandbox" }),
    tty: Flags.boolean({
      allowNo: true,
      description: "Allocate a pseudo-terminal; off unless requested",
    }),
    timeout: Flags.integer({
      min: 0,
      description: "Timeout in seconds (0 = no timeout)",
    }),
    stdin: Flags.boolean({
      allowNo: true,
      description:
        "Pass caller stdin through to the sandbox command; defaults to terminal stdin only",
    }),
  };

  public async run(): Promise<void> {
    const originalArgv = [...this.argv];
    const { args, flags, argv, raw } = await this.parse(SandboxExecCommand);
    const separatorIndex = originalArgv.indexOf("--");
    if (commandStartsBeforeSeparator(raw, originalArgv, separatorIndex)) {
      // oclif drops that `--` from argv, so refuse rather than guess (#12584).
      this.error(`Put -- before a command that contains --. Usage: ${execUsage(args.sandboxName)}`);
    }
    // oclif's non-strict parser preserves ordinary inner flags, but sorts
    // repeated unknown flags by their first input position. That turns a
    // command such as `env -u A -u B` into `env -u -u A B`. Once the caller
    // used the documented `--` boundary, take the command from oclif's
    // original argv instead of its reconstructed parser output.
    const cmd = (
      separatorIndex === -1 ? argv.slice(1) : originalArgv.slice(separatorIndex + 1)
    ) as string[];
    await withSandboxCommandLifecycleLock(args.sandboxName, () => {
      assertHermesPortableCommandUnavailable(args.sandboxName, "sandbox:exec");
      return execSandbox(args.sandboxName, cmd, {
        workdir: flags.workdir,
        // OpenShell's terminal auto-detection allocates a pseudo-terminal for
        // every call from an interactive terminal. That pty reports a 1x1
        // window and merges stderr into stdout, so width-formatted output
        // collapses and an outer redirect stops applying (#10753). This
        // command runs commands non-interactively, so ask for a pty only when
        // the caller does.
        tty: flags.tty === true,
        timeoutSeconds: flags.timeout,
        stdin: flags.stdin,
      });
    });
  }
}
