// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";

import {
  runBackupAllAction,
  runGarbageCollectImagesAction,
  runUpgradeSandboxesAction,
} from "./global-cli-actions";
import { NemoClawCommand } from "./nemoclaw-oclif-command";

export class BackupAllCommand extends NemoClawCommand {
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

export class UpgradeSandboxesCommand extends NemoClawCommand {
  static id = "upgrade-sandboxes";
  static strict = true;
  static summary = "Detect and rebuild stale sandboxes";
  static description = "Detect stale sandboxes and optionally rebuild them.";
  static usage = ["upgrade-sandboxes [--check] [--auto] [--yes|-y]"];
  static examples = [
    "<%= config.bin %> upgrade-sandboxes --check",
    "<%= config.bin %> upgrade-sandboxes --auto --yes",
  ];
  static flags = {
    check: Flags.boolean({ description: "Only check whether sandboxes need upgrading" }),
    auto: Flags.boolean({ description: "Automatically rebuild running stale sandboxes" }),
    yes: Flags.boolean({ char: "y", description: "Skip confirmation prompts" }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(UpgradeSandboxesCommand);
    await runUpgradeSandboxesAction({
      auto: flags.auto === true,
      check: flags.check === true,
      yes: flags.yes === true,
    });
  }
}

export class GarbageCollectImagesCommand extends NemoClawCommand {
  static id = "gc";
  static strict = true;
  static summary = "Remove orphaned sandbox Docker images";
  static description = "Remove sandbox Docker images that are not referenced by registered sandboxes.";
  static usage = ["gc [--dry-run] [--yes|-y|--force]"];
  static examples = ["<%= config.bin %> gc --dry-run", "<%= config.bin %> gc --yes"];
  static flags = {
    "dry-run": Flags.boolean({ description: "Show images that would be removed without deleting" }),
    yes: Flags.boolean({ char: "y", description: "Skip the confirmation prompt" }),
    force: Flags.boolean({ description: "Skip the confirmation prompt" }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(GarbageCollectImagesCommand);
    await runGarbageCollectImagesAction({
      dryRun: flags["dry-run"] === true,
      force: flags.force === true,
      yes: flags.yes === true,
    });
  }
}
