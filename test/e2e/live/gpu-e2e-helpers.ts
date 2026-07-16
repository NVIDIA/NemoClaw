// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { type SandboxClient, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect } from "../fixtures/e2e-test.ts";
import { CLI_ENTRYPOINT, REPO_ROOT } from "../fixtures/paths.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

export { REPO_ROOT };

export const CLI = CLI_ENTRYPOINT;
export const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-gpu-ollama";
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
    NEMOCLAW_PROVIDER: "ollama",
    NEMOCLAW_OLLAMA_PROXY_PORT: PROXY_PORT,
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
    ...extra,
  };
}

function isShellProbeResult(value: unknown): value is ShellProbeResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "exitCode" in value &&
    (typeof (value as { exitCode?: unknown }).exitCode === "number" ||
      (value as { exitCode?: unknown }).exitCode === null)
  );
}

export async function preCleanBestEffort(
  label: string,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    const result = await run();
    if (isShellProbeResult(result) && result.exitCode !== 0) {
      console.warn(
        `[gpu-e2e cleanup] ${label} exited ${String(result.exitCode)}: ${resultText(result)}`,
      );
    }
  } catch (error) {
    console.warn(
      `[gpu-e2e cleanup] ${label} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function ollamaProxyTokenFile(): string {
  const home = process.env.HOME;
  if (!home) throw new Error("HOME environment variable is required");
  return path.join(home, ".nemoclaw", "ollama-proxy-token");
}

export function openClawModelConfigProjectionScript(
  configPath = "/sandbox/.openclaw/openclaw.json",
): string {
  if (!configPath.startsWith("/") || /[\0\r\n]/u.test(configPath)) {
    throw new Error(`invalid OpenClaw config path: ${configPath}`);
  }
  const pathLiteral = JSON.stringify(configPath);
  return `node - <<'NODE'
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync(${pathLiteral}, "utf8"));
process.stdout.write(JSON.stringify({ agents: config.agents, models: config.models }));
NODE`;
}

export function readTokenFileChecked(tokenFile: string): { mode: string; token: string } {
  const fd = fs.openSync(tokenFile, "r");
  try {
    const stat = fs.fstatSync(fd);
    return { mode: (stat.mode & 0o777).toString(8), token: fs.readFileSync(fd, "utf8").trim() };
  } finally {
    fs.closeSync(fd);
  }
}

export function chatContent(raw: string): string {
  const parsed = JSON.parse(raw) as {
    choices?: Array<{ message?: Record<string, unknown>; text?: unknown }>;
  };
  const choice = parsed.choices?.[0];
  const message = choice?.message ?? {};
  return (
    [message.content, message.reasoning_content, message.reasoning, choice?.text]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0)
      ?.trim() ?? ""
  );
}

export async function cleanupGpu(host: HostCliClient, sandbox: SandboxClient): Promise<void> {
  await preCleanBestEffort("destroy GPU sandbox", () =>
    host.command("node", [CLI, SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: "cleanup-destroy-gpu",
      env: env(),
      timeoutMs: 120_000,
    }),
  );
  await preCleanBestEffort("delete OpenShell sandbox", () =>
    sandbox.cleanupSandbox(SANDBOX_NAME, {
      artifactName: "cleanup-delete-gpu",
      env: env(),
      timeoutMs: 60_000,
    }),
  );
  await preCleanBestEffort("destroy OpenShell gateway", () =>
    sandbox.openshell(["gateway", "destroy", "-g", "nemoclaw"], {
      artifactName: "cleanup-gateway-destroy-gpu",
      env: env(),
      timeoutMs: 60_000,
    }),
  );
  await cleanupOllama(host, "cleanup-ollama-processes");
}

export async function cleanupOllama(
  host: HostCliClient,
  artifactName: string,
): Promise<ShellProbeResult> {
  return await host.command(
    "bash",
    [
      "-lc",
      "systemctl --user stop ollama 2>/dev/null || true; systemctl stop ollama 2>/dev/null || true; pkill -f '[o]llama serve' 2>/dev/null || true; pkill -f '[o]llama-auth-proxy' 2>/dev/null || true",
    ],
    { artifactName, env: env(), timeoutMs: 30_000 },
  );
}

export function assertNvidiaAvailable(
  result: ShellProbeResult,
  skip: (note?: string) => never,
): void {
  result.exitCode === 0 || process.env.GITHUB_ACTIONS === "true"
    ? undefined
    : skip(`GPU runner required: ${resultText(result)}`);
  result.exitCode === 0 ||
    process.env.GITHUB_ACTIONS !== "true" ||
    (() => {
      throw new Error(`GPU runner must provide nvidia-smi: ${resultText(result)}`);
    })();
}

export async function ensureOllama(host: HostCliClient): Promise<void> {
  const ollamaExists = await host.command("bash", ["-lc", "command -v ollama"], {
    artifactName: "command-v-ollama",
    env: env(),
    timeoutMs: 30_000,
  });
  const missing = ollamaExists.exitCode !== 0;
  missing &&
    expect(
      (
        await host.command(
          "bash",
          [
            "-lc",
            // Mirrors the legacy live GPU user path by exercising Ollama's official installer before secrets are passed.
            "curl -fsSL https://ollama.com/install.sh | sh",
          ],
          { artifactName: "install-ollama", env: env(), timeoutMs: 10 * 60_000 },
        )
      ).exitCode,
    ).toBe(0);
}

export function assertGpuInstallProofs(log: string): void {
  expect(log).toContain("GPU proof passed: nvidia-smi when available");
  expect(log).toContain("GPU proof passed: /proc/<pid>/task/<tid>/comm write");
  expect(log).toContain("GPU proof passed: cuInit(0) via libcuda.so.1");
  log.includes("Docker GPU mode selected") &&
    expect(log).toContain("GPU sandbox runtime reached local inference");
}

export async function proxyStatus(
  host: HostCliClient,
  token?: string,
  artifactName = "proxy-status",
): Promise<ShellProbeResult> {
  const args = ["-s", "-o", "/dev/null", "-w", "%{http_code}"];
  token && args.push("-H", `Authorization: Bearer ${token}`);
  args.push(`http://127.0.0.1:${PROXY_PORT}/api/tags`);
  return await host.command("curl", args, {
    artifactName,
    env: env(),
    redactionValues: token ? [token] : undefined,
    timeoutMs: 30_000,
  });
}

export async function restartProxy(host: HostCliClient, token: string): Promise<ShellProbeResult> {
  return await host.command(
    "bash",
    [
      "-lc",
      `set -euo pipefail
token="\${NEMOCLAW_GPU_E2E_PROXY_TOKEN:?missing proxy token}"
proxy_pid="$(lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -n1 || true)"
if [ -n "$proxy_pid" ]; then
  if ! ps -p "$proxy_pid" -o args= | grep -q '[o]llama-auth-proxy'; then
    echo "port $1 is not owned by ollama-auth-proxy (pid $proxy_pid)" >&2
    exit 1
  fi
  kill "$proxy_pid" 2>/dev/null || true
else
  pkill -f '[o]llama-auth-proxy' 2>/dev/null || true
fi
sleep 2
if curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 "http://127.0.0.1:$1/api/tags" 2>/dev/null | grep -Eq '^[1-9][0-9]{2}$'; then
  echo 'proxy still alive after kill' >&2
  exit 1
fi
OLLAMA_PROXY_TOKEN="$token" OLLAMA_PROXY_PORT="$1" OLLAMA_BACKEND_PORT=11434 node "$2" >/tmp/nemoclaw-gpu-e2e-restarted-proxy.log 2>&1 &
sleep 2
curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" "http://127.0.0.1:$1/api/tags"`,
      "restart-proxy",
      PROXY_PORT,
      path.join(REPO_ROOT, "scripts", "ollama-auth-proxy.mts"),
    ],
    {
      artifactName: "proxy-restart-from-token",
      env: env({ NEMOCLAW_GPU_E2E_PROXY_TOKEN: token }),
      redactionValues: [token],
      timeoutMs: 60_000,
    },
  );
}

export async function detectOllamaModel(host: HostCliClient): Promise<string> {
  return (
    process.env.NEMOCLAW_MODEL ||
    (
      await host.command(
        "bash",
        [
          "-lc",
          'curl -sf http://127.0.0.1:11434/api/tags | python3 -c \'import json,sys; m=json.load(sys.stdin).get("models",[]); print(m[0]["name"] if m else "")\'',
        ],
        { artifactName: "detect-ollama-model", env: env(), timeoutMs: 30_000 },
      )
    ).stdout.trim()
  );
}
