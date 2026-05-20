// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";

import { dryRunFlag } from "../cli/common-flags";

type HostsRuntimeBridge = {
  addSandboxHostAlias: (sandboxName: string, args?: string[]) => void;
  listSandboxHostAliases: (sandboxName: string) => void;
  removeSandboxHostAlias: (sandboxName: string, args?: string[]) => void;
};

type HostAliasFailure = {
  name?: string;
  lines?: readonly string[];
  exitCode?: number;
};

let runtimeBridgeFactory = (): HostsRuntimeBridge => {
  const actions = require("../actions/sandbox/host-aliases") as HostsRuntimeBridge;
  return actions;
};

export function getHostsRuntimeBridge(): HostsRuntimeBridge {
  return runtimeBridgeFactory();
}

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

export function buildHostAliasArgs(
  values: Array<string | undefined>,
  flags: { "dry-run"?: boolean },
): string[] {
  const args = values.filter((value): value is string => Boolean(value));
  if (flags["dry-run"]) args.push("--dry-run");
  return args;
}

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
