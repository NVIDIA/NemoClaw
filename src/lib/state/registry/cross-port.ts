// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import {
  DEFAULT_GATEWAY_PORT,
  listGatewayStateRoots,
  readGatewayRegistryFile,
  registryEntryGatewayPort,
  resolveHome,
  type GatewayRegistryEntry,
} from "../gateway-registry";
import type { SandboxEntry } from "./types";

export interface CrossPortSandboxHit {
  entry: SandboxEntry;
  /** Recorded or directory-derived owning gateway port; null when unrecorded on the base root. */
  gatewayPort: number | null;
  registryFile: string;
}

function crossPortStateError(message: string): Error {
  return new Error(`Cannot safely inspect NemoClaw gateway state: ${message}`);
}

function normalizeEntryForRoot(
  entry: GatewayRegistryEntry,
  stateGatewayPort: number,
): GatewayRegistryEntry {
  if (
    stateGatewayPort !== DEFAULT_GATEWAY_PORT &&
    (entry.gatewayPort === undefined || entry.gatewayPort === null) &&
    (entry.gatewayName === undefined || entry.gatewayName === null)
  ) {
    return { ...entry, gatewayPort: stateGatewayPort };
  }
  return entry;
}

function listSandboxHitsAcrossGatewayRoots(home: string): CrossPortSandboxHit[] {
  const hits: CrossPortSandboxHit[] = [];
  for (const state of listGatewayStateRoots(home)) {
    const registryFile = path.join(state.root, "sandboxes.json");
    const registry = readGatewayRegistryFile(home, registryFile);
    if (!registry) continue;

    for (const rawEntry of Object.values(registry.sandboxes)) {
      const entry = normalizeEntryForRoot(rawEntry, state.gatewayPort);
      const gatewayPort = registryEntryGatewayPort(entry);
      if (state.gatewayPort !== DEFAULT_GATEWAY_PORT && gatewayPort !== state.gatewayPort) {
        throw crossPortStateError(
          `${registryFile} contains sandbox ${JSON.stringify(entry.name)} for gateway port ${String(gatewayPort)}`,
        );
      }
      const hasRecordedGatewayIdentity =
        (entry.gatewayPort !== undefined && entry.gatewayPort !== null) ||
        (entry.gatewayName !== undefined && entry.gatewayName !== null);
      hits.push({
        entry: entry as SandboxEntry,
        gatewayPort:
          state.gatewayPort === DEFAULT_GATEWAY_PORT && !hasRecordedGatewayIdentity
            ? null
            : gatewayPort,
        registryFile,
      });
    }
  }
  return hits;
}

/**
 * Locate a sandbox across every NemoClaw registry root on this host: the
 * default-port registry plus one root per non-default gateway port. The port
 * encoded by the owning directory stamps entries that predate the recorded
 * `gatewayPort` field, matching the per-port authority rule used when entries
 * were written. Returns null when the name is absent everywhere.
 */
export function findSandboxAcrossGatewayRoots(
  sandboxName: string,
  home: string = resolveHome(),
): CrossPortSandboxHit | null {
  const matches = listSandboxHitsAcrossGatewayRoots(home).filter(
    ({ entry }) => entry.name === sandboxName,
  );
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw crossPortStateError(
      `sandbox ${JSON.stringify(sandboxName)} appears in multiple gateway registries`,
    );
  }
  return matches[0];
}

function listNamesAcrossGatewayRoots(published: boolean, home: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const { entry } of listSandboxHitsAcrossGatewayRoots(home)) {
    if ((entry.pendingRouteReservation === true) !== !published) continue;
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    names.push(entry.name);
  }
  return names;
}

/** Published sandbox names across every registry root, base root first, then ports ascending. */
export function listPublishedSandboxNamesAcrossGatewayRoots(
  home: string = resolveHome(),
): string[] {
  return listNamesAcrossGatewayRoots(true, home);
}

/** Pending route-reservation names across every registry root. */
export function listPendingSandboxNamesAcrossGatewayRoots(home: string = resolveHome()): string[] {
  return listNamesAcrossGatewayRoots(false, home);
}
