// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runSandboxSnapshot } from "../../lib/actions/sandbox/snapshot";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";
import { sandboxNameArg, snapshotCommandError } from "../../lib/sandbox/snapshot-command-support";

export default class SnapshotCommand extends NemoClawCommand {
  static id = "sandbox:snapshot";
  static strict = true;
  static summary = "Show snapshot usage";
  static description = "Show snapshot usage for create, list, and restore subcommands.";
  static usage = ["<create|list|restore> <name>"];
  static examples = [
    "<%= config.bin %> sandbox snapshot create alpha",
    "<%= config.bin %> sandbox snapshot list alpha",
    "<%= config.bin %> sandbox snapshot restore alpha",
  ];
  static args = {
    sandboxName: sandboxNameArg,
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(SnapshotCommand);
    try {
      await runSandboxSnapshot(args.sandboxName, { kind: "help" });
    } catch (error) {
      const snapshotError = snapshotCommandError(error);
      if (snapshotError) {
        this.failWithLines(snapshotError.lines, snapshotError.exitCode);
        return;
      }
      throw error;
    }
  }
}
