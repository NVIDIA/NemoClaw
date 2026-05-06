// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command, Flags } from "@oclif/core";

import { printCredentialsUsage } from "./credentials/common";

export default class CredentialsCommand extends Command {
  static id = "credentials";
  static strict = true;
  static summary = "Manage provider credentials";
  static description =
    "List or reset provider credentials registered with the OpenShell gateway.";
  static usage = ["credentials <list|reset>"];
  static examples = [
    "<%= config.bin %> credentials list",
    "<%= config.bin %> credentials reset nvidia-prod --yes",
  ];
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    await this.parse(CredentialsCommand);
    printCredentialsUsage(this.log.bind(this));
  }
}
