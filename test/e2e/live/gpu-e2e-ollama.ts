// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { validateSandboxName } from "../fixtures/clients/sandbox.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

export const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-gpu-ollama";
const DEFAULT_GPU_E2E_MODEL = "qwen3.5:9b";
validateSandboxName(SANDBOX_NAME);
export const PROXY_PORT = tcpPort(process.env.NEMOCLAW_OLLAMA_PROXY_PORT, "11435");

function tcpPort(value: string | undefined, fallback: string): string {
  const raw = value ?? fallback;
  if (!/^[1-9][0-9]*$/u.test(raw)) throw new Error(`invalid TCP port: ${raw}`);
  const port = Number.parseInt(raw, 10);
  if (port < 1 || port > 65_535) throw new Error(`invalid TCP port: ${raw}`);
  return raw;
}

export function env(
  extra: NodeJS.ProcessEnv = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(base),
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_MODEL: base.NEMOCLAW_MODEL ?? DEFAULT_GPU_E2E_MODEL,
    NEMOCLAW_PROVIDER: "ollama",
    NEMOCLAW_OLLAMA_PROXY_PORT: PROXY_PORT,
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
    ...extra,
  };
}

export async function cleanupOllama(
  host: HostCliClient,
  artifactName: string,
): Promise<ShellProbeResult> {
  // Login-shell logout hooks can turn successful cleanup into a failed command.
  return await host.command("bash", ["-c", ollamaCleanupScript()], {
    artifactName,
    env: env(),
    timeoutMs: 30_000,
  });
}

export function ollamaCleanupScript(listenerPort = 11434): string {
  if (!Number.isInteger(listenerPort) || listenerPort < 1 || listenerPort > 65_535) {
    throw new Error(`invalid Ollama listener port: ${String(listenerPort)}`);
  }
  return `set -euo pipefail
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user stop ollama.service >/dev/null 2>&1 || true
  if systemctl cat ollama.service >/dev/null 2>&1; then
    if [ "$(id -u)" -eq 0 ]; then
      systemctl stop ollama.service
    elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
      sudo -n systemctl stop ollama.service
    else
      echo 'Ollama system service exists but passwordless sudo is unavailable' >&2
      exit 1
    fi
  fi
fi
cleanup_status=0
for pattern in '[o]llama-auth-proxy' '[o]llama serve'; do
  rc=0
  pkill -f "$pattern" >/dev/null 2>&1 || rc=$?
  case "$rc" in
    0|1) ;;
    *) cleanup_status="$rc" ;;
  esac
done
if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  rc=0
  sudo -n pkill -f '[o]llama serve' >/dev/null 2>&1 || rc=$?
  case "$rc" in
    0|1) ;;
    *) cleanup_status="$rc" ;;
  esac
fi

# Manual daemons can close their listener before finishing GPU shutdown.
# Keep the wait inside the caller's 30-second command budget.
for ((attempt = 0; attempt < 50; attempt++)); do
  sleep 0.1
  if ! pgrep -f '[o]llama serve' >/dev/null 2>&1; then
    if (exec 3<>/dev/tcp/127.0.0.1/${listenerPort}) 2>/dev/null; then
      echo 'Ollama cleanup left a listener on 127.0.0.1:${listenerPort}' >&2
      exit 1
    fi
    exit "$cleanup_status"
  fi
done

echo 'Ollama cleanup left a daemon process' >&2
pgrep -af '[o]llama serve' >&2 || true
exit 1`;
}
