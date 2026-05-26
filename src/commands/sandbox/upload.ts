// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";
import { uploadSandbox } from "../../lib/actions/sandbox/transfer";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

export default class SandboxUploadCommand extends NemoClawCommand {
  static id = "sandbox:upload";
  static strict = true;
  static summary = "Upload a local file or directory into a running sandbox";
  static description =
    "Thin wrapper around `openshell sandbox upload` so users can push host files into a sandbox without remembering the raw OpenShell command. Useful for restoring workspace files after a wipe or for staging configuration the agent needs.";
  static usage = ["<name> <local-path> [<dest>] [--no-git-ignore]"];
  static examples = [
    "<%= config.bin %> sandbox upload alpha ./USER.md /sandbox/.openclaw/workspace/USER.md",
    "<%= config.bin %> sandbox upload alpha ./workspace /sandbox/.openclaw/workspace --no-git-ignore",
  ];
  static args = {
    sandboxName: Args.string({ name: "sandbox", description: "Sandbox name", required: true }),
    localPath: Args.string({
      name: "local-path",
      description: "Local path to upload",
      required: true,
    }),
    destination: Args.string({
      name: "dest",
      description: "Destination path inside the sandbox (defaults to the working directory)",
      required: false,
    }),
  };
  static flags = {
    "no-git-ignore": Flags.boolean({
      description: "Disable `.gitignore` filtering so the upload includes everything",
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SandboxUploadCommand);
    await uploadSandbox(args.sandboxName, args.localPath, {
      destination: args.destination,
      noGitIgnore: flags["no-git-ignore"],
    });
  }
}
