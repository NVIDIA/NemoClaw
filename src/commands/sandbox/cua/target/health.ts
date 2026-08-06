// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";
import { NemoClawCommand } from "../../../../lib/cli/nemoclaw-oclif-command";
import { executeCuaTargetCommand, renderCuaTargetResult } from "../../../../lib/cua/target-command";

export default class SandboxCuaTargetHealthCommand extends NemoClawCommand {
  static enableJsonFlag = true;
  static id = "sandbox:cua:target:health";
  static strict = true;
  static summary = "Verify CUA target identity and capability health";
  static description =
    "Recover fresh host-side authority, verify immutable target identity, and check browser, computer, and terminal separately.";
  static examples = [
    "<%= config.bin %> sandbox cua target health alpha --adapter /opt/cua-target-adapter",
  ];
  static usage = ["<name> --adapter <absolute-path> [--json]"];
  static args = {
    sandboxName: Args.string({
      name: "sandbox",
      description: "Sandbox name",
      required: true,
    }),
  };
  static flags = {
    adapter: Flags.string({
      description: "Absolute path to the operator-owned CUA target adapter",
      required: true,
    }),
  };

  public async run(): Promise<unknown> {
    const { args, flags } = await this.parse(SandboxCuaTargetHealthCommand);
    const rendered = renderCuaTargetResult(
      "target.health",
      await executeCuaTargetCommand({
        operation: "target.health",
        sandboxName: args.sandboxName,
        adapterPath: flags.adapter,
      }),
      this.jsonEnabled(),
    );
    this.setExitCode(rendered.exitCode);
    if (rendered.error) console.error(rendered.error);
    if (rendered.message) this.log(rendered.message);
    return rendered.output;
  }
}
