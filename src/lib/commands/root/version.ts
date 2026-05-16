// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { showVersion } from "../../actions/global";
import { NemoClawCommand } from "../../cli/nemoclaw-oclif-command";

export default class VersionCommand extends NemoClawCommand {
  static id = "root:version";
  static hidden = true;
  static strict = true;
  static summary = "Show version";

  public async run(): Promise<void> {
    this.parsed = true;
    showVersion();
  }
}
