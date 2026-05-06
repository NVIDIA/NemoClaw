// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command } from "@oclif/core";

import { showVersion } from "../../global-cli-actions";

export default class VersionCommand extends Command {
  static id = "root:version";
  static hidden = true;
  static strict = true;
  static summary = "Show version";

  public async run(): Promise<void> {
    this.parsed = true;
    showVersion();
  }
}
