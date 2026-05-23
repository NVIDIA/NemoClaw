// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";
import { runSandboxSnapshot } from "../../../lib/actions/sandbox/snapshot";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

import { sandboxNameArg, snapshotCommandError } from "../../../lib/sandbox/snapshot-command-support";

export default class SnapshotRestoreCommand extends NemoClawCommand {
  static id = "sandbox:snapshot:restore";
  static strict = true;
  static summary = "Restore state from a snapshot";
  static description = "Restore sandbox workspace state from a snapshot.";
  static usage = ["<name> [selector] [--to <dst>] [--force] [--yes|-y]"];
  static examples = [
    "<%= config.bin %> sandbox snapshot restore alpha",
    "<%= config.bin %> sandbox snapshot restore alpha v2",
    "<%= config.bin %> sandbox snapshot restore alpha before-upgrade --to beta",
    "<%= config.bin %> sandbox snapshot restore alpha v2 --to beta --force --yes",
  ];
  static args = {
    sandboxName: sandboxNameArg,
    selector: Args.string({
      name: "selector",
      description: "Snapshot version, name, or timestamp",
      required: false,
    }),
  };
  static flags = {
    to: Flags.string({ description: "Restore into another sandbox" }),
    force: Flags.boolean({
      description:
        "When --to names an existing sandbox, delete it before restoring. Refuses by default.",
    }),
    yes: Flags.boolean({
      char: "y",
      description: "Skip the interactive confirmation when --force is used.",
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SnapshotRestoreCommand);
    try {
      await runSandboxSnapshot(args.sandboxName, {
        kind: "restore",
        selector: args.selector,
        to: flags.to,
        force: flags.force,
        yes: flags.yes,
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
