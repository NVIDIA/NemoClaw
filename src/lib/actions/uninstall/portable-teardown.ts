// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Full destructive uninstall of the portable profile used to run the generic
// `openshell sandbox delete --all` teardown and then delete NemoClaw state,
// returning exit 0 while receipt-owned rootless-Podman containers kept running
// and NemoClaw-installed selector values stayed in the current user's systemd
// manager environment. The stale CONTAINERS_CONF then pointed at a deleted
// file, socket activation failed to start podman.service, and a clean reinstall
// began from a broken runtime (gh #9189).
//
// This module tears down exactly the runtime NemoClaw created:
//
//   1. deletes the receipt-owned sandbox and registry containers by ID -- the
//      sandbox by the containerId recorded in the portable lifecycle receipt
//      (never name-only), the registry by a NemoClaw-owned label scan;
//   2. unsets only the NemoClaw-set user-manager selectors (CONTAINERS_CONF
//      pointing at the portable containers.conf, NETAVARK_FW=iptables), never
//      unrelated user configuration;
//   3. removes the receipt files it owns.
//
// It is credential-free (no sudo) and refuses to guess: a malformed receipt is
// skipped with a warning, and a failed container deletion surfaces as
// `ok: false` so uninstall cannot report success while runtime state remains.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface PortableTeardownInput {
  readonly env: NodeJS.ProcessEnv;
  readonly stateDir?: string;
  readonly run?: (command: string, args: string[], env: NodeJS.ProcessEnv) => CommandResult;
  readonly readDirSync?: (dir: string) => string[];
  readonly readFileSync?: (file: string, encoding: "utf8") => string;
  readonly rmSync?: (target: string) => void;
  readonly log?: (message: string) => void;
  readonly warn?: (message: string) => void;
}

export interface PortableTeardownResult {
  readonly ok: boolean;
  readonly removedContainerIds: readonly string[];
  readonly unsetSelectors: readonly string[];
  readonly removedReceiptFiles: readonly string[];
  readonly reason?: string;
}

const RECEIPT_DIRECTORY = "portable-demo-lifecycle";
const PORTABLE_REGISTRY_LABEL = "com.nvidia.nemoclaw.portable=1";
const PORTABLE_CONTAINERS_CONF_SUFFIX = path.join("nemoclaw", "portable", "containers.conf");
// Matches the container IDs NemoClaw records in portable lifecycle receipts
// (64 hex chars) and the short IDs podman prints.
const CONTAINER_ID_PATTERN = /^[0-9a-f]{12,64}$/u;

export function portableReceiptDirectory(stateDir: string): string {
  return path.join(stateDir, RECEIPT_DIRECTORY);
}

export function defaultPortableStateDir(env: NodeJS.ProcessEnv): string {
  return path.join(env.HOME ?? os.homedir(), ".nemoclaw");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readPortableReceipt(
  file: string,
  readFileSync: (file: string, encoding: "utf8") => string,
): { containerId: string } | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const value: unknown = JSON.parse(text) as unknown;
    if (!isRecord(value) || typeof value.containerId !== "string") return null;
    if (!CONTAINER_ID_PATTERN.test(value.containerId)) return null;
    return { containerId: value.containerId };
  } catch {
    return null;
  }
}

export function listPortableReceiptFiles(
  stateDir: string,
  readDirSync: (dir: string) => string[],
): string[] {
  let names: string[];
  try {
    names = readDirSync(portableReceiptDirectory(stateDir));
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(portableReceiptDirectory(stateDir), name));
}

export function removeContainerById(
  containerId: string,
  env: NodeJS.ProcessEnv,
  run: (command: string, args: string[], env: NodeJS.ProcessEnv) => CommandResult,
  warn: (message: string) => void,
): boolean {
  const result = run("podman", ["rm", "-f", containerId], env);
  if (result.status === 0) return true;
  warn(`  Could not remove portable container ${containerId}: ${result.stderr.trim()}`);
  return false;
}

export function findPortableRegistryContainerIds(
  env: NodeJS.ProcessEnv,
  run: (command: string, args: string[], env: NodeJS.ProcessEnv) => CommandResult,
): readonly string[] {
  const result = run(
    "podman",
    ["ps", "-a", "--filter", `label=${PORTABLE_REGISTRY_LABEL}`, "--format", "{{.ID}}"],
    env,
  );
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\s+/u)
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

function parseShowEnvironment(stdout: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line.trim());
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

export function clearPortableUserManagerSelectors(
  env: NodeJS.ProcessEnv,
  run: (command: string, args: string[], env: NodeJS.ProcessEnv) => CommandResult,
): readonly string[] {
  const result = run("systemctl", ["--user", "show-environment"], env);
  if (result.status !== 0) return [];
  const current = parseShowEnvironment(result.stdout);
  const toUnset: string[] = [];

  const containersConf = current.get("CONTAINERS_CONF");
  if (containersConf !== undefined && containersConf.endsWith(PORTABLE_CONTAINERS_CONF_SUFFIX)) {
    toUnset.push("CONTAINERS_CONF");
  }
  if (current.get("NETAVARK_FW") === "iptables") {
    toUnset.push("NETAVARK_FW");
  }

  for (const name of toUnset) {
    run("systemctl", ["--user", "unset-environment", name], env);
  }
  return toUnset;
}

export function teardownPortableRuntime(input: PortableTeardownInput): PortableTeardownResult {
  const env = input.env;
  const run =
    input.run ??
    ((command: string, args: string[], childEnv: NodeJS.ProcessEnv): CommandResult => {
      const result = spawnSync(command, args, { encoding: "utf8", env: childEnv });
      return {
        status: result.status,
        stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout ?? ""),
        stderr: typeof result.stderr === "string" ? result.stderr : String(result.stderr ?? ""),
      };
    });
  const readDirSync = input.readDirSync ?? fs.readdirSync;
  const readFileSync = input.readFileSync ?? fs.readFileSync;
  const rmSync = input.rmSync ?? ((file: string) => fs.rmSync(file, { force: true }));
  const log = input.log ?? ((message: string) => console.log(message));
  const warn = input.warn ?? ((message: string) => console.warn(message));

  const stateDir = input.stateDir ?? defaultPortableStateDir(env);
  const receiptFiles = listPortableReceiptFiles(stateDir, readDirSync);
  const removedContainerIds: string[] = [];
  const removedReceiptFiles: string[] = [];
  let ok = true;

  // 1. Remove receipt-owned containers by ID (never name-only), then the
  // NemoClaw-owned registry container found by its ownership label.
  const removedViaReceipt = new Set<string>();
  for (const file of receiptFiles) {
    const receipt = readPortableReceipt(file, readFileSync);
    if (receipt === null) {
      warn(`  Skipped unreadable portable lifecycle receipt: ${file}`);
      continue;
    }
    if (removeContainerById(receipt.containerId, env, run, warn)) {
      removedViaReceipt.add(receipt.containerId);
      removedContainerIds.push(receipt.containerId);
    } else {
      ok = false;
    }
    rmSync(file);
    removedReceiptFiles.push(file);
  }
  for (const containerId of findPortableRegistryContainerIds(env, run)) {
    if (removedViaReceipt.has(containerId)) continue;
    if (removeContainerById(containerId, env, run, warn)) {
      removedContainerIds.push(containerId);
    } else {
      ok = false;
    }
  }

  // 2. Clear only the NemoClaw-set user-manager selectors.
  const unsetSelectors = clearPortableUserManagerSelectors(env, run);
  if (unsetSelectors.length > 0) {
    log(
      `  Cleared NemoClaw portable selectors from the user manager: ${unsetSelectors.join(", ")}`,
    );
  }

  if (
    receiptFiles.length === 0 &&
    unsetSelectors.length === 0 &&
    removedContainerIds.length === 0
  ) {
    return { ok: true, removedContainerIds: [], unsetSelectors: [], removedReceiptFiles: [] };
  }

  if (!ok) {
    return {
      ok: false,
      removedContainerIds,
      unsetSelectors,
      removedReceiptFiles,
      reason:
        "Portable runtime containers could not all be removed; the user manager " +
        "selectors were still cleared. Re-run uninstall after fixing the container " +
        "removal failure.",
    };
  }
  return { ok: true, removedContainerIds, unsetSelectors, removedReceiptFiles };
}
