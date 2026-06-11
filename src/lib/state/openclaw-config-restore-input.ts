// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "child_process";

import { shellQuote } from "../runner.js";
import { mergeOpenClawRestoredConfig } from "./openclaw-config-merge.js";

export interface OpenClawConfigStateFileSpec {
  path: string;
  strategy: string;
}

/**
 * OpenClaw openclaw.json restore source-of-truth boundary.
 *
 * The OpenClaw agent manifest currently declares openclaw.json as a durable
 * state file, but it cannot yet express key-level ownership. Until that schema
 * exists, this module is the localized restore policy for reconciling the
 * sanitized backup with the freshly rebuilt runtime config.
 *
 * Invalid state: replacing fresh runtime-owned config when the current file is
 * missing, unreadable, or invalid JSON. In those cases restore must fail the
 * file explicitly instead of falling back to a wholesale sanitized backup write.
 *
 * Source-fix constraint: remove or shrink this policy when OpenClaw or the
 * agent manifest can declare key-level ownership/migration rules for
 * openclaw.json directly.
 */
export function shouldMergeOpenClawConfigStateFile(
  agentType: string | null | undefined,
  dir: string,
  spec: OpenClawConfigStateFileSpec,
): boolean {
  return (
    spec.strategy === "copy" &&
    spec.path === "openclaw.json" &&
    (agentType === "openclaw" || dir.replace(/\/+$/, "").endsWith("/.openclaw"))
  );
}

export type OpenClawConfigRestoreInputResult =
  | { ok: true; input: Buffer }
  | { ok: false; error: string };

export interface OpenClawConfigRestoreFromSandboxOptions {
  backupContents: Buffer;
  dir: string;
  log?: (message: string) => void;
  specPath: string;
  sshArgs: readonly string[];
}

function openClawConfigRemotePath(dir: string, specPath: string): string {
  return `${dir.replace(/\/+$/, "")}/${specPath}`;
}

export function buildOpenClawConfigReadCommand(dir: string, specPath: string): string {
  const remotePath = openClawConfigRemotePath(dir, specPath);
  const quotedRemotePath = shellQuote(remotePath);
  return [
    `src=${quotedRemotePath}`,
    '[ ! -e "$src" ] && exit 2',
    '[ -f "$src" ] && [ ! -L "$src" ] || { echo "unsafe state file: $src" >&2; exit 10; }',
    'cat -- "$src"',
  ].join("; ");
}

function readCurrentOpenClawConfig(
  sshArgs: readonly string[],
  dir: string,
  specPath: string,
  log: (message: string) => void,
): Buffer | null {
  const command = buildOpenClawConfigReadCommand(dir, specPath);
  const result = spawnSync("ssh", [...sshArgs, command], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status === 0 && !result.error && !result.signal) return result.stdout;
  if (result.status !== 2) {
    const detail =
      (result.stderr?.toString() || "").trim() ||
      result.error?.message ||
      (result.signal ? `signal ${result.signal}` : `exit ${String(result.status)}`);
    log(`WARNING: state file current read ${specPath} failed: ${detail.substring(0, 200)}`);
  }
  return null;
}

export function buildOpenClawConfigRestoreInput(
  backupContents: Buffer,
  currentContents: Buffer | null,
): OpenClawConfigRestoreInputResult {
  if (!currentContents) {
    return { ok: false, error: "openclaw.json selective merge requires current rebuilt config" };
  }

  try {
    const backedUpConfig = JSON.parse(backupContents.toString("utf-8")) as unknown;
    const currentConfig = JSON.parse(currentContents.toString("utf-8")) as unknown;
    const merged = mergeOpenClawRestoredConfig(backedUpConfig, currentConfig);
    return { ok: true, input: Buffer.from(`${JSON.stringify(merged, null, 2)}\n`) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `openclaw.json selective merge failed; refusing unsafe wholesale backup restore: ${detail}`,
    };
  }
}

export function buildOpenClawConfigRestoreInputFromSandbox({
  backupContents,
  dir,
  log = () => {},
  specPath,
  sshArgs,
}: OpenClawConfigRestoreFromSandboxOptions): OpenClawConfigRestoreInputResult {
  return buildOpenClawConfigRestoreInput(
    backupContents,
    readCurrentOpenClawConfig(sshArgs, dir, specPath, log),
  );
}
