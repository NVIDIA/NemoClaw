// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";
import { NemoClawCommand } from "../../../../lib/cli/nemoclaw-oclif-command";
import {
  executeCuaSecurityCommand,
  renderCuaSecurityResult,
} from "../../../../lib/cua/security-command";

export default class SandboxCuaSecurityVerifyCommand extends NemoClawCommand {
  static enableJsonFlag = true;
  static id = "sandbox:cua:security:verify";
  static strict = true;
  static summary = "Verify and record the CUA deny-default security boundary";
  static description =
    "Use a trusted host-side verifier to prove the current policy, target, isolation, secret, artifact, and authority boundaries.";
  static examples = [
    "<%= config.bin %> sandbox cua security verify alpha --adapter /opt/cua-security-adapter --json",
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
      description: "Absolute path to the operator-owned CUA security verifier",
      required: true,
    }),
  };

  public async run(): Promise<unknown> {
    const { args, flags } = await this.parse(SandboxCuaSecurityVerifyCommand);
    const rendered = renderCuaSecurityResult(
      "security.verify",
      executeCuaSecurityCommand({
        operation: "security.verify",
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
