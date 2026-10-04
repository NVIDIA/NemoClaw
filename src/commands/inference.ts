// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";

export default class InferenceCommand extends NemoClawCommand {
  static id = "inference";
  static strict = true;
  static summary = "Manage the NemoClaw inference route";
  static description = "Read or switch the OpenShell inference route used by NemoClaw sandboxes.";
  static usage = ["inference <get|set>"];
  static examples = [
    "<%= config.bin %> inference get",
    "<%= config.bin %> inference set --provider nvidia-prod --model nvidia/nemotron-3-super-120b-a12b",
  ];
  static flags = {};

  public async run(): Promise<void> {
    await this.parse(InferenceCommand);
    this.log(`Usage: ${this.config.bin} inference <get|set>`);
  }
}
