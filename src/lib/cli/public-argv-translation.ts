// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  getRegisteredOclifCommandMetadata,
  getRegisteredOclifCommandsMetadata,
} from "./oclif-metadata";
import { globalRouteTokenVariants, sandboxRouteTokenVariants } from "./public-route-metadata";

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
    .flatMap((commandId) =>
      sandboxRouteTokenVariants(commandId).map((publicTokens) => ({ commandId, publicTokens })),
    )
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

function matchRegisteredSandboxRoute(tokens: readonly string[]): SandboxRoute | null {
  return sandboxRoutes().find((route) => startsWithTokens(tokens, route.publicTokens)) ?? null;
}

/**
 * Return the longest registered sandbox route that prefixes the public input.
 *
 * Diagnostics use these registered tokens so untrusted action arguments never
 * reach terminal or log output (#10212).
 */
export function matchSandboxRoute(tokens: readonly string[]): string[] | null {
  return matchRegisteredSandboxRoute(tokens)?.publicTokens ?? null;
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

/**
 * Dispatch help only to a registered parent; otherwise return registered action names.
 * Untrusted action arguments must not appear in usage diagnostics.
 */
function nativeGlobalParentArgv(
  cmd: string,
  args: string[],
  subcommands: string[],
): PublicTranslationResult {
  const subcommand = args[0];
  if ((!subcommand || isHelpToken(subcommand)) && getRegisteredOclifCommandMetadata(cmd) !== null) {
    return nativeArgv(cmd, ["--help"], [cmd, "--help"]);
  }
  return {
    kind: "publicUsageError",
    lines: [`${cmd} <subcommand>`, "Subcommands:", ...subcommands],
  };
}

/** Preserve sandbox parent passthrough and help semantics independently of global usage errors. */
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
  return nativeArgv(
    `sandbox:${action}:${subcommand}`,
    [sandboxName, ...actionArgs.slice(1)],
    ["sandbox", action, subcommand, sandboxName, ...actionArgs.slice(1)],
  );
}

/** Derive dispatch and parent usage from the same registered public routes. */
export function translatePublicGlobalArgv(cmd: string, args: string[]): PublicTranslationResult {
  const inputTokens = [cmd, ...args];
  const subcommands: string[] = [];
  for (const route of globalRoutes()) {
    if (startsWithTokens(inputTokens, route.tokens)) {
      return nativeArgv(route.commandId, inputTokens.slice(route.tokens.length));
    }
    if (route.tokens[0] === cmd && route.tokens.length > 1) {
      subcommands.push(route.tokens.slice(1).join(" "));
    }
  }

  if (subcommands.length > 0) {
    return nativeGlobalParentArgv(cmd, args, subcommands);
  }

  return { kind: "publicUsageError", lines: [] };
}

/** Resolve sandbox aliases and registered routes while retaining the sandbox name in native arguments. */
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
  const route = matchRegisteredSandboxRoute(inputTokens);
  if (route) {
    const remainingArgs = inputTokens.slice(route.publicTokens.length);
    return nativeArgv(route.commandId, [sandboxName, ...remainingArgs]);
  }

  if (
    parentSubcommands(action).size > 0 &&
    (actionArgs.length === 0 || !parentSubcommands(action).has(actionArgs[0]))
  ) {
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
