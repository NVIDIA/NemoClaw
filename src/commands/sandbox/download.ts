// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";

import { downloadFromSandbox } from "../../lib/actions/sandbox/download";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";
import { sandboxNameArg } from "../../lib/sandbox/command-support";

export default class SandboxDownloadCommand extends NemoClawCommand {
  static id = "sandbox:download";
  static strict = true;
  static summary = "Download a file or directory from the sandbox to the host";
  static description =
    "Host-side wrapper around `openshell sandbox download`. Confirms before and after transfer that the source remains a regular file or directory; symbolic links, source-type changes, and other special source types are refused. If the source type cannot be confirmed, the command exits without publishing. Otherwise, it downloads to a fresh private temporary directory, verifies that OpenShell wrote an artifact, publishes the artifact to the requested destination, and removes the temporary directory. Existing destination directories resolve to their canonical paths; symbolic-link file destinations and new destinations below symbolic-link parents are rejected. Relative host destinations resolve against the caller's working directory. Absolute host destinations do not use caller-working-directory resolution.";
  static usage = ["<name> <sandbox-path> [host-dest]"];
  static examples = [
    "<%= config.bin %> sandbox download alpha /sandbox/.openclaw/workspace/SOUL.md ./",
    "<%= config.bin %> sandbox download alpha /sandbox/.openclaw/agents/main/sessions/ ./sessions/",
  ];
  static args = {
    sandboxName: sandboxNameArg,
    sandboxPath: Args.string({
      name: "sandbox-path",
      description: "Path inside the sandbox to download.",
      required: true,
    }),
    hostDest: Args.string({
      name: "host-dest",
      description: "Host destination (default: current directory).",
      required: false,
    }),
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(SandboxDownloadCommand);
    try {
      await downloadFromSandbox({
        sandboxName: args.sandboxName,
        sandboxPath: args.sandboxPath,
        hostDest: args.hostDest,
      });
    } catch (error) {
      this.failWithLines([`  ${(error as Error).message}`], 1);
    }
  }
}
