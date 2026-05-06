// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command, Flags } from "@oclif/core";

import { CLI_NAME } from "../../../branding";
import * as sandboxConfig from "../../../sandbox-config";
import { sandboxNameArg } from "../common";

export default class SandboxConfigGetCommand extends Command {
  static id = "sandbox:config:get";
  static strict = true;
  static summary = "Get sandbox configuration";
  static description = "Read sanitized sandbox agent configuration.";
  static usage = ["<name> config get [--key dotpath] [--format json|yaml]"];
  static examples = [
    "<%= config.bin %> alpha config get",
    "<%= config.bin %> alpha config get --key model --format yaml",
  ];
  static args = {
    sandboxName: sandboxNameArg,
  };
  static flags = {
    help: Flags.help({ char: "h" }),
    key: Flags.string({ description: "Dotpath to read from the sanitized config" }),
    format: Flags.string({
      description: "Output format",
      options: ["json", "yaml"],
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SandboxConfigGetCommand);
    sandboxConfig.configGet(args.sandboxName, {
      key: flags.key ?? null,
      format: flags.format ?? "json",
    });
  }
}

export function printConfigUsageAndExit(): never {
  console.error(`  Usage: ${CLI_NAME} <name> config get [--key dotpath] [--format json|yaml]`);
  process.exit(1);
}
