// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { isErrnoException } from "../core/errno";
import { isObjectRecord } from "../core/json-types";
import { DEFAULT_GATEWAY_PORT, GATEWAY_PORT } from "../core/ports";
import { NAME_MAX_LENGTH, NAME_VALID_PATTERN } from "../name-validation";
import { resolveGatewayName, resolveGatewayPortFromName } from "../onboard/gateway-binding";
import { GATEWAYS_SUBDIR, nemoclawStateRoot, resolveHome } from "./state-root";

export { GATEWAYS_SUBDIR } from "./state-root";
export {
  releaseManagedGatewayStateLifecycleLock,
  tryAcquireManagedGatewayStateLifecycleLock,
} from "../onboard/gateway/state-lifecycle-lock";
// The canonical lock for a `sandboxes.json` registry file, re-exported beside
// the readers of that file so every writer guards it the same way.
export { withRegistryLockAt } from "./registry/lock";

const MAX_REGISTRY_BYTES = 16 * 1024 * 1024;
const MAX_GATEWAY_ROOTS = 256;
const MAX_GATEWAY_DIRECTORY_ENTRIES = 1024;

export interface GatewayRegistryEntry extends Record<string, unknown> {
  name: string;
  dashboardPort?: number | null;
  hermesApiPort?: number | null;
  gatewayName?: string | null;
  gatewayPort?: number | null;
}

export interface GatewayRegistryDocument extends Record<string, unknown> {
  defaultSandbox: string | null;
  sandboxes: Record<string, GatewayRegistryEntry>;
}

export interface GatewayStateRoot {
  gatewayPort: number;
  root: string;
}

function stateError(message: string): Error {
  return new Error(`Cannot safely inspect NemoClaw gateway state: ${message}`);
}

export function assertGatewayStatePathSafe(home: string, target: string): void {
  const resolvedHome = path.resolve(home);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedHome, resolvedTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw stateError(`${resolvedTarget} is outside HOME`);
  }

  let current = resolvedTarget;
  while (current !== resolvedHome) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw stateError(`${current} is a symbolic link`);
      }
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
    }
    current = path.dirname(current);
  }
}

function openReadOnlyNoFollow(filePath: string): number {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  if (noFollow === 0 && fs.lstatSync(filePath).isSymbolicLink()) {
    throw stateError(`${filePath} is a symbolic link`);
  }
  return fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
}

function parseRegistry(filePath: string, raw: string): GatewayRegistryDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw stateError(`${filePath} is not valid JSON`);
  }
  if (!isObjectRecord(parsed) || !isObjectRecord(parsed.sandboxes)) {
    throw stateError(`${filePath} does not contain a sandbox registry`);
  }
  if (
    parsed.defaultSandbox !== undefined &&
    parsed.defaultSandbox !== null &&
    typeof parsed.defaultSandbox !== "string"
  ) {
    throw stateError(`${filePath} has an invalid defaultSandbox`);
  }

  const sandboxes: Record<string, GatewayRegistryEntry> = {};
  for (const [name, value] of Object.entries(parsed.sandboxes)) {
    if (
      name.length > NAME_MAX_LENGTH ||
      !NAME_VALID_PATTERN.test(name) ||
      !isObjectRecord(value) ||
      value.name !== name
    ) {
      throw stateError(`${filePath} has an invalid sandbox row for ${JSON.stringify(name)}`);
    }
    for (const field of ["dashboardPort", "hermesApiPort"] as const) {
      const port = value[field];
      if (
        port !== undefined &&
        port !== null &&
        (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535)
      ) {
        throw stateError(`${filePath} has an invalid ${field} for sandbox ${JSON.stringify(name)}`);
      }
    }
    sandboxes[name] =
      value.dashboardPort === 0
        ? { ...(value as GatewayRegistryEntry), dashboardPort: null }
        : (value as GatewayRegistryEntry);
  }
  return {
    ...parsed,
    defaultSandbox: typeof parsed.defaultSandbox === "string" ? parsed.defaultSandbox : null,
    sandboxes,
  };
}

/** Read and strictly validate a registry without following user-controlled symlinks. */
export function readGatewayRegistryFile(
  home: string,
  filePath: string,
): GatewayRegistryDocument | null {
  assertGatewayStatePathSafe(home, path.dirname(filePath));
  let fd: number;
  try {
    fd = openReadOnlyNoFollow(filePath);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw stateError(`${filePath} is not a regular file`);
    if (stat.size > MAX_REGISTRY_BYTES) {
      throw stateError(`${filePath} exceeds the ${String(MAX_REGISTRY_BYTES)} byte limit`);
    }
    return parseRegistry(filePath, fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

/** Resolve the gateway identity recorded by a registry row, rejecting ambiguity. */
export function registryEntryGatewayPort(entry: GatewayRegistryEntry): number {
  const hasPort = entry.gatewayPort !== undefined && entry.gatewayPort !== null;
  const hasName = entry.gatewayName !== undefined && entry.gatewayName !== null;
  const port = entry.gatewayPort;
  const name = entry.gatewayName;

  if (
    hasPort &&
    (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
  ) {
    throw stateError(`sandbox ${JSON.stringify(entry.name)} has an invalid gatewayPort`);
  }
  if (hasName && typeof name !== "string") {
    throw stateError(`sandbox ${JSON.stringify(entry.name)} has an invalid gatewayName`);
  }

  const portFromName = typeof name === "string" ? resolveGatewayPortFromName(name) : null;
  if (hasName && portFromName === null) {
    throw stateError(`sandbox ${JSON.stringify(entry.name)} has an unrecognized gatewayName`);
  }
  if (typeof port === "number") {
    if (typeof name === "string" && resolveGatewayName(port) !== name) {
      throw stateError(`sandbox ${JSON.stringify(entry.name)} has conflicting gateway identity`);
    }
    return port;
  }
  if (portFromName !== null) return portFromName;
  return DEFAULT_GATEWAY_PORT;
}

/** Enumerate the default root plus bounded, real, numeric non-default gateway roots. */
export function listGatewayStateRoots(home: string): GatewayStateRoot[] {
  const sharedRoot = nemoclawStateRoot(home, DEFAULT_GATEWAY_PORT);
  const gatewaysDir = path.join(sharedRoot, GATEWAYS_SUBDIR);
  assertGatewayStatePathSafe(home, gatewaysDir);

  let directory: fs.Dir;
  try {
    directory = fs.opendirSync(gatewaysDir);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return [{ gatewayPort: DEFAULT_GATEWAY_PORT, root: sharedRoot }];
    }
    throw error;
  }

  const roots: GatewayStateRoot[] = [];
  let inspected = 0;
  try {
    let entry: fs.Dirent | null;
    while ((entry = directory.readSync()) !== null) {
      inspected += 1;
      if (inspected > MAX_GATEWAY_DIRECTORY_ENTRIES) {
        throw stateError(
          `more than ${String(MAX_GATEWAY_DIRECTORY_ENTRIES)} entries are present under ${gatewaysDir}`,
        );
      }
      if (!/^\d{1,5}$/.test(entry.name)) continue;
      const gatewayPort = Number(entry.name);
      if (gatewayPort < 1 || gatewayPort > 65535 || gatewayPort === DEFAULT_GATEWAY_PORT) continue;
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw stateError(`${path.join(gatewaysDir, entry.name)} is not a real directory`);
      }
      roots.push({ gatewayPort, root: path.join(gatewaysDir, entry.name) });
      if (roots.length > MAX_GATEWAY_ROOTS) {
        throw stateError(`more than ${String(MAX_GATEWAY_ROOTS)} gateway roots are present`);
      }
    }
  } finally {
    directory.closeSync();
  }
  roots.sort((a, b) => a.gatewayPort - b.gatewayPort);
  return [{ gatewayPort: DEFAULT_GATEWAY_PORT, root: sharedRoot }, ...roots];
}

export interface HostGatewayRegistryEntry {
  entry: GatewayRegistryEntry;
  gatewayPort: number;
  registryFile: string;
  stateRoot: string;
}

/** Aggregate every valid host registry, retaining each row's canonical gateway identity. */
export function listHostGatewayRegistryEntries(home: string): HostGatewayRegistryEntry[] {
  const result: HostGatewayRegistryEntry[] = [];
  for (const state of listGatewayStateRoots(home)) {
    const registryFile = path.join(state.root, "sandboxes.json");
    const registry = readGatewayRegistryFile(home, registryFile);
    if (!registry) continue;
    for (const entry of Object.values(registry.sandboxes)) {
      const gatewayPort = registryEntryGatewayPort(entry);
      if (state.gatewayPort !== DEFAULT_GATEWAY_PORT && gatewayPort !== state.gatewayPort) {
        throw stateError(
          `${registryFile} contains sandbox ${JSON.stringify(entry.name)} for gateway port ${String(gatewayPort)}`,
        );
      }
      result.push({ entry, gatewayPort, registryFile, stateRoot: state.root });
    }
  }
  return result;
}

export interface ForeignGatewayOwner {
  gatewayName: string;
  gatewayPort: number;
  registryFile: string;
}

export interface ForeignGatewaySandbox {
  /** Every other gateway root claiming the name, ascending by port. */
  owners: ForeignGatewayOwner[];
  selectedGatewayName: string;
  selectedGatewayPort: number;
}

/**
 * Locate a sandbox registered under a gateway state root other than the selected
 * one.
 *
 * Registry reads are pinned to the selected gateway's root, so a second
 * gateway's sandbox reads as absent. Recovery stays gateway-scoped on purpose
 * (#7105), so this only reports the owner and never adopts its row (#10656).
 *
 * Returns null when no other root claims the name, and also when any host
 * registry is unreadable. `listHostGatewayRegistryEntries` fails closed on
 * malformed JSON, a bad row, a symlinked root or a port mismatch, which is
 * right for its allocating callers but wrong here: the sole caller is an
 * already-failing diagnostic that must still exit cleanly rather than throw.
 * That matches the read-only carve-out `safeListRegistryEntries` established.
 */
export function findForeignGatewaySandbox(
  sandboxName: string,
  selectedGatewayPort: number = GATEWAY_PORT,
  home: string = resolveHome(),
): ForeignGatewaySandbox | null {
  let hostEntries: HostGatewayRegistryEntry[];
  try {
    hostEntries = listHostGatewayRegistryEntries(home);
  } catch {
    return null;
  }
  // Nothing enforces host-wide sandbox-name uniqueness, so two gateway roots can
  // each register the name. Report every claimant: naming one would send a
  // rerun command to an arbitrary gateway, chosen only by port order.
  const owners = hostEntries
    .filter(
      (candidate) =>
        candidate.entry.name === sandboxName && candidate.gatewayPort !== selectedGatewayPort,
    )
    .map((candidate) => ({
      gatewayName: resolveGatewayName(candidate.gatewayPort),
      gatewayPort: candidate.gatewayPort,
      registryFile: candidate.registryFile,
    }));
  if (owners.length === 0) return null;
  return {
    owners,
    selectedGatewayName: resolveGatewayName(selectedGatewayPort),
    selectedGatewayPort,
  };
}
