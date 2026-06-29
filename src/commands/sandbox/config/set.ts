// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

import * as sandboxConfig from "../../../lib/sandbox/config";

const sandboxNameArg = Args.string({
  name: "sandbox",
  description: "Sandbox name",
  required: true,
});

export default class SandboxConfigSetCommand extends NemoClawCommand {
  static id = "sandbox:config:set";
  static strict = true;
  static summary = "Set sandbox configuration";
  static description = "Set sandbox agent configuration with new-path and SSRF validation.";
  static usage = ["<name> --key <dotpath> --value <value> [--restart] [--config-accept-new-path]"];
  static examples = [
    "<%= config.bin %> alpha config set --key model --value nvidia/nemotron",
    "<%= config.bin %> alpha config set --key web_search --value true --restart",
  ];
  static args = {
    sandboxName: sandboxNameArg,
  };
  static flags = {
    key: Flags.string({ description: "Dotpath to update in the config", required: true }),
    value: Flags.string({
      description: "Value to write; JSON values are parsed when possible",
      required: true,
    }),
    restart: Flags.boolean({
      description: "Signal the sandbox agent process to reload after writing",
    }),
    "config-accept-new-path": Flags.boolean({
      description: "Allow creating a config key that does not already exist",
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SandboxConfigSetCommand);
    try {
      await sandboxConfig.configSet(args.sandboxName, {
        key: flags.key ?? null,
        value: flags.value ?? null,
        restart: flags.restart ?? false,
        acceptNewPath: flags["config-accept-new-path"] ?? false,
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
