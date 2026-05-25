// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";

import { dryRunFlag } from "../cli/common-flags";

type HostAliasFailure = {
  name?: string;
  lines?: readonly string[];
  exitCode?: number;
};

export function isHostAliasFailure(error: unknown): error is Required<HostAliasFailure> {
  return (
    !!error &&
    typeof error === "object" &&
    (error as HostAliasFailure).name === "HostAliasesCommandError" &&
    Array.isArray((error as HostAliasFailure).lines) &&
    typeof (error as HostAliasFailure).exitCode === "number"
  );
}

const sandboxNameArg = Args.string({ name: "sandbox", description: "Sandbox name", required: true });
const hostnameArg = Args.string({ name: "hostname", description: "Host alias name", required: true });
const ipArg = Args.string({ name: "ip", description: "IP address", required: true });

export const hostAliasSandboxArgs = {
  sandboxName: sandboxNameArg,
};

export const hostAliasMutationArgs = {
  sandboxName: sandboxNameArg,
  hostname: hostnameArg,
};

export const hostAliasAddArgs = {
  ...hostAliasMutationArgs,
  ip: ipArg,
};

export const hostAliasMutationFlags = {
  "dry-run": dryRunFlag("Preview the JSON patch without applying it"),
};
