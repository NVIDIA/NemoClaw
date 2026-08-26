// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runCredentialsListAction } from "../../lib/actions/credentials/list";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

export default class CredentialsListCommand extends NemoClawCommand {
  static id = "credentials:list";
  static strict = true;
  static summary = "List stored credential providers";
  static description = "List provider credentials registered with the OpenShell gateway.";
  static usage = ["credentials list"];
  static examples = ["<%= config.bin %> credentials list"];
  static flags = {};

  public async run(): Promise<void> {
    await this.parse(CredentialsListCommand);
    const result = await runCredentialsListAction(this.config.bin);
    if (result.exitCode !== 0) {
      this.failWithLines(result.failureLines, result.exitCode);
      return;
    }
    for (const line of result.outputLines) this.log(line);
  }
}
