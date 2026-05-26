// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";
import { runBackupAllAction } from "../lib/actions/global";
import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";

export default class BackupAllCommand extends NemoClawCommand {
  static id = "backup-all";
  static strict = true;
  static summary = "Back up all sandbox state before upgrade";
  static description = "Back up registered, running sandbox state before upgrading.";
  static usage = ["backup-all [--save-host <path>]"];
  static examples = [
    "<%= config.bin %> backup-all",
    "<%= config.bin %> backup-all --save-host ~/nemoclaw-backups",
  ];
  static flags = {
    "save-host": Flags.string({
      description:
        "Copy every successful backup to this host path so it survives ~/.nemoclaw removal",
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(BackupAllCommand);
    await runBackupAllAction({ saveHost: flags["save-host"] });
  }
}
