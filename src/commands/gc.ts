// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runGarbageCollectImagesAction } from "../lib/actions/global";
import { dryRunFlag, forceFlag, yesFlag } from "../lib/cli/common-flags";
import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";

export default class GarbageCollectImagesCommand extends NemoClawCommand {
  static id = "gc";
  static strict = true;
  static summary = "Remove orphaned sandbox Docker images";
  static description =
    "Remove sandbox Docker images that are not referenced by registered sandboxes.";
  static usage = ["gc [--dry-run] [--yes|-y|--force]"];
  static examples = ["<%= config.bin %> gc --dry-run", "<%= config.bin %> gc --yes"];
  static flags = {
    "dry-run": dryRunFlag("Show images that would be removed without deleting"),
    yes: yesFlag(),
    force: forceFlag(),
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
