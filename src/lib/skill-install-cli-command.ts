// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- thin oclif wrapper covered through CLI integration tests. */

import { Args, Command, Flags } from "@oclif/core";

import { installSandboxSkill } from "./sandbox-runtime-actions";

let runtimeBridgeFactory = () => ({ sandboxSkillInstall: installSandboxSkill });

export function setSkillInstallRuntimeBridgeFactoryForTest(
  factory: () => { sandboxSkillInstall: (sandboxName: string, args?: string[]) => Promise<void> },
): void {
  runtimeBridgeFactory = factory;
}

function getRuntimeBridge() {
  return runtimeBridgeFactory();
}

export class SkillCliCommand extends Command {
  static id = "sandbox:skill";
  static strict = false;
  static summary = "Show skill command usage";
  static description = "Show skill install usage or report unknown skill subcommands.";
  static usage = ["<name> skill install <path>"];
  static examples = ["<%= config.bin %> alpha skill install ./my-skill"];

  public async run(): Promise<void> {
    const [sandboxName, ...actionArgs] = this.argv;
    if (!sandboxName || sandboxName.trim() === "") {
      this.error("Missing required sandboxName for skill.", { exit: 2 });
    }
    await getRuntimeBridge().sandboxSkillInstall(sandboxName, actionArgs);
  }
}

export default class SkillInstallCliCommand extends Command {
  static id = "sandbox:skill:install";
  static strict = true;
  static summary = "Deploy a skill directory to the sandbox";
  static description = "Validate a local SKILL.md directory and upload it to a running sandbox.";
  static usage = ["<name> skill install <path>"];
  static examples = [
    "<%= config.bin %> alpha skill install ./my-skill",
    "<%= config.bin %> alpha skill install ./my-skill/SKILL.md",
  ];
  static args = {
    sandboxName: Args.string({
      name: "sandbox",
      description: "Sandbox name",
      required: true,
    }),
    skillPath: Args.string({
      name: "path",
      description: "Skill directory or direct path to SKILL.md",
      required: true,
    }),
  };
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(SkillInstallCliCommand);
    await getRuntimeBridge().sandboxSkillInstall(args.sandboxName, ["install", args.skillPath]);
  }
}
