// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";
import {
  listServingProfiles,
  renderServingProfiles,
} from "../../lib/inference/serving/profile-list";

export default class ProfilesListCommand extends NemoClawCommand {
  static id = "profiles:list";
  static strict = true;
  static enableJsonFlag = true;
  static summary = "List installed serving profiles and evaluate host compatibility";
  static description =
    "Inspect the installed serving catalog and current host without downloading models or changing host or runtime state.";
  static usage = ["profiles list [--json]"];
  static examples = ["<%= config.bin %> profiles list", "<%= config.bin %> profiles list --json"];
  static flags = {};
  static publicDisplay = [
    {
      usage: "nemoclaw profiles list",
      description: "List installed serving profiles and evaluate host compatibility",
      flags: "[--json]",
      group: "Getting Started",
      scope: "global",
      order: 1.6,
    },
  ] as const;

  public async run(): Promise<unknown> {
    await this.parse(ProfilesListCommand);
    const entries = listServingProfiles();
    if (this.jsonEnabled()) return entries;
    this.log(renderServingProfiles(entries));
  }
}
