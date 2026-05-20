// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";

import { dryRunFlag, forceFlag, yesFlag } from "../cli/common-flags";
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

export function commonPolicyOptions(flags: {
  yes?: boolean;
  force?: boolean;
  "dry-run"?: boolean;
}) {
  return {
    yes: Boolean(flags.yes),
    force: Boolean(flags.force),
    dryRun: Boolean(flags["dry-run"]),
  };
}

export const policyMutationArgs = { sandboxName: sandboxNameArg, preset: presetArg };

export const policyMutationFlags = {
  yes: yesFlag(),
  force: forceFlag(),
  "dry-run": dryRunFlag(),
};
