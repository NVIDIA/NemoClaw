// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "../../core/shell-quote";

function buildConfigHashVerification(errorMessage: string): string {
  return `expected_hash="$(sha256sum openclaw.json 2>/dev/null)" && actual_hash="$(cat .config-hash 2>/dev/null)" && [ "$actual_hash" = "$expected_hash" ] || { echo ${shellQuote(errorMessage)} >&2; exit 15; }`;
}

function buildOpenClawConfigHashCommandPrefix(configDir: string): string[] {
  return [
    `config_dir=${shellQuote(configDir)}`,
    'config_file="${config_dir}/openclaw.json"',
    'hash_file="${config_dir}/.config-hash"',
    '[ ! -L "$config_dir" ] || { echo "refusing symlinked OpenClaw config dir: $config_dir" >&2; exit 10; }',
    '[ ! -L "$config_file" ] || { echo "refusing symlinked OpenClaw config file: $config_file" >&2; exit 11; }',
    '[ ! -L "$hash_file" ] || { echo "refusing symlinked OpenClaw config hash: $hash_file" >&2; exit 12; }',
  ];
}

export function buildRefreshMutableOpenClawConfigHashCommand(
  configDir = "/sandbox/.openclaw",
): string {
  return [
    ...buildOpenClawConfigHashCommandPrefix(configDir),
    '[ -d "$config_dir" ] || exit 0',
    'owner="$(stat -c "%U" "$config_dir" 2>/dev/null || echo unknown)"',
    '[ -f "$config_file" ] || exit 0',
    'cd "$config_dir" || exit 13',
    `[ "$owner" != "root" ] || { ${buildConfigHashVerification("root-owned OpenClaw config hash does not match openclaw.json")}; exit 0; }`,
    "sha256sum openclaw.json > .config-hash || exit 14",
    "chmod 660 .config-hash 2>/dev/null || true",
  ].join("; ");
}

export function buildVerifyMutableOpenClawConfigHashCommand(
  configDir = "/sandbox/.openclaw",
): string {
  return [
    ...buildOpenClawConfigHashCommandPrefix(configDir),
    '[ -d "$config_dir" ] || { echo "OpenClaw config directory is not a directory: $config_dir" >&2; exit 16; }',
    '[ -f "$config_file" ] || { echo "OpenClaw config is not a regular file: $config_file" >&2; exit 17; }',
    '[ -f "$hash_file" ] || { echo "OpenClaw config hash is not a regular file: $hash_file" >&2; exit 18; }',
    'cd "$config_dir" || exit 13',
    buildConfigHashVerification("OpenClaw config hash does not match openclaw.json"),
  ].join("; ");
}
