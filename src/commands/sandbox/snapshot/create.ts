// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";
import { runSandboxSnapshot } from "../../../lib/actions/sandbox/snapshot";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

import { sandboxNameArg, snapshotCommandError } from "../../../lib/sandbox/snapshot-command-support";

export default class SnapshotCreateCommand extends NemoClawCommand {
  static id = "sandbox:snapshot:create";
  static strict = true;
  static summary = "Create a snapshot of sandbox state";
  static description = "Create an auto-versioned snapshot of sandbox workspace state.";
  static usage = ["<name> [--name <label>] [--save-host <path>]"];
  static examples = [
    "<%= config.bin %> sandbox snapshot create alpha",
    "<%= config.bin %> sandbox snapshot create alpha --name before-upgrade",
    "<%= config.bin %> sandbox snapshot create alpha --save-host ~/nemoclaw-backups",
  ];
  static args = {
    sandboxName: sandboxNameArg,
  };
  static flags = {
    name: Flags.string({ description: "Optional snapshot label" }),
    "save-host": Flags.string({
      description: "Copy the snapshot to this host path after creation",
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SnapshotCreateCommand);
    try {
      await runSandboxSnapshot(args.sandboxName, {
        kind: "create",
        name: flags.name,
        saveHost: flags["save-host"],
      });
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
