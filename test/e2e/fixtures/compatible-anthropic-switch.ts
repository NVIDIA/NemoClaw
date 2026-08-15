// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import fs from "node:fs";

import type { HostCliClient } from "./clients/host.ts";
import { resultText } from "./clients/index.ts";

export const COMPATIBLE_ANTHROPIC_PROVIDER = "compatible-anthropic-endpoint";
export const COMPATIBLE_ANTHROPIC_CREDENTIAL_ENV = "COMPATIBLE_ANTHROPIC_API_KEY";
const DEFAULT_COMPATIBLE_ANTHROPIC_CREDENTIAL = "test-compatible-anthropic-key";
const HOST_VERIFICATION_HOSTS_PATH = "/etc/hosts";
const HOST_VERIFICATION_LOCK_PATH = "/run/lock/nemoclaw-compatible-endpoint-hosts.lock";
const HOST_VERIFICATION_COMMAND_TIMEOUT_MS = 60_000;

export const HOST_VERIFICATION_ALIAS_SCRIPT = [
  "set -euo pipefail",
  "",
  'operation="$1"',
  'hosts_path="$2"',
  'lock_path="$3"',
  'owner_pid="$4"',
  'owner_start="$5"',
  'owner_token="$6"',
  'alias_name="host.openshell.internal"',
  "",
  'case "$operation" in',
  "  add | remove) ;;",
  '  *) echo "unsupported host verifier alias operation: $operation" >&2; exit 2 ;;',
  "esac",
  '[[ "$owner_pid" =~ ^[1-9][0-9]*$ ]] || { echo "invalid host verifier owner PID" >&2; exit 2; }',
  '[[ "$owner_start" =~ ^[1-9][0-9]*$ ]] || { echo "invalid host verifier owner start time" >&2; exit 2; }',
  '[[ "$owner_token" =~ ^[a-f0-9]{32}$ ]] || { echo "invalid host verifier owner token" >&2; exit 2; }',
  '[[ -f "$hosts_path" && ! -L "$hosts_path" ]] || { echo "host resolver file is not a regular file" >&2; exit 2; }',
  '[[ ! -L "$lock_path" ]] || { echo "host resolver lock path must not be a symbolic link" >&2; exit 2; }',
  'command -v flock >/dev/null 2>&1 || { echo "flock is required for host resolver fixture ownership" >&2; exit 2; }',
  "",
  "owner_is_alive() {",
  '  local pid="$1" expected_start="$2" stat remainder',
  '  [[ -r "/proc/${pid}/stat" ]] || return 1',
  '  IFS= read -r stat < "/proc/${pid}/stat"',
  '  remainder="${stat##*) }"',
  "  set -- $remainder",
  '  [[ "${20:-}" == "$expected_start" ]]',
  "}",
  "",
  'if [[ "$operation" == "add" ]] && ! owner_is_alive "$owner_pid" "$owner_start"; then',
  '  echo "host verifier owner process is not alive" >&2',
  "  exit 2",
  "fi",
  "",
  "umask 077",
  'exec 9>>"$lock_path"',
  'chmod 0600 "$lock_path"',
  'flock -x -w 30 9 || { echo "timed out waiting for host resolver fixture ownership" >&2; exit 3; }',
  "",
  'marker="# nemoclaw-host-verifier:${owner_pid}:${owner_start}:${owner_token}"',
  'owned_line="127.0.0.1 ${alias_name} ${marker}"',
  'snapshot="$(mktemp "${hosts_path}.nemoclaw-snapshot.XXXXXX")"',
  'replacement="$(mktemp "${hosts_path}.nemoclaw-replacement.XXXXXX")"',
  "trap 'rm -f \"$snapshot\" \"$replacement\"' EXIT",
  'cp --preserve=all -- "$hosts_path" "$snapshot"',
  'cp --preserve=all -- "$hosts_path" "$replacement"',
  ': > "$replacement"',
  "",
  'while IFS= read -r line || [[ -n "$line" ]]; do',
  '  if [[ "$line" == "$owned_line" ]]; then',
  "    continue",
  "  fi",
  '  if [[ "$line" =~ ^127\\.0\\.0\\.1[[:space:]]+host\\.openshell\\.internal[[:space:]]+#[[:space:]]nemoclaw-host-verifier:([1-9][0-9]*):([1-9][0-9]*):([a-f0-9]{32})$ ]]; then',
  '    if owner_is_alive "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"; then',
  "      printf '%s\\n' \"$line\" >> \"$replacement\"",
  "    fi",
  "    continue",
  "  fi",
  "  printf '%s\\n' \"$line\" >> \"$replacement\"",
  'done < "$snapshot"',
  "",
  'if [[ "$operation" == "add" ]]; then',
  "  printf '%s\\n' \"$owned_line\" >> \"$replacement\"",
  "fi",
  "",
  "# The kernel lock serializes every cooperative fixture writer. Replacing the",
  "# file in one rename prevents readers from observing a partial resolver file.",
  'mv -f -- "$replacement" "$hosts_path"',
  "trap 'rm -f \"$snapshot\"' EXIT",
  "",
  'if [[ "$operation" == "add" ]]; then',
  '  grep -Fqx -- "$owned_line" "$hosts_path" || { echo "host verifier alias was not installed" >&2; exit 4; }',
  "else",
  '  ! grep -Fqx -- "$owned_line" "$hosts_path" || { echo "host verifier alias was not removed" >&2; exit 4; }',
  "fi",
].join("\n");

export interface CompatibleAnthropicSwitchBinding {
  endpointUrl: string;
  credentialValue: string;
}

export function compatibleAnthropicSwitchBinding(
  endpointUrl: string,
  runtimeEnv: NodeJS.ProcessEnv = process.env,
): CompatibleAnthropicSwitchBinding {
  const normalizedEndpointUrl = endpointUrl.trim();
  if (!normalizedEndpointUrl) {
    throw new Error(
      "NEMOCLAW_SWITCH_ENDPOINT_URL is required for compatible Anthropic inference switches",
    );
  }
  const credentialValue =
    runtimeEnv[COMPATIBLE_ANTHROPIC_CREDENTIAL_ENV] ?? DEFAULT_COMPATIBLE_ANTHROPIC_CREDENTIAL;
  if (!credentialValue.trim()) {
    throw new Error(
      "COMPATIBLE_ANTHROPIC_API_KEY is required for compatible Anthropic inference switches",
    );
  }
  return { endpointUrl: normalizedEndpointUrl, credentialValue };
}

export function compatibleAnthropicSwitchEnv(
  binding: CompatibleAnthropicSwitchBinding | null,
): NodeJS.ProcessEnv {
  return binding ? { [COMPATIBLE_ANTHROPIC_CREDENTIAL_ENV]: binding.credentialValue } : {};
}

function hostVerificationOwnerStartTime(): string {
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const close = stat.lastIndexOf(") ");
  const fields = close >= 0 ? stat.slice(close + 2).trim().split(/\s+/u) : [];
  const startTime = fields[19];
  if (!startTime || !/^[1-9][0-9]*$/u.test(startTime)) {
    throw new Error("could not read the host verifier owner process start time");
  }
  return startTime;
}

interface HostVerificationOwner {
  pid: number;
  startTime: string;
  token: string;
}

function createHostVerificationOwner(): HostVerificationOwner {
  return {
    pid: process.pid,
    startTime: hostVerificationOwnerStartTime(),
    token: randomBytes(16).toString("hex"),
  };
}

async function updateHostVerificationAlias(
  host: HostCliClient,
  operation: "add" | "remove",
  owner: HostVerificationOwner,
): Promise<void> {
  const artifactName = `${operation === "add" ? "map" : "restore"}-host-verifier-alias`;
  const result = await host.command(
    "sudo",
    [
      "bash",
      "-ceu",
      HOST_VERIFICATION_ALIAS_SCRIPT,
      artifactName,
      operation,
      HOST_VERIFICATION_HOSTS_PATH,
      HOST_VERIFICATION_LOCK_PATH,
      String(owner.pid),
      owner.startTime,
      owner.token,
    ],
    { artifactName, timeoutMs: HOST_VERIFICATION_COMMAND_TIMEOUT_MS },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `could not ${operation === "add" ? "install" : "remove"} the host verifier alias: ${resultText(result)}`,
    );
  }
}

export async function withHostVerificationLoopbackAlias<T>(
  host: HostCliClient,
  cleanup: { trackDisposable(name: string, run: () => Promise<void> | void): void },
  run: () => Promise<T>,
): Promise<T> {
  const owner = createHostVerificationOwner();
  let restored = false;
  const restore = async (): Promise<void> => {
    if (restored) return;
    await updateHostVerificationAlias(host, "remove", owner);
    restored = true;
  };
  cleanup.trackDisposable("restore the host verifier alias mapping", restore);

  try {
    await updateHostVerificationAlias(host, "add", owner);
    return await run();
  } finally {
    await restore();
  }
}

export async function requireCompatibleAnthropicProviderAbsent(
  host: HostCliClient,
  options: {
    artifactName: string;
    env: NodeJS.ProcessEnv;
    gatewayName?: string;
  },
): Promise<void> {
  const gatewayName = options.gatewayName ?? "nemoclaw";
  const result = await host.command(
    "openshell",
    ["provider", "get", "-g", gatewayName, COMPATIBLE_ANTHROPIC_PROVIDER],
    {
      artifactName: options.artifactName,
      env: options.env,
      timeoutMs: 30_000,
    },
  );
  const output = resultText(result);
  if (result.exitCode === 0) {
    throw new Error(
      `Provider '${COMPATIBLE_ANTHROPIC_PROVIDER}' must be absent before this inference switch so NemoClaw can create and verify its rollback-safe binding.`,
    );
  }
  if (!/provider not found|requested entity was not found/iu.test(output)) {
    throw new Error(
      `Could not prove provider '${COMPATIBLE_ANTHROPIC_PROVIDER}' is absent: ${output}`,
    );
  }
}
