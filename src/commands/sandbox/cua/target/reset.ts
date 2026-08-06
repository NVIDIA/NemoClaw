// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";
import { NemoClawCommand } from "../../../../lib/cli/nemoclaw-oclif-command";
import { executeCuaTargetCommand, renderCuaTargetResult } from "../../../../lib/cua/target-command";

export default class SandboxCuaTargetResetCommand extends NemoClawCommand {
  static enableJsonFlag = true;
  static id = "sandbox:cua:target:reset";
  static strict = true;
  static summary = "Report that CUA target reset is unavailable in this slice";
  static args = {
    sandboxName: Args.string({ name: "sandbox", description: "Sandbox name", required: true }),
  };
  static flags = {
    adapter: Flags.string({
      description: "Ignored compatibility path for the unavailable CUA target adapter",
    }),
  };

  public async run(): Promise<unknown> {
    const { args } = await this.parse(SandboxCuaTargetResetCommand);
    const rendered = renderCuaTargetResult(
      "target.reset",
      await executeCuaTargetCommand({
        operation: "target.reset",
        sandboxName: args.sandboxName,
      }),
      this.jsonEnabled(),
    );
    this.setExitCode(rendered.exitCode);
    if (rendered.error) console.error(rendered.error);
    return rendered.output;
  }
}
