// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";
import { NemoClawCommand } from "../../cli/nemoclaw-oclif-command";

import { execSandbox } from "../../actions/sandbox/exec";

export default class SandboxExecCommand extends NemoClawCommand {
  static id = "sandbox:exec";
  static strict = false;
  static summary = "Run a command non-interactively in a running sandbox";
  static description =
    "Run a single command inside a running sandbox via the OpenShell exec endpoint. The command runs as the sandbox user (HOME=/sandbox) and exits with the remote command's exit code. Use `--` to separate exec options from the user command.";
  static usage = ["<name> [--workdir <dir>] [--tty|--no-tty] [--timeout <s>] -- <cmd> [args...]"];
  static examples = [
    "<%= config.bin %> sandbox exec alpha -- openclaw agent --agent main -m hi",
    "<%= config.bin %> sandbox exec alpha --workdir /sandbox -- ls -la",
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
  };

  public async run(): Promise<void> {
    const { args, flags, argv } = await this.parse(SandboxExecCommand);
    const cmd = argv.slice(1) as string[];
    await execSandbox(args.sandboxName, cmd, {
      workdir: flags.workdir,
      tty: typeof flags.tty === "boolean" ? flags.tty : null,
      timeoutSeconds: flags.timeout,
    });
  }
}
