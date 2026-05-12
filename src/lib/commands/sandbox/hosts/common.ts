// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";

type HostsRuntimeBridge = {
  addSandboxHostAlias: (sandboxName: string, args?: string[]) => void;
  listSandboxHostAliases: (sandboxName: string) => void;
  removeSandboxHostAlias: (sandboxName: string, args?: string[]) => void;
};

let runtimeBridgeFactory = (): HostsRuntimeBridge => {
  const actions = require("../../../actions/sandbox/host-aliases") as HostsRuntimeBridge;
  return actions;
};

export function setHostsRuntimeBridgeFactoryForTest(factory: () => HostsRuntimeBridge): void {
  runtimeBridgeFactory = factory;
}

export function getHostsRuntimeBridge(): HostsRuntimeBridge {
  return runtimeBridgeFactory();
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
  help: Flags.help({ char: "h" }),
  "dry-run": Flags.boolean({ description: "Preview the JSON patch without applying it" }),
};
