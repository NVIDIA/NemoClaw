// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runBackupAllAction } from "../../global-cli-actions";
import { NemoClawCommand } from "../../cli/nemoclaw-oclif-command";

export default class BackupAllCommand extends NemoClawCommand {
  static id = "backup-all";
  static strict = true;
  static summary = "Back up all sandbox state before upgrade";
  static description = "Back up registered, running sandbox state before upgrading.";
  static usage = ["backup-all"];
  static examples = ["<%= config.bin %> backup-all"];
  static flags = {};

  public async run(): Promise<void> {
    await this.parse(BackupAllCommand);
    runBackupAllAction();
  }
}
