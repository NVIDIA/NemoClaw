// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { showRootHelp } from "../../actions/global";
import { NemoClawCommand } from "../../cli/nemoclaw-oclif-command";

export default class RootHelpCommand extends NemoClawCommand {
  static id = "root:help";
  static hidden = true;
  static strict = false;
  static summary = "Show help";

  public async run(): Promise<void> {
    this.parsed = true;
    showRootHelp();
  }
}
