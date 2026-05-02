// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- thin oclif adapters covered through CLI integration tests. */

import { Args, Command, Flags } from "@oclif/core";

import { addSandboxPolicy, removeSandboxPolicy } from "./policy-channel-actions";

type PolicyRuntimeBridge = {
  sandboxPolicyAdd: (sandboxName: string, args?: string[]) => Promise<void>;
  sandboxPolicyRemove: (sandboxName: string, args?: string[]) => Promise<void>;
};

let runtimeBridgeFactory = (): PolicyRuntimeBridge => ({
  sandboxPolicyAdd: addSandboxPolicy,
  sandboxPolicyRemove: removeSandboxPolicy,
});

export function setPolicyRuntimeBridgeFactoryForTest(factory: () => PolicyRuntimeBridge): void {
  runtimeBridgeFactory = factory;
}

function getRuntimeBridge(): PolicyRuntimeBridge {
  return runtimeBridgeFactory();
}

const sandboxNameArg = Args.string({
  name: "sandbox",
  description: "Sandbox name",
  required: true,
});
const presetArg = Args.string({
  name: "preset",
  description: "Policy preset name",
  required: false,
});

function appendCommonFlags(
  args: string[],
  flags: { yes?: boolean; force?: boolean; "dry-run"?: boolean },
): void {
  if (flags.yes) args.push("--yes");
  if (flags.force) args.push("--force");
  if (flags["dry-run"]) args.push("--dry-run");
}

export class PolicyAddCommand extends Command {
  static id = "sandbox:policy-add";
  static strict = true;
  static summary = "Add a network or filesystem policy preset";
  static description = "Add a built-in or custom policy preset to a sandbox.";
  static usage = ["<name> policy-add [preset] [--yes|-y] [--dry-run] [--from-file <path>] [--from-dir <path>]"];
  static args = { sandboxName: sandboxNameArg, preset: presetArg };
  static flags = {
    help: Flags.help({ char: "h" }),
    yes: Flags.boolean({ char: "y", description: "Skip the confirmation prompt" }),
    force: Flags.boolean({ description: "Skip the confirmation prompt" }),
    "dry-run": Flags.boolean({ description: "Preview without applying" }),
    "from-file": Flags.string({ description: "Load one custom preset YAML file" }),
    "from-dir": Flags.string({ description: "Load all custom preset YAML files in a directory" }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(PolicyAddCommand);
    const legacyArgs: string[] = [];
    if (args.preset) legacyArgs.push(args.preset);
    appendCommonFlags(legacyArgs, flags);
    if (flags["from-file"]) legacyArgs.push("--from-file", flags["from-file"]);
    if (flags["from-dir"]) legacyArgs.push("--from-dir", flags["from-dir"]);
    await getRuntimeBridge().sandboxPolicyAdd(args.sandboxName, legacyArgs);
  }
}

export class PolicyRemoveCommand extends Command {
  static id = "sandbox:policy-remove";
  static strict = true;
  static summary = "Remove an applied policy preset";
  static description = "Remove a built-in or custom policy preset from a sandbox.";
  static usage = ["<name> policy-remove [preset] [--yes|-y] [--dry-run]"];
  static args = { sandboxName: sandboxNameArg, preset: presetArg };
  static flags = {
    help: Flags.help({ char: "h" }),
    yes: Flags.boolean({ char: "y", description: "Skip the confirmation prompt" }),
    force: Flags.boolean({ description: "Skip the confirmation prompt" }),
    "dry-run": Flags.boolean({ description: "Preview without applying" }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(PolicyRemoveCommand);
    const legacyArgs: string[] = [];
    if (args.preset) legacyArgs.push(args.preset);
    appendCommonFlags(legacyArgs, flags);
    await getRuntimeBridge().sandboxPolicyRemove(args.sandboxName, legacyArgs);
  }
}
