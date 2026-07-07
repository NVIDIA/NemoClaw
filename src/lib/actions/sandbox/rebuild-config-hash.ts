// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { R, YW } from "../../cli/terminal-style";
import { shellQuote } from "../../runner";
import { redact } from "../../security/redact";
import { executeSandboxCommand } from "./process-recovery";

export function buildRefreshMutableOpenClawConfigHashCommand(
  configDir = "/sandbox/.openclaw",
): string {
  return [
    `config_dir=${shellQuote(configDir)}`,
    'config_file="${config_dir}/openclaw.json"',
    'hash_file="${config_dir}/.config-hash"',
    '[ -d "$config_dir" ] || exit 0',
    '[ ! -L "$config_dir" ] || { echo "refusing symlinked OpenClaw config dir: $config_dir" >&2; exit 10; }',
    '[ ! -L "$config_file" ] || { echo "refusing symlinked OpenClaw config file: $config_file" >&2; exit 11; }',
    '[ ! -L "$hash_file" ] || { echo "refusing symlinked OpenClaw config hash: $hash_file" >&2; exit 12; }',
    'owner="$(stat -c "%U" "$config_dir" 2>/dev/null || echo unknown)"',
    '[ "$owner" != "root" ] || exit 0',
    '[ -f "$config_file" ] || exit 0',
    'cd "$config_dir" || exit 13',
    "sha256sum openclaw.json > .config-hash",
    "chmod 660 .config-hash 2>/dev/null || true",
  ].join("; ");
}

export function refreshMutableOpenClawConfigHashAfterPostRestoreWrites(
  sandboxName: string,
  log: (msg: string) => void,
): boolean {
  const result = executeSandboxCommand(sandboxName, buildRefreshMutableOpenClawConfigHashCommand());
  if (result && result.status === 0) {
    log("Mutable OpenClaw config hash refreshed after post-restore config writes");
    return true;
  }

  const detail = result
    ? [result.stderr, result.stdout].filter(Boolean).join("; ") || `exit ${result.status}`
    : "could not obtain sandbox SSH config";
  console.error(`  ${YW}⚠${R} Mutable OpenClaw config hash was not refreshed: ${redact(detail)}`);
  return false;
}
