// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command, Flags } from "@oclif/core";

import { runOnboardAction, runSetupAction, runSetupSparkAction } from "./global-cli-actions";
import { NOTICE_ACCEPT_FLAG } from "./usage-notice";

const acceptFlagName = NOTICE_ACCEPT_FLAG.replace(/^--/, "");

const onboardUsage = [
  `onboard [--non-interactive] [--resume | --fresh] [--recreate-sandbox] [--from <Dockerfile>] [--name <sandbox>] [--agent <name>] [--control-ui-port <N>] [--yes | -y] [${NOTICE_ACCEPT_FLAG}]`,
];

const onboardExamples = [
  "<%= config.bin %> onboard",
  "<%= config.bin %> onboard --name alpha",
  "<%= config.bin %> onboard --resume",
  "<%= config.bin %> onboard --fresh",
  "<%= config.bin %> onboard --from ./Dockerfile --name alpha",
  `<%= config.bin %> onboard --non-interactive --name alpha ${NOTICE_ACCEPT_FLAG}`,
];

type OnboardFlags = {
  "non-interactive"?: boolean;
  resume?: boolean;
  fresh?: boolean;
  "recreate-sandbox"?: boolean;
  from?: string;
  name?: string;
  agent?: string;
  "control-ui-port"?: number;
  yes?: boolean;
  [acceptFlagName]?: boolean;
};

function buildOnboardFlags(): Record<string, any> {
  return {
    help: Flags.help({ char: "h" }),
    "non-interactive": Flags.boolean({ description: "Run without interactive prompts" }),
    resume: Flags.boolean({
      description: "Resume an interrupted onboarding session",
      exclusive: ["fresh"],
    }),
    fresh: Flags.boolean({
      description: "Ignore any saved onboarding session",
      exclusive: ["resume"],
    }),
    "recreate-sandbox": Flags.boolean({ description: "Delete and recreate an existing sandbox" }),
    from: Flags.string({ description: "Path to a Dockerfile to use as the sandbox image source" }),
    name: Flags.string({ description: "Sandbox name" }),
    agent: Flags.string({ description: "Agent runtime to onboard" }),
    "control-ui-port": Flags.integer({
      description: "Host port for the local control UI",
      max: 65535,
      min: 1024,
    }),
    yes: Flags.boolean({
      char: "y",
      description: "Auto-accept the Ollama model-download size confirmation",
    }),
    [acceptFlagName]: Flags.boolean({ description: "Accept the third-party software notice" }),
  } as Record<string, any>;
}

function toLegacyOnboardArgs(flags: OnboardFlags): string[] {
  const args: string[] = [];
  if (flags["non-interactive"]) args.push("--non-interactive");
  if (flags.resume) args.push("--resume");
  if (flags.fresh) args.push("--fresh");
  if (flags["recreate-sandbox"]) args.push("--recreate-sandbox");
  if (flags.from !== undefined) args.push("--from", flags.from);
  if (flags.name !== undefined) args.push("--name", flags.name);
  if (flags.agent !== undefined) args.push("--agent", flags.agent);
  if (flags["control-ui-port"] !== undefined) {
    args.push("--control-ui-port", String(flags["control-ui-port"]));
  }
  if (flags.yes) args.push("--yes");
  if (flags[acceptFlagName]) args.push(NOTICE_ACCEPT_FLAG);
  return args;
}

export class OnboardCliCommand extends Command {
  static id = "onboard";
  static strict = true;
  static summary = "Configure inference endpoint and credentials";
  static description = "Configure inference, credentials, and sandbox settings.";
  static usage = onboardUsage;
  static examples = onboardExamples;
  static flags = buildOnboardFlags();

  public async run(): Promise<void> {
    const { flags } = await this.parse(OnboardCliCommand);
    await runOnboardAction(toLegacyOnboardArgs(flags as OnboardFlags));
  }
}

export class SetupCliCommand extends Command {
  static id = "setup";
  static strict = true;
  static summary = "Deprecated alias for nemoclaw onboard";
  static description = "Deprecated alias for onboard.";
  static usage = ["setup [flags]"];
  static examples = ["<%= config.bin %> setup --name alpha"];
  static flags = buildOnboardFlags();

  public async run(): Promise<void> {
    if (this.argv.includes("--help") || this.argv.includes("-h")) {
      await runSetupAction(["--help"]);
      return;
    }
    const { flags } = await this.parse(SetupCliCommand);
    await runSetupAction(toLegacyOnboardArgs(flags as OnboardFlags));
  }
}

export class SetupSparkCliCommand extends Command {
  static id = "setup-spark";
  static strict = true;
  static summary = "Deprecated alias for nemoclaw onboard";
  static description = "Deprecated alias for onboard.";
  static usage = ["setup-spark [flags]"];
  static examples = ["<%= config.bin %> setup-spark --name alpha"];
  static flags = buildOnboardFlags();

  public async run(): Promise<void> {
    if (this.argv.includes("--help") || this.argv.includes("-h")) {
      await runSetupSparkAction(["--help"]);
      return;
    }
    const { flags } = await this.parse(SetupSparkCliCommand);
    await runSetupSparkAction(toLegacyOnboardArgs(flags as OnboardFlags));
  }
}
