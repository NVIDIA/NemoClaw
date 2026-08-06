// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";
import { NemoClawCommand } from "../../../../lib/cli/nemoclaw-oclif-command";
import {
  executeCuaSecurityCommand,
  renderCuaSecurityResult,
} from "../../../../lib/cua/security-command";

export default class SandboxCuaSecurityStatusCommand extends NemoClawCommand {
  static enableJsonFlag = true;
  static id = "sandbox:cua:security:status";
  static strict = true;
  static summary = "Show the content-free CUA security attestation";
  static description =
    "Validate the recorded security attestation against the current runtime, policy, inference, and target identities.";
  static examples = ["<%= config.bin %> sandbox cua security status alpha --json"];
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
    const { args } = await this.parse(SandboxCuaSecurityStatusCommand);
    const rendered = renderCuaSecurityResult(
      "security.status",
      await executeCuaSecurityCommand({
        operation: "security.status",
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
