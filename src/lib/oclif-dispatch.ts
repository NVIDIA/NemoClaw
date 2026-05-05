// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type OclifDispatch = {
  kind: "oclif";
  commandId: string;
  args: string[];
};

export type HelpDispatch = {
  kind: "help";
  usage: string;
  commandId?: string;
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

type FlatSandboxRoute = {
  commandId: string;
  helpUsage?: string;
};

type NestedSandboxRoute = {
  parentCommandId: string;
  helpUsage?: string;
  subcommands: Record<string, FlatSandboxRoute>;
  defaultSubcommand?: string;
  unknown?: "oclif-parent" | "channels-unknown" | "usage";
  usageLines?: string[];
};

function hasHelpFlag(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
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
  list: "list",
  "backup-all": "backup-all",
  "upgrade-sandboxes": "upgrade-sandboxes",
  gc: "gc",
};

const FLAT_SANDBOX_ROUTES: Readonly<Record<string, FlatSandboxRoute>> = {
  connect: { commandId: "sandbox:connect", helpUsage: "connect" },
  status: { commandId: "sandbox:status", helpUsage: "status" },
  logs: {
    commandId: "sandbox:logs",
    helpUsage: "logs [--follow] [--tail <lines>|-n <lines>] [--since <duration>]",
  },
  doctor: { commandId: "sandbox:doctor", helpUsage: "doctor [--json]" },
  "policy-add": {
    commandId: "sandbox:policy:add",
    helpUsage:
      "policy-add [preset] [--yes|-y] [--dry-run] [--from-file <path>] [--from-dir <path>]",
  },
  "policy-remove": {
    commandId: "sandbox:policy:remove",
    helpUsage: "policy-remove [preset] [--yes|-y] [--dry-run]",
  },
  "policy-list": { commandId: "sandbox:policy:list", helpUsage: "policy-list" },
  destroy: { commandId: "sandbox:destroy", helpUsage: "destroy [--yes|-y|--force]" },
  "gateway-token": {
    commandId: "sandbox:gateway:token",
    helpUsage: "gateway-token [--quiet|-q]",
  },
  rebuild: {
    commandId: "sandbox:rebuild",
    helpUsage: "rebuild [--yes|-y|--force] [--verbose|-v]",
  },
  recover: { commandId: "sandbox:recover", helpUsage: "recover" },
};

const NESTED_SANDBOX_ROUTES: Readonly<Record<string, NestedSandboxRoute>> = {
  skill: {
    parentCommandId: "sandbox:skill",
    subcommands: {
      install: { commandId: "sandbox:skill:install" },
    },
    unknown: "oclif-parent",
  },
  share: {
    parentCommandId: "sandbox:share",
    helpUsage: "share <mount|unmount|status>",
    subcommands: {
      mount: {
        commandId: "sandbox:share:mount",
        helpUsage: "share mount [sandbox-path] [local-mount-point]",
      },
      unmount: {
        commandId: "sandbox:share:unmount",
        helpUsage: "share unmount [local-mount-point]",
      },
      status: {
        commandId: "sandbox:share:status",
        helpUsage: "share status [local-mount-point]",
      },
    },
    unknown: "oclif-parent",
  },
  snapshot: {
    parentCommandId: "sandbox:snapshot",
    subcommands: {
      list: { commandId: "sandbox:snapshot:list", helpUsage: "snapshot list" },
      create: {
        commandId: "sandbox:snapshot:create",
        helpUsage: "snapshot create [--name <name>]",
      },
      restore: {
        commandId: "sandbox:snapshot:restore",
        helpUsage: "snapshot restore [selector] [--to <dst>]",
      },
    },
    unknown: "oclif-parent",
  },
  shields: {
    parentCommandId: "sandbox:shields",
    subcommands: {
      down: {
        commandId: "sandbox:shields:down",
        helpUsage: "shields down [--timeout 5m] [--reason 'text'] [--policy permissive]",
      },
      up: { commandId: "sandbox:shields:up", helpUsage: "shields up" },
      status: { commandId: "sandbox:shields:status", helpUsage: "shields status" },
    },
    unknown: "usage",
    usageLines: [
      "shields <down|up|status>",
      "  down  [--timeout 5m] [--reason 'text'] [--policy permissive]",
      "  up    Restore policy from snapshot",
      "  status  Show current shields state",
    ],
  },
  channels: {
    parentCommandId: "sandbox:channels:list",
    defaultSubcommand: "list",
    subcommands: {
      list: { commandId: "sandbox:channels:list", helpUsage: "channels list" },
      add: { commandId: "sandbox:channels:add", helpUsage: "channels add <channel> [--dry-run]" },
      remove: {
        commandId: "sandbox:channels:remove",
        helpUsage: "channels remove <channel> [--dry-run]",
      },
      stop: { commandId: "sandbox:channels:stop", helpUsage: "channels stop <channel> [--dry-run]" },
      start: {
        commandId: "sandbox:channels:start",
        helpUsage: "channels start <channel> [--dry-run]",
      },
    },
    unknown: "channels-unknown",
  },
  config: {
    parentCommandId: "sandbox:config:get",
    subcommands: {
      get: {
        commandId: "sandbox:config:get",
        helpUsage: "config get [--key dotpath] [--format json|yaml]",
      },
      set: {
        commandId: "sandbox:config:set",
        helpUsage: "config set --key <dotpath> --value <value> [--restart] [--config-accept-new-path]",
      },
    },
    unknown: "usage",
    usageLines: [
      "config <get|set>",
      "get [--key dotpath] [--format json|yaml]",
      "set --key <dotpath> --value <value> [--restart] [--config-accept-new-path]",
    ],
  },
};

export function resolveGlobalOclifDispatch(cmd: string, args: string[]): DispatchResult {
  const globalCommandId = GLOBAL_ROUTES[cmd];
  if (globalCommandId) {
    return oclif(globalCommandId, args);
  }

  if (cmd === "tunnel") {
    const sub = args[0];
    if (sub === "start" || sub === "stop") {
      return oclif(`tunnel:${sub}`, args.slice(1));
    }
    return { kind: "usageError", lines: ["tunnel <start|stop>"] };
  }

  if (cmd === "credentials") {
    const sub = args[0];
    if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
      return oclif("credentials", []);
    }
    if (sub === "list" || sub === "reset") {
      return oclif(`credentials:${sub}`, args.slice(1));
    }
    return { kind: "unknownSubcommand", command: "credentials", subcommand: sub };
  }

  if (cmd === "--version" || cmd === "-v") {
    return oclif("root:version", []);
  }

  return { kind: "usageError", lines: [] };
}

function resolveFlatSandboxRoute(
  sandboxName: string,
  route: FlatSandboxRoute,
  actionArgs: string[],
): DispatchResult {
  if (route.helpUsage && hasHelpFlag(actionArgs)) {
    return { kind: "help", usage: route.helpUsage, commandId: route.commandId };
  }
  return oclif(route.commandId, [sandboxName, ...actionArgs]);
}

function resolveNestedSandboxRoute(
  sandboxName: string,
  route: NestedSandboxRoute,
  actionArgs: string[],
): DispatchResult {
  const subcommand = actionArgs[0] || route.defaultSubcommand;
  const subArgs = actionArgs.slice(actionArgs[0] ? 1 : 0);

  if (route.parentCommandId === "sandbox:skill") {
    if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
      return oclif(route.parentCommandId, [sandboxName, ...actionArgs]);
    }
    if (subcommand === "install" && hasHelpFlag(subArgs)) {
      return oclif(route.parentCommandId, [sandboxName, ...actionArgs]);
    }
  }

  if (!subcommand) {
    return oclif(route.parentCommandId, [sandboxName]);
  }

  if (subcommand === "--help" || subcommand === "-h") {
    if (route.helpUsage) {
      return { kind: "help", usage: route.helpUsage };
    }
    return oclif(route.parentCommandId, [sandboxName]);
  }

  const subRoute = route.subcommands[subcommand];
  if (subRoute) {
    if (subRoute.helpUsage && hasHelpFlag(subArgs)) {
      return { kind: "help", usage: subRoute.helpUsage, commandId: subRoute.commandId };
    }
    return oclif(subRoute.commandId, [sandboxName, ...subArgs]);
  }

  if (route.unknown === "channels-unknown") {
    return { kind: "unknownSubcommand", command: "channels", subcommand };
  }
  if (route.unknown === "usage") {
    return { kind: "usageError", lines: route.usageLines ?? [] };
  }
  return oclif(route.parentCommandId, [sandboxName, ...actionArgs]);
}

export function resolveSandboxOclifDispatch(
  sandboxName: string,
  action: string,
  actionArgs: string[],
): DispatchResult {
  const flatRoute = FLAT_SANDBOX_ROUTES[action];
  if (flatRoute) {
    return resolveFlatSandboxRoute(sandboxName, flatRoute, actionArgs);
  }

  const nestedRoute = NESTED_SANDBOX_ROUTES[action];
  if (nestedRoute) {
    return resolveNestedSandboxRoute(sandboxName, nestedRoute, actionArgs);
  }

  return { kind: "unknownAction", action };
}
