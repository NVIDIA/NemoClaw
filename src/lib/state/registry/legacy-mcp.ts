// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import { readConfigFile, writeConfigFile } from "../config-io";
import { withLock } from "./lock";
import { REGISTRY_FILE } from "./persistence";

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read deprecated ownership evidence without admitting it to runtime registry state. */
export function readLegacyMcpRegistryProjection(
  sandboxName: string,
): Record<string, unknown> | undefined {
  const document = readConfigFile<unknown>(REGISTRY_FILE, {});
  if (!isObjectRecord(document) || !isObjectRecord(document.sandboxes)) return undefined;
  const sandbox = document.sandboxes[sandboxName];
  return isObjectRecord(sandbox) && isObjectRecord(sandbox.mcp) ? sandbox.mcp : undefined;
}

/** Retire exactly the ownership snapshot whose migration completed successfully. */
export function retireLegacyMcpRegistryProjection(
  sandboxName: string,
  expectedProjection: Record<string, unknown> | undefined,
): void {
  withLock(() => {
    const document = readConfigFile<unknown>(REGISTRY_FILE, {});
    const sandbox =
      isObjectRecord(document) && isObjectRecord(document.sandboxes)
        ? document.sandboxes[sandboxName]
        : undefined;
    const current = isObjectRecord(sandbox) ? sandbox.mcp : undefined;
    if (!isDeepStrictEqual(current, expectedProjection)) {
      throw new Error("Legacy MCP ownership changed during migration; registry was preserved.");
    }
    if (
      current === undefined ||
      !isObjectRecord(document) ||
      !isObjectRecord(document.sandboxes) ||
      !isObjectRecord(sandbox)
    )
      return;
    const nextSandbox = { ...sandbox };
    delete nextSandbox.mcp;
    writeConfigFile(REGISTRY_FILE, {
      ...document,
      sandboxes: { ...document.sandboxes, [sandboxName]: nextSandbox },
    });
  });
}

/** Retire only the removed entry's unchanged ownership proof, preserving survivors. */
export function removeLegacyMcpRegistryEntry(
  sandboxName: string,
  server: string,
  expectedProjection: Record<string, unknown>,
): void {
  withLock(() => {
    const document = readConfigFile<unknown>(REGISTRY_FILE, {});
    if (!isObjectRecord(document) || !isObjectRecord(document.sandboxes)) {
      throw new Error("Legacy MCP ownership changed during removal; registry was preserved.");
    }
    const sandbox = document.sandboxes[sandboxName];
    if (
      !isObjectRecord(sandbox) ||
      !isObjectRecord(sandbox.mcp) ||
      !isDeepStrictEqual(sandbox.mcp, expectedProjection) ||
      !isObjectRecord(sandbox.mcp.bridges) ||
      !Object.hasOwn(sandbox.mcp.bridges, server)
    ) {
      throw new Error("Legacy MCP ownership changed during removal; registry was preserved.");
    }
    const bridges = { ...sandbox.mcp.bridges };
    delete bridges[server];
    const nextSandbox = { ...sandbox };
    if (Object.keys(bridges).length > 0) {
      nextSandbox.mcp = { ...sandbox.mcp, bridges };
    } else {
      delete nextSandbox.mcp;
    }
    writeConfigFile(REGISTRY_FILE, {
      ...document,
      sandboxes: { ...document.sandboxes, [sandboxName]: nextSandbox },
    });
  });
}
