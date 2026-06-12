// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";

import { uploadToSandbox } from "../../lib/actions/sandbox/upload";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";
import { sandboxNameArg } from "../../lib/sandbox/command-support";

export default class SandboxUploadCommand extends NemoClawCommand {
  static id = "sandbox:upload";
  static strict = true;
  static summary = "Upload a file or directory from the host into the sandbox";
  static description =
    "Thin host-side wrapper around `openshell sandbox upload`. Validates that the sandbox is alive, then forwards the source and destination verbatim to the OpenShell transport so its file-system semantics (single-file vs. directory copy, trailing-slash handling, overwrite behaviour) stay the same.";
  static usage = ["<name> <host-path> [sandbox-dest]"];
  static examples = [
    "<%= config.bin %> sandbox upload alpha ./local-file /sandbox/",
    "<%= config.bin %> sandbox upload alpha ./backups/SOUL.md /sandbox/.openclaw/workspace/SOUL.md",
  ];
  static args = {
    sandboxName: sandboxNameArg,
    hostPath: Args.string({
      name: "host-path",
      description: "Path on the host to upload.",
      required: true,
    }),
    sandboxDest: Args.string({
      name: "sandbox-dest",
      description: "Destination inside the sandbox (default: /sandbox/).",
      required: false,
    }),
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(SandboxUploadCommand);
    try {
      await uploadToSandbox({
        sandboxName: args.sandboxName,
        hostPath: args.hostPath,
        sandboxDest: args.sandboxDest,
      });
    } catch (error) {
      this.failWithLines([`  ${(error as Error).message}`], 1);
    }
  }
}
