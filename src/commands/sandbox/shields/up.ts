// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";
import { sandboxNameArg } from "../../../lib/sandbox/command-support";
import * as shields from "../../../lib/shields/index";
import { withSandboxMutationLock } from "../../../lib/state/mcp-lifecycle-lock";

export default class ShieldsUpCommand extends NemoClawCommand {
  static id = "sandbox:shields:up";
  static hidden = true;
  static strict = true;
  static summary = "Raise sandbox security shields";
  static description = "Restore sandbox shields from the saved snapshot.";
  static usage = ["<name>"];
  static args = { sandboxName: sandboxNameArg };
  static flags = {};

  public async run(): Promise<void> {
    const { args } = await this.parse(ShieldsUpCommand);
    try {
      await withSandboxMutationLock(args.sandboxName, () =>
        shields.shieldsUp(args.sandboxName, { throwOnError: true }),
      );
    } catch (error) {
      if (!(error instanceof shields.DeferredShieldsExit)) throw error;
      // Diagnostics were already printed before the sentinel was thrown;
      // translate it to an exit code now that the mutation lock is released.
      this.setExitCode(error.exitCode);
    }
  }
}
