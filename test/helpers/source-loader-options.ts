// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

export const SOURCE_REQUIRE_HOOK = path.join(import.meta.dirname, "onboard-script-mocks.cjs");

function splitRawNodeOptions(nodeOptions: string): string[] | null {
  const tokens: string[] = [];
  let index = 0;
  while (index < nodeOptions.length) {
    while (index < nodeOptions.length && /\s/.test(nodeOptions[index] ?? "")) index += 1;
    if (index >= nodeOptions.length) break;

    const start = index;
    let quote: "'" | '"' | null = null;
    let escaped = false;
    while (index < nodeOptions.length) {
      const char = nodeOptions[index] ?? "";
      if (escaped) {
        escaped = false;
        index += 1;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        index += 1;
        continue;
      }
      if (quote) {
        if (char === quote) quote = null;
        index += 1;
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char;
        index += 1;
        continue;
      }
      if (/\s/.test(char)) break;
      index += 1;
    }
    if (quote || escaped) return null;
    tokens.push(nodeOptions.slice(start, index));
  }
  return tokens;
}

function decodeNodeOptionToken(token: string): string {
  const first = token[0];
  if (token.length < 2 || (first !== "'" && first !== '"') || token.at(-1) !== first) {
    return token;
  }
  if (first === '"') {
    try {
      return JSON.parse(token) as string;
    } catch {
      // Node also accepts quoted paths whose backslashes are not JSON escapes.
    }
  }
  return token.slice(1, -1);
}

function isRequireFlag(token: string): boolean {
  return token === "--require" || token === "-r";
}

function requireAssignmentValue(token: string): string | null {
  const decoded = decodeNodeOptionToken(token);
  for (const prefix of ["--require=", "-r="]) {
    if (decoded.startsWith(prefix)) {
      return decodeNodeOptionToken(decoded.slice(prefix.length));
    }
  }
  return null;
}

export function sourceLoaderNodeOptions(
  nodeOptions: string | undefined,
  sourceHook = SOURCE_REQUIRE_HOOK,
): string {
  const sourceRequireOption = `--require=${JSON.stringify(sourceHook)}`;
  return [nodeOptions, sourceRequireOption].filter(Boolean).join(" ");
}

export function nodeOptionsWithoutSourceLoader(
  nodeOptions: string | undefined,
  sourceHook = SOURCE_REQUIRE_HOOK,
): string {
  if (!nodeOptions) return "";
  const tokens = splitRawNodeOptions(nodeOptions);
  // Preserve malformed external input as one opaque value. Partially rewriting
  // it could corrupt unrelated flags; Node remains responsible for rejecting it.
  if (!tokens) return nodeOptions;
  const retained: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const decoded = decodeNodeOptionToken(token);
    const nextToken = tokens[index + 1];
    if (
      isRequireFlag(decoded) &&
      nextToken !== undefined &&
      decodeNodeOptionToken(nextToken) === sourceHook
    ) {
      index += 1;
      continue;
    }
    if (requireAssignmentValue(token) === sourceHook) continue;
    retained.push(token);
  }

  return retained.length === tokens.length ? nodeOptions : retained.join(" ");
}
