// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";

import { downloadFromSandbox } from "../../lib/actions/sandbox/download";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";
import { sandboxNameArg } from "../../lib/sandbox/snapshot-command-support";

export default class SandboxDownloadCommand extends NemoClawCommand {
  static id = "sandbox:download";
  static strict = true;
  static summary = "Download a file or directory from a sandbox to the host";
  static description = [
    "Copies a file or directory out of a running sandbox to a host destination",
    "via `openshell sandbox download`. The destination directory is created if",
    "missing; OpenShell decides how to lay the source path under the destination",
    "(file vs directory copy follows OpenShell's semantics).",
    "",
    "Use this when you need raw on-disk artefacts from inside a sandbox (for",
    "example, a session transcript file under `.openclaw/sessions/`, an exported",
    "trajectory bundle, or any other workspace path). Higher-level subcommands",
    "such as `sessions export-trajectory --save-host` build on the same",
    "transport.",
  ].join("\n");
  static usage = ["<name> <sandbox-path> [host-dest]"];
  static examples = [
    "<%= config.bin %> sandbox download alpha /sandbox/.openclaw/sessions/main ./sessions-out/",
    "<%= config.bin %> sandbox download alpha /sandbox/workspace/notes.md .",
  ];
  static args = {
    sandboxName: sandboxNameArg,
    sandboxPath: Args.string({
      name: "sandbox-path",
      description: "Absolute or sandbox-relative path inside the sandbox to download.",
      required: true,
    }),
    hostDest: Args.string({
      name: "host-dest",
      description: "Host destination directory (defaults to the current working directory).",
      required: false,
    }),
  };
  static flags = {};

  public async run(): Promise<void> {
    const { args } = await this.parse(SandboxDownloadCommand);
    try {
      await downloadFromSandbox(args.sandboxName, {
        sandboxPath: args.sandboxPath,
        dest: args.hostDest,
      });
    } catch (error) {
      this.failWithLines([`  ${(error as Error).message}`], 1);
    }
  }
}
