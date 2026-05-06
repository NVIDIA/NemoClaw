// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";

import { NOTICE_ACCEPT_FLAG } from "../../usage-notice";

const acceptFlagName = NOTICE_ACCEPT_FLAG.replace(/^--/, "");

export const onboardUsage = [
  `onboard [--non-interactive] [--resume | --fresh] [--recreate-sandbox] [--gpu | --no-gpu] [--from <Dockerfile>] [--name <sandbox>] [--agent <name>] [--control-ui-port <N>] [--yes | -y] [${NOTICE_ACCEPT_FLAG}]`,
];

export const onboardExamples = [
  "<%= config.bin %> onboard",
  "<%= config.bin %> onboard --name alpha",
  "<%= config.bin %> onboard --resume",
  "<%= config.bin %> onboard --fresh",
  "<%= config.bin %> onboard --from ./Dockerfile --name alpha",
  `<%= config.bin %> onboard --non-interactive --yes --name alpha ${NOTICE_ACCEPT_FLAG}`,
];

export type OnboardFlags = {
  "non-interactive"?: boolean;
  resume?: boolean;
  fresh?: boolean;
  "recreate-sandbox"?: boolean;
  gpu?: boolean;
  "no-gpu"?: boolean;
  from?: string;
  name?: string;
  agent?: string;
  "control-ui-port"?: number;
  yes?: boolean;
  [acceptFlagName]?: boolean;
};

export function buildOnboardFlags(): Record<string, any> {
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
    gpu: Flags.boolean({
      description: "Require OpenShell GPU passthrough for the gateway and sandbox",
      exclusive: ["no-gpu"],
    }),
    "no-gpu": Flags.boolean({
      description: "Disable GPU passthrough even when an NVIDIA GPU is detected",
      exclusive: ["gpu"],
    }),
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
      description: "Auto-confirm prompts that are safe for unattended onboarding",
    }),
    [acceptFlagName]: Flags.boolean({ description: "Accept the third-party software notice" }),
  } as Record<string, any>;
}

export function toLegacyOnboardArgs(flags: OnboardFlags): string[] {
  const args: string[] = [];
  if (flags["non-interactive"]) args.push("--non-interactive");
  if (flags.resume) args.push("--resume");
  if (flags.fresh) args.push("--fresh");
  if (flags["recreate-sandbox"]) args.push("--recreate-sandbox");
  if (flags.gpu) args.push("--gpu");
  if (flags["no-gpu"]) args.push("--no-gpu");
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
