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
    "Thin host-side wrapper around `openshell sandbox download`. Validates that the sandbox is alive, then forwards the source and destination verbatim to the OpenShell transport so its file-system semantics (single-file vs. directory copy, trailing-slash handling, overwrite behaviour) stay the same.";
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
