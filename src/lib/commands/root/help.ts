// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command } from "@oclif/core";

import { showRootHelp } from "../../global-cli-actions";

export default class RootHelpCommand extends Command {
  static id = "root:help";
  static hidden = true;
  static strict = false;
  static summary = "Show help";

  public async run(): Promise<void> {
    this.parsed = true;
    showRootHelp();
  }
}
