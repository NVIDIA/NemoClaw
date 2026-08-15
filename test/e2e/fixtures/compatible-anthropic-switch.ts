// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { HostCliClient } from "./clients/host.ts";
import { resultText } from "./clients/index.ts";

export const COMPATIBLE_ANTHROPIC_PROVIDER = "compatible-anthropic-endpoint";
export const COMPATIBLE_ANTHROPIC_CREDENTIAL_ENV = "COMPATIBLE_ANTHROPIC_API_KEY";
const DEFAULT_COMPATIBLE_ANTHROPIC_CREDENTIAL = "test-compatible-anthropic-key";
const OPENSHELL_HOST_ALIAS = "host.openshell.internal";
const GATEWAY_SERVICE_NAMES = ["nemoclaw-openshell-gateway", "openshell-gateway"] as const;

export const GATEWAY_HOST_VERIFICATION_MOUNT_SCRIPT = [
  "set -euo pipefail",
  'operation="$1"',
  'resolver_source="$2"',
  'owner_token="$3"',
  'hosts_path="$4"',
  `alias_name="${OPENSHELL_HOST_ALIAS}"`,
  'owned_line="127.0.0.1 ${alias_name} # nemoclaw-gateway-host-verifier:${owner_token}"',
  "",
  'case "$operation" in',
  "  add | remove) ;;",
  '  *) echo "unsupported gateway resolver operation: $operation" >&2; exit 2 ;;',
  "esac",
  '[[ "$owner_token" =~ ^[a-f0-9]{32}$ ]] || { echo "invalid gateway resolver owner token" >&2; exit 2; }',
  '[[ -f "$hosts_path" ]] || { echo "gateway resolver path is not a regular file" >&2; exit 2; }',
  "",
  'if [[ "$operation" == "add" ]]; then',
  '  [[ -f "$resolver_source" && ! -L "$resolver_source" ]] || { echo "gateway resolver source is not a regular file" >&2; exit 2; }',
  '  grep -Fqx -- "$owned_line" "$resolver_source" || { echo "gateway resolver source lacks its ownership marker" >&2; exit 2; }',
  "  mount --make-rprivate /",
  '  mount --bind "$resolver_source" "$hosts_path"',
  '  grep -Fqx -- "$owned_line" "$hosts_path" || { echo "gateway resolver mount was not installed" >&2; exit 4; }',
  "  exit 0",
  "fi",
  "",
  '# A restarted gateway has already released the owned mount namespace.',
  'grep -Fqx -- "$owned_line" "$hosts_path" || exit 0',
  'umount "$hosts_path"',
  'if grep -Fqx -- "$owned_line" "$hosts_path"; then',
  '  echo "gateway resolver mount was not removed" >&2',
  "  exit 4",
  "fi",
].join("\n");

const GATEWAY_HOST_VERIFICATION_NAMESPACE_SCRIPT = [
  "set -euo pipefail",
  'operation="$1"',
  'target_pid="$2"',
  'resolver_source="$3"',
  'owner_token="$4"',
  'mount_script="$5"',
  "",
  '[[ "$target_pid" =~ ^[1-9][0-9]*$ ]] || { echo "invalid OpenShell gateway PID" >&2; exit 2; }',
  "gateway_is_alive() {",
  '  local executable=""',
  '  [[ -r "/proc/${target_pid}/stat" ]] || return 1',
  '  executable="$(readlink -f "/proc/${target_pid}/exe" 2>/dev/null || true)"',
  '  [[ "${executable##*/}" == "openshell-gateway" ]]',
  "}",
  "",
  'if ! gateway_is_alive; then',
  '  [[ "$operation" == "remove" ]] && exit 0',
  '  echo "active OpenShell gateway process is unavailable" >&2',
  "  exit 3",
  "fi",
  'command -v nsenter >/dev/null 2>&1 || { echo "nsenter is required for scoped gateway resolution" >&2; exit 2; }',
  'current_namespace="$(readlink /proc/self/ns/mnt)"',
  'target_namespace="$(readlink "/proc/${target_pid}/ns/mnt")"',
  '[[ "$current_namespace" != "$target_namespace" ]] || { echo "OpenShell gateway does not have a private mount namespace" >&2; exit 3; }',
  "",
  'exec nsenter --target "$target_pid" --mount -- bash -ceu "$mount_script" gateway-resolver-mount "$operation" "$resolver_source" "$owner_token" /etc/hosts',
].join("\n");

export interface CompatibleAnthropicSwitchBinding {
  endpointUrl: string;
  credentialValue: string;
}

export function compatibleAnthropicMockEndpointUrl(port: number): string {
  return `http://${OPENSHELL_HOST_ALIAS}:${port}`;
}

async function activeOpenShellGatewayPid(host: HostCliClient): Promise<number> {
  for (const serviceName of GATEWAY_SERVICE_NAMES) {
    const result = await host.command(
      "systemctl",
      [
        "--user",
        "show",
        serviceName,
        "--property=ActiveState",
        "--property=MainPID",
      ],
      { artifactName: `inspect-${serviceName}`, timeoutMs: 30_000 },
    );
    if (result.exitCode !== 0) continue;
    const properties = new Map(
      result.stdout
        .split(/\r?\n/u)
        .map((line) => line.split("=", 2))
        .filter((entry): entry is [string, string] => entry.length === 2),
    );
    const pid = Number(properties.get("MainPID"));
    if (properties.get("ActiveState") === "active" && Number.isSafeInteger(pid) && pid > 0) {
      return pid;
    }
  }
  throw new Error("could not find an active OpenShell gateway user service");
}

export async function installGatewayHostVerificationAlias(
  host: HostCliClient,
  cleanup: { add(name: string, run: () => Promise<void> | void): void },
): Promise<void> {
  const gatewayPid = await activeOpenShellGatewayPid(host);
  const ownerToken = randomBytes(16).toString("hex");
  const fixtureDirectory = fs.mkdtempSync(
    path.join(os.homedir(), ".nemoclaw-gateway-resolver-"),
  );
  const resolverSource = path.join(fixtureDirectory, "hosts");
  const ownedLine = `127.0.0.1 ${OPENSHELL_HOST_ALIAS} # nemoclaw-gateway-host-verifier:${ownerToken}`;
  fs.chmodSync(fixtureDirectory, 0o700);
  fs.writeFileSync(resolverSource, `${ownedLine}\n${fs.readFileSync("/etc/hosts", "utf8")}`, {
    mode: 0o600,
  });

  const updateMount = async (operation: "add" | "remove"): Promise<void> => {
    const result = await host.command(
      "sudo",
      [
        "bash",
        "-ceu",
        GATEWAY_HOST_VERIFICATION_NAMESPACE_SCRIPT,
        `gateway-resolver-${operation}`,
        operation,
        String(gatewayPid),
        resolverSource,
        ownerToken,
        GATEWAY_HOST_VERIFICATION_MOUNT_SCRIPT,
      ],
      { artifactName: `${operation}-gateway-host-verifier-alias`, timeoutMs: 60_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `could not ${operation === "add" ? "install" : "remove"} the gateway host verifier alias: ${resultText(result)}`,
      );
    }
  };

  let restored = false;
  const restore = async (): Promise<void> => {
    if (restored) return;
    await updateMount("remove");
    restored = true;
    fs.rmSync(fixtureDirectory, { force: true, recursive: true });
  };
  cleanup.add("remove the OpenShell gateway resolver mount", restore);

  try {
    await updateMount("add");
  } catch (error) {
    await restore();
    throw error;
  }
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
