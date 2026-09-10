// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import path from "node:path";

import { GATEWAYS_SUBDIR, STATE_DIR_NAME, resolveHome } from "../state-root";
import type { SandboxEntry } from "./types";

export interface CrossPortSandboxHit {
  entry: SandboxEntry;
  /** Recorded or directory-derived owning gateway port; null when unrecorded on the base root. */
  gatewayPort: number | null;
  registryFile: string;
}

function readRegistryFile(file: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  return null;
}

function isSandboxEntryLike(value: unknown): value is SandboxEntry {
  return (
    typeof value === "object" && value !== null && typeof (value as SandboxEntry).name === "string"
  );
}

interface RegistryRootScan {
  file: string;
  /** Port authority for this root; `undefined` for the default-port base root. */
  gatewayPort: number | undefined;
}

function listRegistryRootCandidates(home: string): RegistryRootScan[] {
  const base = path.join(home, STATE_DIR_NAME);
  const candidates: RegistryRootScan[] = [
    { file: path.join(base, "sandboxes.json"), gatewayPort: undefined },
  ];
  const gatewaysDir = path.join(base, GATEWAYS_SUBDIR);
  let portDirs: fs.Dirent[];
  try {
    portDirs = fs.readdirSync(gatewaysDir, { withFileTypes: true });
  } catch {
    return candidates;
  }
  const scans: RegistryRootScan[] = [];
  for (const dirent of portDirs) {
    if (!dirent.isDirectory()) continue;
    if (!/^\d+$/.test(dirent.name)) continue;
    const gatewayPort = Number(dirent.name);
    if (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535) continue;
    scans.push({ file: path.join(gatewaysDir, dirent.name, "sandboxes.json"), gatewayPort });
  }
  scans.sort((left, right) => (left.gatewayPort ?? 0) - (right.gatewayPort ?? 0));
  return [...candidates, ...scans];
}

function entriesFromRoot(scan: RegistryRootScan): Array<[string, SandboxEntry]> {
  const document = readRegistryFile(scan.file);
  if (!document) return [];
  const sandboxes = document.sandboxes;
  if (!sandboxes || typeof sandboxes !== "object") return [];
  const entries: Array<[string, SandboxEntry]> = [];
  for (const [name, value] of Object.entries(sandboxes)) {
    if (!isSandboxEntryLike(value)) continue;
    const entry = { ...value };
    // A sibling-port directory is the port authority for an entry that
    // predates the recorded gatewayPort field; entries in the default base
    // root keep their absent-field semantics (the bare default gateway).
    if (!Number.isInteger(entry.gatewayPort) && scan.gatewayPort !== undefined) {
      entry.gatewayPort = scan.gatewayPort;
    }
    entries.push([name, entry]);
  }
  return entries;
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
  for (const scan of listRegistryRootCandidates(home)) {
    for (const [name, entry] of entriesFromRoot(scan)) {
      if (name === sandboxName) {
        const gatewayPort = Number.isInteger(entry.gatewayPort) ? Number(entry.gatewayPort) : null;
        return { entry, gatewayPort, registryFile: scan.file };
      }
    }
  }
  return null;
}

function listNamesAcrossGatewayRoots(published: boolean, home: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const scan of listRegistryRootCandidates(home)) {
    for (const [name, entry] of entriesFromRoot(scan)) {
      if ((entry.pendingRouteReservation === true) !== !published) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
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
