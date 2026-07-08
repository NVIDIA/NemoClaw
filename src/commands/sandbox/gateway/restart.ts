// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";

import { restartSandboxGateway } from "../../../lib/actions/sandbox/process-recovery";
import { quietFlag } from "../../../lib/cli/common-flags";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

export default class GatewayRestartCliCommand extends NemoClawCommand {
  static id = "sandbox:gateway:restart";
  static strict = true;
  static summary = "Restart the sandbox agent gateway";
  static description =
    "Restart the sandbox agent gateway through its privileged lifecycle controller, wait for health, and check or recover host forwards.";
  static usage = ["<name> [--quiet|-q]"];
  static examples = [
    "<%= config.bin %> sandbox gateway restart alpha",
    "<%= config.bin %> sandbox gateway restart alpha --quiet",
  ];
  static args = {
    sandboxName: Args.string({
      name: "sandbox",
      description: "Sandbox name",
      required: true,
    }),
  };
  static flags = {
    quiet: quietFlag("Suppress progress output"),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(GatewayRestartCliCommand);
    const result = restartSandboxGateway(args.sandboxName, { quiet: flags.quiet === true });
    if (!result.ok) {
      this.setExitCode(1);
    }
  }
}
