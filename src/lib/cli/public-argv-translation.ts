// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getRegisteredOclifCommandMetadata, getRegisteredOclifCommandsMetadata } from "./oclif-metadata";
import { globalRouteTokenVariants, sandboxRouteTokens } from "./public-route-metadata";

export type NativeArgvTranslation = {
  kind: "nativeArgv";
  commandId: string;
  args: string[];
  argv: string[];
};

export type PublicUsageErrorTranslation = {
  kind: "publicUsageError";
  lines: string[];
};

export type UnknownPublicActionTranslation = {
  kind: "unknownPublicAction";
  action: string;
};

export type PublicTranslationResult =
  | NativeArgvTranslation
  | PublicUsageErrorTranslation
  | UnknownPublicActionTranslation;

type SandboxRoute = {
  commandId: string;
  publicTokens: string[];
};

type GlobalRoute = {
  commandId: string;
  tokens: string[];
};

function registeredCommandIds(): Set<string> {
  return new Set(Object.keys(getRegisteredOclifCommandsMetadata()));
}

function hasChildCommand(commandId: string, commandIds: ReadonlySet<string>): boolean {
  return [...commandIds].some((id) => id.startsWith(`${commandId}:`));
}

function sandboxRoutes(): SandboxRoute[] {
  const commandIds = registeredCommandIds();
  return [...commandIds]
    .filter((commandId) => commandId.startsWith("sandbox:"))
    .filter((commandId) => !hasChildCommand(commandId, commandIds))
    .map((commandId) => ({
      commandId,
      publicTokens: sandboxRouteTokens(commandId) ?? [],
    }))
    .filter((route) => route.publicTokens.length > 0)
    .sort((a, b) => b.publicTokens.length - a.publicTokens.length);
}

function globalRoutes(): GlobalRoute[] {
  const commandIds = registeredCommandIds();
  return [...commandIds]
    .filter((commandId) => !commandId.startsWith("sandbox:"))
    .filter((commandId) => !commandId.startsWith("internal:"))
    .filter((commandId) => !hasChildCommand(commandId, commandIds))
    .flatMap((commandId) =>
      globalRouteTokenVariants(commandId).map((tokens) => ({
        commandId,
        tokens,
      })),
    )
    .filter((route) => route.tokens.length > 0)
    .sort((a, b) => b.tokens.length - a.tokens.length);
}

function startsWithTokens(tokens: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((token, index) => tokens[index] === token);
}

function nativeArgv(commandId: string, args: string[], argv?: string[]): NativeArgvTranslation {
  return { kind: "nativeArgv", commandId, args, argv: argv ?? [...commandId.split(":"), ...args] };
}

function parentSubcommands(action: string): Set<string> {
  return new Set(
    sandboxRoutes()
      .filter((route) => route.publicTokens[0] === action)
      .map((route) => route.publicTokens[1])
      .filter((token): token is string => Boolean(token)),
  );
}

function hasRegisteredOclifParentCommand(action: string): boolean {
  return getRegisteredOclifCommandMetadata(`sandbox:${action}`) !== null;
}

function isNonStrictRegisteredParent(action: string): boolean {
  return getRegisteredOclifCommandMetadata(`sandbox:${action}`)?.strict === false;
}

function isHelpToken(token: string | undefined): boolean {
  return token === "help" || token === "--help" || token === "-h";
}

function nativeGlobalParentArgv(cmd: string, args: string[]): NativeArgvTranslation {
  const subcommand = args[0];
  if (!subcommand || isHelpToken(subcommand)) {
    return nativeArgv(cmd, ["--help"], [cmd, "--help"]);
  }
  return nativeArgv(`${cmd}:${subcommand}`, args.slice(1), [cmd, ...args]);
}

function nativeSandboxParentArgv(
  sandboxName: string,
  action: string,
  actionArgs: string[],
): NativeArgvTranslation {
  const subcommand = actionArgs[0];
  if (!subcommand || isHelpToken(subcommand)) {
    return nativeArgv(`sandbox:${action}`, ["--help"], ["sandbox", action, "--help"]);
  }
  if (subcommand.startsWith("-")) {
    if (isNonStrictRegisteredParent(action)) {
      return nativeArgv(`sandbox:${action}`, [sandboxName, ...actionArgs]);
    }
    return nativeArgv(`sandbox:${action}`, ["--help"], ["sandbox", action, "--help"]);
  }
  return nativeArgv(`sandbox:${action}:${subcommand}`, [sandboxName, ...actionArgs.slice(1)], [
    "sandbox",
    action,
    subcommand,
    sandboxName,
    ...actionArgs.slice(1),
  ]);
}

export function translatePublicGlobalArgv(cmd: string, args: string[]): PublicTranslationResult {
  const inputTokens = [cmd, ...args];
  for (const route of globalRoutes()) {
    if (!startsWithTokens(inputTokens, route.tokens)) continue;
    return nativeArgv(route.commandId, inputTokens.slice(route.tokens.length));
  }

  if (cmd === "tunnel" || cmd === "inference" || cmd === "credentials") {
    return nativeGlobalParentArgv(cmd, args);
  }

  return { kind: "publicUsageError", lines: [] };
}

export function translatePublicSandboxArgv(
  sandboxName: string,
  action: string,
  actionArgs: string[],
): PublicTranslationResult {
  if (action === "connect") {
    return nativeArgv("sandbox:connect", [sandboxName, ...actionArgs]);
  }

  if (action === "channels" && actionArgs.length === 0) {
    return nativeArgv("sandbox:channels:list", [sandboxName]);
  }

  const inputTokens = [action, ...actionArgs];
  for (const route of sandboxRoutes()) {
    if (!startsWithTokens(inputTokens, route.publicTokens)) continue;
    const remainingArgs = inputTokens.slice(route.publicTokens.length);
    return nativeArgv(route.commandId, [sandboxName, ...remainingArgs]);
  }

  if (parentSubcommands(action).size > 0 && (actionArgs.length === 0 || !parentSubcommands(action).has(actionArgs[0]))) {
    if (actionArgs.length === 0 && isNonStrictRegisteredParent(action)) {
      return nativeArgv(`sandbox:${action}`, [sandboxName]);
    }
    return nativeSandboxParentArgv(sandboxName, action, actionArgs);
  }

  if (hasRegisteredOclifParentCommand(action)) {
    return nativeArgv(`sandbox:${action}`, [sandboxName, ...actionArgs]);
  }

  return { kind: "unknownPublicAction", action };
}
