// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "child_process";

import { shellQuote } from "../runner.js";
import {
  mergeOpenClawRestoredConfig,
  type OpenClawConfigMergeOptions,
} from "./openclaw-config-merge.js";
import {
  hasCompleteOpenClawImagePluginProvenance,
  type OpenClawImagePluginInstall,
} from "./openclaw-plugin-restore.js";

export type OpenClawConfigRestoreInputResult =
  | { ok: true; input: Buffer }
  | { ok: false; error: string };

export interface OpenClawConfigRestoreFromSandboxOptions {
  backupContents: Buffer;
  dir: string;
  freshImagePluginInstalls?: readonly OpenClawImagePluginInstall[];
  log?: (message: string) => void;
  previousImagePluginInstalls?: readonly OpenClawImagePluginInstall[];
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
  options: OpenClawConfigMergeOptions = {},
): OpenClawConfigRestoreInputResult {
  if (!currentContents) {
    return { ok: false, error: "openclaw.json selective merge requires current rebuilt config" };
  }

  try {
    const backedUpConfig = JSON.parse(backupContents.toString("utf-8")) as unknown;
    const currentConfig = JSON.parse(currentContents.toString("utf-8")) as unknown;
    const merged = mergeOpenClawRestoredConfig(backedUpConfig, currentConfig, options);
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
  freshImagePluginInstalls,
  log = () => {},
  previousImagePluginInstalls,
  specPath,
  sshArgs,
}: OpenClawConfigRestoreFromSandboxOptions): OpenClawConfigRestoreInputResult {
  if ((previousImagePluginInstalls === undefined) !== (freshImagePluginInstalls === undefined)) {
    return {
      ok: false,
      error: "Complete previous and fresh OpenClaw image plugin provenance is required",
    };
  }
  if (
    freshImagePluginInstalls !== undefined &&
    !hasCompleteOpenClawImagePluginProvenance(freshImagePluginInstalls, dir)
  ) {
    return { ok: false, error: "Fresh OpenClaw image plugin provenance is incomplete" };
  }
  if (
    previousImagePluginInstalls !== undefined &&
    !hasCompleteOpenClawImagePluginProvenance(previousImagePluginInstalls, dir)
  ) {
    return { ok: false, error: "Previous OpenClaw image plugin provenance is incomplete" };
  }
  return buildOpenClawConfigRestoreInput(
    backupContents,
    readCurrentOpenClawConfig(sshArgs, dir, specPath, log),
    { freshImagePluginInstalls, previousImagePluginInstalls },
  );
}
