// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type OclifCommandMetadata = {
  args?: Record<string, unknown>;
  baseFlags?: Record<string, unknown>;
  description?: string;
  examples?: string[];
  flags?: Record<string, unknown>;
  id?: string;
  strict?: boolean;
  summary?: string;
  usage?: string[];
};

function loadOclifCommands(): Record<string, OclifCommandMetadata> | null {
  for (const modulePath of [
    "../commands",
    "../commands/index.js",
    "../../../dist/lib/commands/index.js",
  ]) {
    try {
      const registry = require(modulePath) as {
        default?: Record<string, OclifCommandMetadata>;
      };
      if (registry.default) {
        return registry.default;
      }
    } catch {
      /* try the next runtime shape */
    }
  }
  return null;
}

export function getRegisteredOclifCommandMetadata(
  commandId: string,
): OclifCommandMetadata | null {
  return loadOclifCommands()?.[commandId] ?? null;
}

export function getRegisteredOclifCommandSummary(commandId: string): string | null {
  return getRegisteredOclifCommandMetadata(commandId)?.summary ?? null;
}
