// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Command, Flags } from "@oclif/core";

import { CLI_NAME } from "./branding";
import * as sandboxConfig from "./sandbox-config";

type RuntimeBridge = {
  sandboxChannelsList: (sandboxName: string) => void;
  sandboxPolicyList: (sandboxName: string) => void;
  sandboxStatus: (sandboxName: string) => Promise<void>;
};

function getRuntimeBridge(): RuntimeBridge {
  return require("../nemoclaw") as RuntimeBridge;
}

const sandboxNameArg = Args.string({
  name: "sandbox",
  description: "Sandbox name",
  required: true,
});

export class SandboxStatusCommand extends Command {
  static id = "sandbox:status";
  static strict = true;
  static summary = "Sandbox health and NIM status";
  static description = "Show sandbox health, OpenShell gateway state, and local NIM status.";
  static usage = ["<name> status"];
  static args = {
    sandboxName: sandboxNameArg,
  };
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(SandboxStatusCommand);
    await getRuntimeBridge().sandboxStatus(args.sandboxName);
  }
}

export class SandboxPolicyListCommand extends Command {
  static id = "sandbox:policy-list";
  static strict = true;
  static summary = "List policy presets";
  static description = "List built-in and custom policy presets and show which are applied.";
  static usage = ["<name> policy-list"];
  static args = {
    sandboxName: sandboxNameArg,
  };
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(SandboxPolicyListCommand);
    getRuntimeBridge().sandboxPolicyList(args.sandboxName);
  }
}

export class SandboxChannelsListCommand extends Command {
  static id = "sandbox:channels:list";
  static strict = true;
  static summary = "List supported messaging channels";
  static description = "List supported messaging channels for a sandbox.";
  static usage = ["<name> channels list"];
  static args = {
    sandboxName: sandboxNameArg,
  };
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(SandboxChannelsListCommand);
    getRuntimeBridge().sandboxChannelsList(args.sandboxName);
  }
}

export class SandboxConfigGetCommand extends Command {
  static id = "sandbox:config:get";
  static strict = true;
  static summary = "Get sandbox configuration";
  static description = "Read sanitized sandbox agent configuration.";
  static usage = ["<name> config get [--key dotpath] [--format json|yaml]"];
  static args = {
    sandboxName: sandboxNameArg,
  };
  static flags = {
    help: Flags.help({ char: "h" }),
    key: Flags.string({ description: "Dotpath to read from the sanitized config" }),
    format: Flags.string({ description: "Output format (json or yaml)" }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SandboxConfigGetCommand);
    if (flags.format && flags.format !== "json" && flags.format !== "yaml") {
      console.error(`  Unknown format: ${flags.format}. Use json or yaml.`);
      process.exit(1);
    }
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
