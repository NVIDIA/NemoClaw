// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- thin oclif wrapper covered through CLI integration tests. */

import { Args, Command, Flags } from "@oclif/core";

type RuntimeBridge = {
  sandboxSkillInstall: (sandboxName: string, args?: string[]) => Promise<void>;
};

let runtimeBridgeFactory = (): RuntimeBridge => require("../nemoclaw") as RuntimeBridge;

export function setSkillInstallRuntimeBridgeFactoryForTest(
  factory: () => RuntimeBridge,
): void {
  runtimeBridgeFactory = factory;
}

function getRuntimeBridge(): RuntimeBridge {
  return runtimeBridgeFactory();
}

export default class SkillInstallCliCommand extends Command {
  static id = "sandbox:skill:install";
  static strict = true;
  static summary = "Deploy a skill directory to the sandbox";
  static description = "Validate a local SKILL.md directory and upload it to a running sandbox.";
  static usage = ["<name> skill install <path>"];
  static args = {
    sandboxName: Args.string({
      name: "sandbox",
      description: "Sandbox name",
      required: true,
    }),
    skillPath: Args.string({
      name: "path",
      description: "Skill directory or direct path to SKILL.md",
      required: false,
    }),
  };
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(SkillInstallCliCommand);
    await getRuntimeBridge().sandboxSkillInstall(
      args.sandboxName,
      args.skillPath ? ["install", args.skillPath] : ["install"],
    );
  }
}
