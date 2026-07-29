// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";
import { NemoClawCommand } from "../../../../lib/cli/nemoclaw-oclif-command";
import { executeCuaTargetCommand, renderCuaTargetResult } from "../../../../lib/cua/target-command";

export default class SandboxCuaTargetAttachCommand extends NemoClawCommand {
  static enableJsonFlag = true;
  static id = "sandbox:cua:target:attach";
  static strict = true;
  static summary = "Attach and verify one disposable CUA desktop target";
  static description =
    "Use a host-side adapter to attach one target after immutable identity and browser, computer, and terminal health checks pass.";
  static examples = [
    "<%= config.bin %> sandbox cua target attach alpha --adapter /opt/cua-target-adapter --target-manifest ./target.json",
  ];
  static usage = ["<name> --adapter <absolute-path> --target-manifest <path> [--json]"];
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
    "target-manifest": Flags.string({
      description: "Secret-free JSON manifest containing expected target identities",
      required: true,
    }),
  };

  public async run(): Promise<unknown> {
    const { args, flags } = await this.parse(SandboxCuaTargetAttachCommand);
    const rendered = renderCuaTargetResult(
      "target.attach",
      executeCuaTargetCommand({
        operation: "target.attach",
        sandboxName: args.sandboxName,
        adapterPath: flags.adapter,
        manifestPath: flags["target-manifest"],
      }),
      this.jsonEnabled(),
    );
    this.setExitCode(rendered.exitCode);
    if (rendered.error) console.error(rendered.error);
    if (rendered.message) this.log(rendered.message);
    return rendered.output;
  }
}
