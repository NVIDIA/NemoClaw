// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { sandboxCommands } from "./command-registry";

export type OclifDispatch = {
  kind: "oclif";
  commandId: string;
  args: string[];
};

export type HelpDispatch = {
  kind: "help";
  publicUsage: string;
  commandId: string;
};

export type UsageErrorDispatch = {
  kind: "usageError";
  lines: string[];
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
  | UnknownSubcommandDispatch
  | UnknownActionDispatch;

type LegacyRoute = {
  commandId: string;
  legacyTokens: string[];
  publicUsage: string;
};

function hasHelpFlag(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

function legacyTokensFromUsage(usage: string): string[] {
  const rest = usage.replace(/^nemoclaw\s+<name>\s*/, "");
  return rest
    .split(/\s+/)
    .filter((token) => token && !token.startsWith("[") && !token.startsWith("<"));
}

function publicUsageFromCommand(command: ReturnType<typeof sandboxCommands>[number]): string {
  const usage = command.usage.replace(/^nemoclaw\s+/, "");
  return command.flags ? `${usage} ${command.flags}` : usage;
}

function legacyRoutes(): LegacyRoute[] {
  return sandboxCommands()
    .map((command) => ({
      commandId: command.commandId,
      legacyTokens: legacyTokensFromUsage(command.usage),
      publicUsage: publicUsageFromCommand(command),
    }))
    .filter((route) => route.legacyTokens.length > 0)
    .sort((a, b) => b.legacyTokens.length - a.legacyTokens.length);
}

function startsWithTokens(tokens: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((token, index) => tokens[index] === token);
}

function routeToOclif(route: LegacyRoute, sandboxName: string, args: string[]): DispatchResult {
  if (hasHelpFlag(args)) {
    return { kind: "help", commandId: route.commandId, publicUsage: route.publicUsage };
  }
  return {
    kind: "oclif",
    commandId: route.commandId,
    args: [sandboxName, ...args],
  };
}

function oclif(commandId: string, args: string[]): OclifDispatch {
  return { kind: "oclif", commandId, args };
}

const GLOBAL_ROUTES: Readonly<Record<string, string>> = {
  onboard: "onboard",
  setup: "setup",
  "setup-spark": "setup-spark",
  deploy: "deploy",
  start: "start",
  stop: "stop",
  status: "status",
  debug: "debug",
  uninstall: "uninstall",
  update: "update",
  list: "list",
  "backup-all": "backup-all",
  "upgrade-sandboxes": "upgrade-sandboxes",
  gc: "gc",
};

export function resolveGlobalOclifDispatch(cmd: string, args: string[]): DispatchResult {
  const globalCommandId = GLOBAL_ROUTES[cmd];
  if (globalCommandId) return oclif(globalCommandId, args);

  if (cmd === "tunnel") {
    const sub = args[0];
    if (sub === "start" || sub === "stop") return oclif(`tunnel:${sub}`, args.slice(1));
    return { kind: "usageError", lines: ["tunnel <start|stop>"] };
  }

  if (cmd === "inference") {
    const sub = args[0];
    if (sub === "get") return oclif("inference:get", args.slice(1));
    if (sub === "set") return oclif("inference:set", args.slice(1));
    return {
      kind: "usageError",
      lines: [
        "inference get [--json]",
        "inference set --provider <provider> --model <model> [--sandbox <name>] [--no-verify]",
      ],
    };
  }

  if (cmd === "credentials") {
    const sub = args[0];
    if (!sub || sub === "help" || sub === "--help" || sub === "-h") return oclif("credentials", []);
    if (sub === "list" || sub === "reset") return oclif(`credentials:${sub}`, args.slice(1));
    return { kind: "unknownSubcommand", command: "credentials", subcommand: sub };
  }

  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    return oclif("root:version", []);
  }

  return { kind: "usageError", lines: [] };
}

const CHANNEL_SUBCOMMANDS = new Set(["add", "list", "remove", "start", "stop"]);

const PARENT_ACTIONS = new Set(["share", "skill", "snapshot"]);

const CONFIG_USAGE = ["config get [--key dotpath] [--format json|yaml]"];
const SHIELDS_USAGE = [
  "shields <down|up|status>",
  "  down  [--timeout 5m] [--reason 'text'] [--policy permissive]",
  "  up    Restore policy from snapshot",
  "  status  Show current shields state",
];

export function resolveLegacySandboxDispatch(
  sandboxName: string,
  action: string,
  actionArgs: string[],
): DispatchResult {
  if (action === "connect") {
    return { kind: "oclif", commandId: "sandbox:connect", args: [sandboxName, ...actionArgs] };
  }

  if (action === "channels" && actionArgs.length === 0) {
    return { kind: "oclif", commandId: "sandbox:channels:list", args: [sandboxName] };
  }

  if (action === "skill" && actionArgs[0] === "install" && hasHelpFlag(actionArgs.slice(1))) {
    return { kind: "oclif", commandId: "sandbox:skill", args: [sandboxName, ...actionArgs] };
  }

  const inputTokens = [action, ...actionArgs];
  for (const route of legacyRoutes()) {
    if (!startsWithTokens(inputTokens, route.legacyTokens)) continue;
    const remainingArgs = inputTokens.slice(route.legacyTokens.length);
    return routeToOclif(route, sandboxName, remainingArgs);
  }

  if (action === "channels") {
    const subcommand = actionArgs[0] ?? "";
    if (!CHANNEL_SUBCOMMANDS.has(subcommand)) {
      return { kind: "unknownSubcommand", command: "channels", subcommand };
    }
  }

  if (action === "config") {
    return { kind: "usageError", lines: CONFIG_USAGE };
  }

  if (action === "shields") {
    return { kind: "usageError", lines: SHIELDS_USAGE };
  }

  if (action === "share" && hasHelpFlag(actionArgs)) {
    return { kind: "help", commandId: "sandbox:share", publicUsage: "<name> share <mount|unmount|status>" };
  }

  if (PARENT_ACTIONS.has(action)) {
    return {
      kind: "oclif",
      commandId: `sandbox:${action}`,
      args: [sandboxName, ...(hasHelpFlag(actionArgs) ? [] : actionArgs)],
    };
  }

  return { kind: "unknownAction", action };
}

export const resolveSandboxOclifDispatch = resolveLegacySandboxDispatch;
