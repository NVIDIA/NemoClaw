// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";

import { NemoClawCommand } from "../../cli/nemoclaw-oclif-command";
import { destroySandbox } from "../../actions/sandbox/runtime";

export default class DestroyCliCommand extends NemoClawCommand {
  static id = "sandbox:destroy";
  static strict = true;
  static summary = "Stop NIM and delete sandbox";
  static description = "Destroy a sandbox and remove its local registry entry.";
  static usage = ["<name> [--yes|-y|--force] [--cleanup-gateway|--no-cleanup-gateway]"];
  static examples = [
    "<%= config.bin %> sandbox destroy alpha",
    "<%= config.bin %> sandbox destroy alpha --yes",
    "<%= config.bin %> sandbox destroy alpha --yes --cleanup-gateway",
  ];
  static args = {
    sandboxName: Args.string({ name: "sandbox", description: "Sandbox name", required: true }),
  };
  static flags = {
    yes: Flags.boolean({ char: "y", description: "Skip the confirmation prompt" }),
    force: Flags.boolean({ description: "Skip the confirmation prompt" }),
    "cleanup-gateway": Flags.boolean({
      description:
        "When destroying the last sandbox, also tear down the shared NemoClaw gateway. Default: preserve. NEMOCLAW_CLEANUP_GATEWAY=1 sets the same default.",
      allowNo: true,
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(DestroyCliCommand);
    const cleanupGatewayFlag = flags["cleanup-gateway"];
    await destroySandbox(args.sandboxName, {
      force: flags.force === true,
      yes: flags.yes === true,
      ...(cleanupGatewayFlag === undefined ? {} : { cleanupGateway: cleanupGatewayFlag }),
    });
  }
}
