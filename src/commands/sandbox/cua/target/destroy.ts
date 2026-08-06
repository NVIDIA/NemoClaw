// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";
import { NemoClawCommand } from "../../../../lib/cli/nemoclaw-oclif-command";
import { executeCuaTargetCommand, renderCuaTargetResult } from "../../../../lib/cua/target-command";

export default class SandboxCuaTargetDestroyCommand extends NemoClawCommand {
  static enableJsonFlag = true;
  static id = "sandbox:cua:target:destroy";
  static strict = true;
  static summary = "Destroy the disposable CUA target and clear attachment state";
  static description =
    "Ask the host-side adapter to destroy the target before NemoClaw clears its secret-free attachment projection.";
  static examples = [
    "<%= config.bin %> sandbox cua target destroy alpha --adapter /opt/cua-target-adapter",
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
    const { args, flags } = await this.parse(SandboxCuaTargetDestroyCommand);
    const rendered = renderCuaTargetResult(
      "target.destroy",
      await executeCuaTargetCommand({
        operation: "target.destroy",
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
