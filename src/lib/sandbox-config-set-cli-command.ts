// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- thin oclif adapter covered through CLI integration tests. */

import { Args, Command, Flags } from "@oclif/core";

import * as sandboxConfig from "./sandbox-config";

const sandboxNameArg = Args.string({
  name: "sandbox",
  description: "Sandbox name",
  required: true,
});

export default class SandboxConfigSetCommand extends Command {
  static id = "sandbox:config:set";
  static strict = true;
  static summary = "Set sandbox configuration";
  static description = "Set sandbox agent configuration with new-path and SSRF validation.";
  static usage = ["<name> config set --key <dotpath> --value <value> [--restart] [--config-accept-new-path]"];
  static args = {
    sandboxName: sandboxNameArg,
  };
  static flags = {
    help: Flags.help({ char: "h" }),
    key: Flags.string({ description: "Dotpath to update in the config" }),
    value: Flags.string({ description: "Value to write; JSON values are parsed when possible" }),
    restart: Flags.boolean({ description: "Signal the sandbox agent process to reload after writing" }),
    "config-accept-new-path": Flags.boolean({
      description: "Allow creating a config key that does not already exist",
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SandboxConfigSetCommand);
    await sandboxConfig.configSet(args.sandboxName, {
      key: flags.key ?? null,
      value: flags.value ?? null,
      restart: flags.restart ?? false,
      acceptNewPath: flags["config-accept-new-path"] ?? false,
    });
  }
}
