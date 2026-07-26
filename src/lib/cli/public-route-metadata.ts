// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Machine-readable public sandbox-first routes.
 *
 * Keep these helpers deliberately small: they describe how NemoClaw's public
 * sandbox-first grammar maps onto oclif command IDs. Display copy lives in
 * `publicDisplay`; routing must not depend on usage/help strings.
 */

const GLOBAL_ROUTE_ALIASES: Record<string, readonly (readonly string[])[]> = {
  "root:help": [["help"], ["--help"], ["-h"]],
  "root:version": [["version"], ["--version"], ["-v"]],
};

// These are public-grammar spellings, not oclif aliases. A
// hidden oclif alias can model native topic syntax like
// `nemoclaw sandbox policy-add <name>`, but not NemoClaw's product grammar
// `nemoclaw <name> policy-add` where the sandbox name precedes the action.
// Keep this set small and limited to public spellings that cannot be derived
// mechanically from oclif command IDs.
export const SANDBOX_ROUTE_OVERRIDES: Record<string, readonly string[]> = {
  "sandbox:gateway:token": ["gateway-token"],
  "sandbox:hosts:add": ["hosts-add"],
  "sandbox:hosts:list": ["hosts-list"],
  "sandbox:hosts:remove": ["hosts-remove"],
};

// Legacy public spellings still accepted at parse time but no longer canonical.
// The `policy` group canonicalized to the two-token `policy <verb>` grammar;
// the original hyphenated forms keep working so existing scripts and docs do
// not break, but help, completion, and display advertise only the canonical
// two-token form.
export const SANDBOX_LEGACY_ROUTE_ALIASES: Record<string, readonly (readonly string[])[]> = {
  "sandbox:policy:add": [["policy-add"]],
  "sandbox:policy:explain": [["policy-explain"]],
  "sandbox:policy:get": [["policy-get"]],
  "sandbox:policy:list": [["policy-list"]],
  "sandbox:policy:remove": [["policy-remove"]],
};

function commandIdTokens(commandId: string): string[] {
  return commandId.split(":").filter(Boolean);
}

export function globalRouteTokenVariants(commandId: string): string[][] {
  const aliases = GLOBAL_ROUTE_ALIASES[commandId];
  if (aliases) return aliases.map((tokens) => [...tokens]);
  if (
    commandId.startsWith("sandbox:") ||
    commandId.startsWith("internal:") ||
    commandId.startsWith("root:")
  ) {
    return [];
  }
  return [commandIdTokens(commandId)];
}

export function sandboxRouteTokens(commandId: string): string[] | null {
  if (!commandId.startsWith("sandbox:")) return null;
  const override = SANDBOX_ROUTE_OVERRIDES[commandId];
  if (override) return [...override];
  const tokens = commandIdTokens(commandId.slice("sandbox:".length));
  return tokens.length > 0 ? tokens : null;
}

/**
 * Every accepted public route for a sandbox command: the canonical route first,
 * then any legacy spellings still parsed for backward compatibility. Argv
 * translation matches all variants; display and completion use only the
 * canonical route from `sandboxRouteTokens`.
 */
export function sandboxRouteTokenVariants(commandId: string): string[][] {
  const canonical = sandboxRouteTokens(commandId);
  if (!canonical) return [];
  const legacy = SANDBOX_LEGACY_ROUTE_ALIASES[commandId] ?? [];
  return [canonical, ...legacy.map((tokens) => [...tokens])];
}
