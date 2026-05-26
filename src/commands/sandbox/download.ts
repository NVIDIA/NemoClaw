// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";
import { downloadSandbox } from "../../lib/actions/sandbox/transfer";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

export default class SandboxDownloadCommand extends NemoClawCommand {
  static id = "sandbox:download";
  static strict = true;
  static summary = "Download a file or directory from a running sandbox to the host";
  static description =
    "Thin wrapper around `openshell sandbox download` so users can pull workspace files out of a sandbox without remembering the raw OpenShell command. Useful as a manual escape hatch when snapshot or backup-all coverage is incomplete.";
  static usage = ["<name> <sandbox-path> [<dest>]"];
  static examples = [
    "<%= config.bin %> sandbox download alpha /sandbox/.openclaw/workspace/USER.md",
    "<%= config.bin %> sandbox download alpha /sandbox/.openclaw/workspace ./alpha-workspace",
  ];
  static args = {
    sandboxName: Args.string({ name: "sandbox", description: "Sandbox name", required: true }),
    sandboxPath: Args.string({
      name: "sandbox-path",
      description: "Path inside the sandbox to download",
      required: true,
    }),
    destination: Args.string({
      name: "dest",
      description: "Local destination (defaults to the current directory)",
      required: false,
    }),
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(SandboxDownloadCommand);
    await downloadSandbox(args.sandboxName, args.sandboxPath, {
      destination: args.destination,
    });
  }
}
