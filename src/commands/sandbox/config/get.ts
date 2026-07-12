// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

import * as sandboxConfig from "../../../lib/sandbox/config";
import { sandboxNameArg } from "../../../lib/sandbox/command-support";

export default class SandboxConfigGetCommand extends NemoClawCommand {
  static id = "sandbox:config:get";
  static strict = true;
  static summary = "Get sandbox configuration";
  static description = "Read sanitized sandbox agent configuration.";
  static usage = ["<name> [--key dotpath] [--format json|yaml]"];
  static examples = [
    "<%= config.bin %> sandbox config get alpha",
    "<%= config.bin %> sandbox config get alpha --key model --format yaml",
  ];
  static args = {
    sandboxName: sandboxNameArg,
  };
  static flags = {
    key: Flags.string({ description: "Dotpath to read from the sanitized config" }),
    format: Flags.string({
      description: "Output format",
      options: ["json", "yaml"],
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SandboxConfigGetCommand);
    try {
      sandboxConfig.configGet(args.sandboxName, {
        key: flags.key ?? null,
        format: flags.format ?? "json",
      });
    } catch (error) {
      if (error instanceof sandboxConfig.SandboxConfigError) {
        this.failWithLines(error.lines, error.exitCode);
        return;
      }
      throw error;
    }
  }
}
