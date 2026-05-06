// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";

type PolicyRuntimeBridge = {
  sandboxPolicyAdd: (sandboxName: string, args?: string[]) => Promise<void>;
  sandboxPolicyRemove: (sandboxName: string, args?: string[]) => Promise<void>;
};

let runtimeBridgeFactory = (): PolicyRuntimeBridge => {
  const actions = require("../../../policy-channel-actions") as {
    addSandboxPolicy: PolicyRuntimeBridge["sandboxPolicyAdd"];
    removeSandboxPolicy: PolicyRuntimeBridge["sandboxPolicyRemove"];
  };
  return {
    sandboxPolicyAdd: actions.addSandboxPolicy,
    sandboxPolicyRemove: actions.removeSandboxPolicy,
  };
};

export function setPolicyRuntimeBridgeFactoryForTest(factory: () => PolicyRuntimeBridge): void {
  runtimeBridgeFactory = factory;
}

export function getPolicyRuntimeBridge(): PolicyRuntimeBridge {
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

export function appendCommonPolicyFlags(
  args: string[],
  flags: { yes?: boolean; force?: boolean; "dry-run"?: boolean },
): void {
  if (flags.yes) args.push("--yes");
  if (flags.force) args.push("--force");
  if (flags["dry-run"]) args.push("--dry-run");
}

export const policyMutationArgs = { sandboxName: sandboxNameArg, preset: presetArg };

export const policyMutationFlags = {
  help: Flags.help({ char: "h" }),
  yes: Flags.boolean({ char: "y", description: "Skip the confirmation prompt" }),
  force: Flags.boolean({ description: "Skip the confirmation prompt" }),
  "dry-run": Flags.boolean({ description: "Preview without applying" }),
};
