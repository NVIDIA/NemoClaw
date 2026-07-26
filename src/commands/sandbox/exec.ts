// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";
import { execSandbox } from "../../lib/actions/sandbox/exec";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

export default class SandboxExecCommand extends NemoClawCommand {
  static id = "sandbox:exec";
  static strict = false;
  static summary = "Run a command non-interactively in a running sandbox";
  static description =
    "Run a single command inside a running sandbox via the OpenShell exec endpoint. The command runs as the sandbox user (HOME=/sandbox) and exits with the remote command's exit code. Use `--` to separate exec options from the user command; arguments after it preserve embedded line endings and quotes. NUL bytes are rejected, and `--workdir` must remain single-line. Stdin is inherited by default only when it is a terminal; pass `--stdin` to forward an intentional pipe.";
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
      description: "Allocate a pseudo-terminal; defaults to auto-detection",
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
    const { args, flags, argv } = await this.parse(SandboxExecCommand);
    const separatorIndex = originalArgv.indexOf("--");
    // oclif's non-strict parser preserves ordinary inner flags, but sorts
    // repeated unknown flags by their first input position. That turns a
    // command such as `env -u A -u B` into `env -u -u A B`. Once the caller
    // used the documented `--` boundary, take the command from oclif's
    // original argv instead of its reconstructed parser output.
    const cmd = (
      separatorIndex === -1 ? argv.slice(1) : originalArgv.slice(separatorIndex + 1)
    ) as string[];
    await execSandbox(args.sandboxName, cmd, {
      workdir: flags.workdir,
      tty: typeof flags.tty === "boolean" ? flags.tty : null,
      timeoutSeconds: flags.timeout,
      stdin: flags.stdin,
    });
  }
}
