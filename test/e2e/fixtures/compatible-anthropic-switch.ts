// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HostCliClient } from "./clients/host.ts";
import { resultText } from "./clients/index.ts";

export const COMPATIBLE_ANTHROPIC_PROVIDER = "compatible-anthropic-endpoint";
export const COMPATIBLE_ANTHROPIC_CREDENTIAL_ENV = "COMPATIBLE_ANTHROPIC_API_KEY";
const DEFAULT_COMPATIBLE_ANTHROPIC_CREDENTIAL = "test-compatible-anthropic-key";
const HOST_VERIFICATION_HOSTS_PATH = "/etc/hosts";

export const HOST_VERIFICATION_NAMESPACE_SCRIPT = [
  "set -euo pipefail",
  "",
  'hosts_path="$1"',
  'run_uid="$2"',
  'run_gid="$3"',
  "shift 3",
  'alias_name="host.openshell.internal"',
  "",
  '[[ "$run_uid" =~ ^[0-9]+$ ]] || { echo "invalid host verifier user ID" >&2; exit 2; }',
  '[[ "$run_gid" =~ ^[0-9]+$ ]] || { echo "invalid host verifier group ID" >&2; exit 2; }',
  '[[ "$#" -gt 0 ]] || { echo "host verifier command is required" >&2; exit 2; }',
  '[[ -f "$hosts_path" && ! -L "$hosts_path" ]] || { echo "host resolver file is not a regular file" >&2; exit 2; }',
  'command -v mount >/dev/null 2>&1 || { echo "mount is required for scoped host resolution" >&2; exit 2; }',
  'command -v setpriv >/dev/null 2>&1 || { echo "setpriv is required for scoped host resolution" >&2; exit 2; }',
  "",
  'private_hosts="$(mktemp)"',
  "trap 'rm -f \"$private_hosts\"' EXIT",
  'cp --preserve=mode,ownership,timestamps -- "$hosts_path" "$private_hosts"',
  "printf '\\n127.0.0.1 %s\\n' \"$alias_name\" >> \"$private_hosts\"",
  "",
  "# The private mount keeps the fixture alias inside this command's mount namespace.",
  "# The host resolver file remains available to unrelated writers.",
  'mount --make-rprivate /',
  'mount --bind "$private_hosts" "$hosts_path"',
  "",
  'if [[ "$(id -u)" == "$run_uid" && "$(id -g)" == "$run_gid" ]]; then',
  '  "$@"',
  "else",
  '  setpriv --reuid="$run_uid" --regid="$run_gid" --init-groups -- "$@"',
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

export async function withHostVerificationLoopbackAlias<T>(
  host: HostCliClient,
  run: (scopedHost: HostCliClient) => Promise<T>,
): Promise<T> {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) {
    throw new Error("scoped host verification requires Linux user and group IDs");
  }
  const scopedHost = {
    command: (
      command: string,
      args: string[] = [],
      options: Parameters<HostCliClient["command"]>[2] = {},
    ) =>
      host.command(
        "sudo",
        [
          "--preserve-env",
          "unshare",
          "--mount",
          "--fork",
          "--",
          "bash",
          "-ceu",
          HOST_VERIFICATION_NAMESPACE_SCRIPT,
          "host-verifier-namespace",
          HOST_VERIFICATION_HOSTS_PATH,
          String(uid),
          String(gid),
          command,
          ...args,
        ],
        options,
      ),
  } as HostCliClient;
  return await run(scopedHost);
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
