// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";
import { NemoClawCommand } from "../../../../lib/cli/nemoclaw-oclif-command";
import { executeCuaTargetCommand, renderCuaTargetResult } from "../../../../lib/cua/target-command";

export default class SandboxCuaTargetStatusCommand extends NemoClawCommand {
  static enableJsonFlag = true;
  static id = "sandbox:cua:target:status";
  static strict = true;
  static summary = "Show the secret-free CUA target attachment state";
  static description =
    "Read the recorded target identity, capability health, and active-task projection without invoking the target adapter.";
  static examples = ["<%= config.bin %> sandbox cua target status alpha --json"];
  static usage = ["<name> [--json]"];
  static args = {
    sandboxName: Args.string({
      name: "sandbox",
      description: "Sandbox name",
      required: true,
    }),
  };
  static flags = {};

  public async run(): Promise<unknown> {
    const { args } = await this.parse(SandboxCuaTargetStatusCommand);
    const rendered = renderCuaTargetResult(
      "target.status",
      await executeCuaTargetCommand({
        operation: "target.status",
        sandboxName: args.sandboxName,
      }),
      this.jsonEnabled(),
    );
    this.setExitCode(rendered.exitCode);
    if (rendered.error) console.error(rendered.error);
    if (rendered.message) this.log(rendered.message);
    return rendered.output;
  }
}
