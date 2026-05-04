// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- table-driven dispatch covered through CLI integration tests. */

export type OclifDispatch = {
  kind: "oclif";
  commandId: string;
  args: string[];
};

export type HelpDispatch = {
  kind: "help";
  usage: string;
};

export type UsageErrorDispatch = {
  kind: "usageError";
  lines: string[];
};

export type LegacyDispatch = {
  kind: "legacy";
  target: "policy-add" | "skill" | "snapshot";
};

export type UnknownSubcommandDispatch = {
  kind: "unknownSubcommand";
  command: "credentials" | "channels";
  subcommand: string;
};

export type UnknownActionDispatch = {
  kind: "unknownAction";
  action: string;
};

export type DispatchResult =
  | OclifDispatch
  | HelpDispatch
  | UsageErrorDispatch
  | LegacyDispatch
  | UnknownSubcommandDispatch
  | UnknownActionDispatch;

function hasHelpFlag(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

function hasMissingFlagValue(args: readonly string[], flagName: string): boolean {
  const index = args.indexOf(flagName);
  return index !== -1 && (!args[index + 1] || args[index + 1].startsWith("--"));
}

export function resolveGlobalOclifDispatch(cmd: string, args: string[]): DispatchResult {
  switch (cmd) {
    case "onboard":
    case "setup":
    case "setup-spark":
    case "deploy":
    case "start":
    case "stop":
    case "status":
    case "debug":
    case "uninstall":
    case "list":
    case "backup-all":
    case "upgrade-sandboxes":
    case "gc":
      return { kind: "oclif", commandId: cmd, args };
    case "tunnel": {
      const sub = args[0];
      if (sub === "start" || sub === "stop") {
        return { kind: "oclif", commandId: `tunnel:${sub}`, args: args.slice(1) };
      }
      return { kind: "usageError", lines: ["tunnel <start|stop>"] };
    }
    case "credentials": {
      const sub = args[0];
      if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
        return { kind: "oclif", commandId: "credentials", args: [] };
      }
      if (sub === "list") {
        return { kind: "oclif", commandId: "credentials:list", args: args.slice(1) };
      }
      if (sub === "reset") {
        return { kind: "oclif", commandId: "credentials:reset", args: args.slice(1) };
      }
      return { kind: "unknownSubcommand", command: "credentials", subcommand: sub };
    }
    case "--version":
    case "-v":
      return { kind: "oclif", commandId: "root:version", args: [] };
    default:
      return { kind: "usageError", lines: [] };
  }
}

export function resolveSandboxOclifDispatch(
  sandboxName: string,
  action: string,
  actionArgs: string[],
): DispatchResult {
  switch (action) {
    case "connect":
      if (hasHelpFlag(actionArgs)) return { kind: "help", usage: "connect" };
      return { kind: "oclif", commandId: "sandbox:connect", args: [sandboxName, ...actionArgs] };
    case "status":
      if (hasHelpFlag(actionArgs)) return { kind: "help", usage: "status" };
      return { kind: "oclif", commandId: "sandbox:status", args: [sandboxName, ...actionArgs] };
    case "logs":
      if (hasHelpFlag(actionArgs)) {
        return {
          kind: "help",
          usage: "logs [--follow] [--tail <lines>|-n <lines>] [--since <duration>]",
        };
      }
      return { kind: "oclif", commandId: "sandbox:logs", args: [sandboxName, ...actionArgs] };
    case "doctor":
      return { kind: "oclif", commandId: "sandbox:doctor", args: [sandboxName, ...actionArgs] };
    case "policy-add":
      if (hasHelpFlag(actionArgs)) {
        return {
          kind: "help",
          usage: "policy-add [preset] [--yes|-y] [--dry-run] [--from-file <path>] [--from-dir <path>]",
        };
      }
      if (hasMissingFlagValue(actionArgs, "--from-file") || hasMissingFlagValue(actionArgs, "--from-dir")) {
        return { kind: "legacy", target: "policy-add" };
      }
      return { kind: "oclif", commandId: "sandbox:policy-add", args: [sandboxName, ...actionArgs] };
    case "policy-remove":
      if (hasHelpFlag(actionArgs)) return { kind: "help", usage: "policy-remove [preset] [--yes|-y] [--dry-run]" };
      return { kind: "oclif", commandId: "sandbox:policy-remove", args: [sandboxName, ...actionArgs] };
    case "policy-list":
      if (hasHelpFlag(actionArgs)) return { kind: "help", usage: "policy-list" };
      return { kind: "oclif", commandId: "sandbox:policy-list", args: [sandboxName, ...actionArgs] };
    case "destroy":
      if (hasHelpFlag(actionArgs)) return { kind: "help", usage: "destroy [--yes|--force]" };
      return { kind: "oclif", commandId: "sandbox:destroy", args: [sandboxName, ...actionArgs] };
    case "gateway-token":
      if (hasHelpFlag(actionArgs)) return { kind: "help", usage: "gateway-token [--quiet|-q]" };
      return { kind: "oclif", commandId: "sandbox:gateway-token", args: [sandboxName, ...actionArgs] };
    case "skill": {
      const skillSub = actionArgs[0];
      const skillArgs = actionArgs.slice(1);
      if (!skillSub || skillSub === "help" || skillSub === "--help" || skillSub === "-h") {
        return { kind: "legacy", target: "skill" };
      }
      if (skillSub === "install") {
        if (hasHelpFlag(skillArgs)) return { kind: "legacy", target: "skill" };
        return { kind: "oclif", commandId: "sandbox:skill:install", args: [sandboxName, ...skillArgs] };
      }
      return { kind: "legacy", target: "skill" };
    }
    case "rebuild":
      if (hasHelpFlag(actionArgs)) return { kind: "help", usage: "rebuild [--yes|--force] [--verbose|-v]" };
      return { kind: "oclif", commandId: "sandbox:rebuild", args: [sandboxName, ...actionArgs] };
    case "recover":
      if (hasHelpFlag(actionArgs)) return { kind: "help", usage: "recover" };
      return { kind: "oclif", commandId: "sandbox:recover", args: [sandboxName, ...actionArgs] };
    case "share":
      return { kind: "oclif", commandId: "share", args: [sandboxName, ...actionArgs] };
    case "snapshot": {
      const snapshotSub = actionArgs[0];
      const snapshotArgs = actionArgs.slice(1);
      if (snapshotSub === "list") {
        if (hasHelpFlag(snapshotArgs)) return { kind: "help", usage: "snapshot list" };
        return { kind: "oclif", commandId: "sandbox:snapshot:list", args: [sandboxName, ...snapshotArgs] };
      }
      if (snapshotSub === "create") {
        if (hasHelpFlag(snapshotArgs)) return { kind: "help", usage: "snapshot create [--name <name>]" };
        return { kind: "oclif", commandId: "sandbox:snapshot:create", args: [sandboxName, ...snapshotArgs] };
      }
      if (snapshotSub === "restore") {
        if (hasHelpFlag(snapshotArgs)) return { kind: "help", usage: "snapshot restore [selector] [--to <dst>]" };
        return { kind: "oclif", commandId: "sandbox:snapshot:restore", args: [sandboxName, ...snapshotArgs] };
      }
      return { kind: "legacy", target: "snapshot" };
    }
    case "shields": {
      const shieldsSub = actionArgs[0];
      const shieldsArgs = actionArgs.slice(1);
      if (shieldsSub === "down") {
        if (hasHelpFlag(shieldsArgs)) return { kind: "help", usage: "shields down [--timeout 5m] [--reason 'text'] [--policy permissive]" };
        return { kind: "oclif", commandId: "sandbox:shields:down", args: [sandboxName, ...shieldsArgs] };
      }
      if (shieldsSub === "up") {
        if (hasHelpFlag(shieldsArgs)) return { kind: "help", usage: "shields up" };
        return { kind: "oclif", commandId: "sandbox:shields:up", args: [sandboxName, ...shieldsArgs] };
      }
      if (shieldsSub === "status") {
        if (hasHelpFlag(shieldsArgs)) return { kind: "help", usage: "shields status" };
        return { kind: "oclif", commandId: "sandbox:shields:status", args: [sandboxName, ...shieldsArgs] };
      }
      return {
        kind: "usageError",
        lines: ["shields <down|up|status>", "  down  [--timeout 5m] [--reason 'text'] [--policy permissive]", "  up    Restore policy from snapshot", "  status  Show current shields state"],
      };
    }
    case "channels": {
      const channelsSub = actionArgs[0];
      const channelsArgs = actionArgs.slice(1);
      if (channelsSub === "list") {
        if (hasHelpFlag(channelsArgs)) return { kind: "help", usage: "channels list" };
        return { kind: "oclif", commandId: "sandbox:channels:list", args: [sandboxName, ...channelsArgs] };
      }
      if (!channelsSub) return { kind: "oclif", commandId: "sandbox:channels:list", args: [sandboxName] };
      if (channelsSub === "--help" || channelsSub === "-h") return { kind: "help", usage: "channels list" };
      if (["add", "remove", "stop", "start"].includes(channelsSub)) {
        if (hasHelpFlag(channelsArgs)) return { kind: "help", usage: `channels ${channelsSub} <channel> [--dry-run]` };
        return { kind: "oclif", commandId: `sandbox:channels:${channelsSub}`, args: [sandboxName, ...channelsArgs] };
      }
      return { kind: "unknownSubcommand", command: "channels", subcommand: channelsSub };
    }
    case "config": {
      const configSub = actionArgs[0];
      if (configSub === "get") {
        if (hasHelpFlag(actionArgs.slice(1))) return { kind: "help", usage: "config get [--key dotpath] [--format json|yaml]" };
        return { kind: "oclif", commandId: "sandbox:config:get", args: [sandboxName, ...actionArgs.slice(1)] };
      }
      if (configSub === "--help" || configSub === "-h") return { kind: "help", usage: "config get [--key dotpath] [--format json|yaml]" };
      return { kind: "usageError", lines: ["config get [--key dotpath] [--format json|yaml]"] };
    }
    default:
      return { kind: "unknownAction", action };
  }
}
