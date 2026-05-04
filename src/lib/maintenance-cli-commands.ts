// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- thin oclif adapters covered through CLI integration tests. */

import { Command, Flags } from "@oclif/core";

import {
  runBackupAllAction,
  runGarbageCollectImagesAction,
  runUpgradeSandboxesAction,
} from "./global-cli-actions";

export class BackupAllCommand extends Command {
  static id = "backup-all";
  static strict = true;
  static summary = "Back up all sandbox state before upgrade";
  static description = "Back up registered, running sandbox state before upgrading.";
  static usage = ["backup-all"];
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    await this.parse(BackupAllCommand);
    runBackupAllAction();
  }
}

export class UpgradeSandboxesCommand extends Command {
  static id = "upgrade-sandboxes";
  static strict = true;
  static summary = "Detect and rebuild stale sandboxes";
  static description = "Detect stale sandboxes and optionally rebuild them.";
  static usage = ["upgrade-sandboxes [--check] [--auto] [--yes]"];
  static flags = {
    help: Flags.help({ char: "h" }),
    check: Flags.boolean({ description: "Only check whether sandboxes need upgrading" }),
    auto: Flags.boolean({ description: "Automatically rebuild running stale sandboxes" }),
    yes: Flags.boolean({ description: "Skip confirmation prompts" }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(UpgradeSandboxesCommand);
    const args: string[] = [];
    if (flags.check) args.push("--check");
    if (flags.auto) args.push("--auto");
    if (flags.yes) args.push("--yes");
    await runUpgradeSandboxesAction(args);
  }
}

export class GarbageCollectImagesCommand extends Command {
  static id = "gc";
  static strict = true;
  static summary = "Remove orphaned sandbox Docker images";
  static description = "Remove sandbox Docker images that are not referenced by registered sandboxes.";
  static usage = ["gc [--dry-run] [--yes|--force]"];
  static flags = {
    help: Flags.help({ char: "h" }),
    "dry-run": Flags.boolean({ description: "Show images that would be removed without deleting" }),
    yes: Flags.boolean({ description: "Skip the confirmation prompt" }),
    force: Flags.boolean({ description: "Skip the confirmation prompt" }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(GarbageCollectImagesCommand);
    const args: string[] = [];
    if (flags["dry-run"]) args.push("--dry-run");
    if (flags.yes) args.push("--yes");
    if (flags.force) args.push("--force");
    await runGarbageCollectImagesAction(args);
  }
}
