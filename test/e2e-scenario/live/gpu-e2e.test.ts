// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Live Vitest replacement for test/e2e/test-gpu-e2e.sh. */

import fs from "node:fs";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { trustedSandboxShellScript, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-gpu-ollama";
validateSandboxName(SANDBOX_NAME);
const PROXY_PORT = process.env.NEMOCLAW_OLLAMA_PROXY_PORT ?? "11435";
const TIMEOUT_MS = 75 * 60_000;

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
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

async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {}
}

function readTokenFileChecked(tokenFile: string): { mode: string; token: string } {
  const fd = fs.openSync(tokenFile, "r");
  try {
    const stat = fs.fstatSync(fd);
    return { mode: (stat.mode & 0o777).toString(8), token: fs.readFileSync(fd, "utf8").trim() };
  } finally {
    fs.closeSync(fd);
  }
}

function chatContent(raw: string): string {
  const parsed = JSON.parse(raw) as {
    choices?: Array<{ message?: Record<string, unknown>; text?: unknown }>;
  };
  const choice = parsed.choices?.[0];
  const message = choice?.message ?? {};
  for (const value of [
    message.content,
    message.reasoning_content,
    message.reasoning,
    choice?.text,
  ]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

test.skipIf(!shouldRunLiveE2EScenarios())(
  "GPU Ollama onboard enables CUDA, auth proxy, and sandbox inference",
  { timeout: TIMEOUT_MS },
  async ({ artifacts, cleanup, host, sandbox, skip }) => {
    await artifacts.writeJson("scenario.json", {
      id: "gpu-e2e",
      legacySource: "test/e2e/test-gpu-e2e.sh",
      boundary:
        "GPU host + install.sh Ollama provider + OpenShell sandbox + auth proxy + inference.local",
      sandboxName: SANDBOX_NAME,
    });

    cleanup.add("destroy GPU Ollama sandbox", async () => {
      await bestEffort(() =>
        host.command("node", [CLI, SANDBOX_NAME, "destroy", "--yes"], {
          artifactName: "cleanup-destroy-gpu",
          env: env(),
          timeoutMs: 120_000,
        }),
      );
      await bestEffort(() =>
        sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
          artifactName: "cleanup-delete-gpu",
          env: env(),
          timeoutMs: 60_000,
        }),
      );
      await bestEffort(() =>
        sandbox.openshell(["gateway", "destroy", "-g", "nemoclaw"], {
          artifactName: "cleanup-gateway-destroy-gpu",
          env: env(),
          timeoutMs: 60_000,
        }),
      );
      await bestEffort(() =>
        host.command(
          "bash",
          [
            "-lc",
            "pkill -f 'ollama serve' 2>/dev/null || true; pkill -f 'ollama-auth-proxy' 2>/dev/null || true",
          ],
          { artifactName: "cleanup-ollama-processes", env: env(), timeoutMs: 30_000 },
        ),
      );
    });

    await bestEffort(() =>
      host.command("node", [CLI, SANDBOX_NAME, "destroy", "--yes"], {
        artifactName: "pre-cleanup-destroy-gpu",
        env: env(),
        timeoutMs: 120_000,
      }),
    );
    await bestEffort(() =>
      sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
        artifactName: "pre-cleanup-delete-gpu",
        env: env(),
        timeoutMs: 60_000,
      }),
    );
    await bestEffort(() =>
      sandbox.openshell(["gateway", "destroy", "-g", "nemoclaw"], {
        artifactName: "pre-cleanup-gateway-destroy-gpu",
        env: env(),
        timeoutMs: 60_000,
      }),
    );

    const docker = await host.command("docker", ["info"], {
      artifactName: "docker-info",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    expect(docker.exitCode, resultText(docker)).toBe(0);
    const nvidia = await host.command("nvidia-smi", [], {
      artifactName: "nvidia-smi",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    if (nvidia.exitCode !== 0) skip(`GPU runner required: ${resultText(nvidia)}`);

    const ollamaExists = await host.command("bash", ["-lc", "command -v ollama"], {
      artifactName: "command-v-ollama",
      env: env(),
      timeoutMs: 30_000,
    });
    if (ollamaExists.exitCode !== 0) {
      const installOllama = await host.command(
        "bash",
        [
          "-lc",
          // Mirrors the legacy live GPU user path by exercising Ollama's
          // official installer before any repository/GitHub credentials are
          // provided to child processes.
          "curl -fsSL https://ollama.com/install.sh | sh",
        ],
        { artifactName: "install-ollama", env: env(), timeoutMs: 10 * 60_000 },
      );
      expect(installOllama.exitCode, resultText(installOllama)).toBe(0);
    }

    await host.command(
      "bash",
      [
        "-lc",
        "systemctl --user stop ollama 2>/dev/null || true; systemctl stop ollama 2>/dev/null || true; pkill -f 'ollama serve' 2>/dev/null || true; pkill -f 'ollama-auth-proxy' 2>/dev/null || true",
      ],
      { artifactName: "pre-cleanup-ollama", env: env(), timeoutMs: 30_000 },
    );

    const install = await host.command("bash", ["install.sh", "--non-interactive"], {
      artifactName: "install-gpu-ollama",
      cwd: REPO_ROOT,
      env: env(),
      timeoutMs: 45 * 60_000,
    });
    expect(install.exitCode, resultText(install)).toBe(0);
    await artifacts.writeText("install-gpu-ollama.log", resultText(install));

    const status = await host.command("node", [CLI, SANDBOX_NAME, "status"], {
      artifactName: "status-gpu-ollama",
      env: env(),
      timeoutMs: 120_000,
    });
    expect(status.exitCode, resultText(status)).toBe(0);
    expect(resultText(status)).toContain("Sandbox GPU: enabled");
    expect(resultText(status)).toMatch(/CUDA verified|CUDA unverified|last CUDA proof failed/i);
    expect(resultText(status)).not.toMatch(/last CUDA proof failed|CUDA unverified/i);

    const log = resultText(install);
    expect(log).toContain("GPU proof passed: nvidia-smi when available");
    expect(log).toContain("GPU proof passed: cuInit(0) via libcuda.so.1");

    const tokenFile = path.join(process.env.HOME ?? "", ".nemoclaw", "ollama-proxy-token");
    const tokenRecord = readTokenFileChecked(tokenFile);
    expect(tokenRecord.mode).toBe("600");
    const token = tokenRecord.token;
    expect(token).not.toBe("");

    const proxyUnauth = await host.command(
      "curl",
      [
        "-s",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "-X",
        "POST",
        `http://127.0.0.1:${PROXY_PORT}/api/generate`,
        "-d",
        "{}",
      ],
      { artifactName: "proxy-unauth-generate-status", env: env(), timeoutMs: 30_000 },
    );
    expect(proxyUnauth.stdout.trim()).toBe("401");
    const wrongToken = await host.command(
      "curl",
      [
        "-s",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "-H",
        "Authorization: Bearer wrong-token",
        `http://127.0.0.1:${PROXY_PORT}/api/tags`,
      ],
      { artifactName: "proxy-wrong-token-tags-status", env: env(), timeoutMs: 30_000 },
    );
    expect(wrongToken.stdout.trim()).toBe("401");
    const correctToken = await host.command(
      "curl",
      [
        "-s",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "-H",
        `Authorization: Bearer ${token}`,
        `http://127.0.0.1:${PROXY_PORT}/api/tags`,
      ],
      {
        artifactName: "proxy-correct-token-tags-status",
        env: env(),
        redactionValues: [token],
        timeoutMs: 30_000,
      },
    );
    expect(correctToken.stdout.trim()).toBe("200");
    const restartProxy = await host.command(
      "bash",
      [
        "-lc",
        `set -euo pipefail
pkill -f 'ollama-auth-proxy' 2>/dev/null || true
sleep 2
if curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 http://127.0.0.1:${PROXY_PORT}/api/tags 2>/dev/null | grep -Eq '^[1-9][0-9]{2}$'; then
  echo 'proxy still alive after kill' >&2
  exit 1
fi
OLLAMA_PROXY_TOKEN="$1" OLLAMA_PROXY_PORT="$2" OLLAMA_BACKEND_PORT=11434 node "$3" >/tmp/nemoclaw-gpu-e2e-restarted-proxy.log 2>&1 &
sleep 2
curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $1" "http://127.0.0.1:$2/api/tags"`,
        "restart-proxy",
        token,
        PROXY_PORT,
        path.join(REPO_ROOT, "scripts", "ollama-auth-proxy.js"),
      ],
      {
        artifactName: "proxy-restart-from-token",
        env: env(),
        redactionValues: [token],
        timeoutMs: 60_000,
      },
    );
    expect(restartProxy.exitCode, resultText(restartProxy)).toBe(0);
    expect(restartProxy.stdout.trim()).toBe("200");

    const model =
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
      ).stdout.trim();
    expect(model).not.toBe("");

    const payload = JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
      max_tokens: 200,
    });
    const direct = await host.command(
      "curl",
      [
        "-s",
        "--max-time",
        "120",
        "-X",
        "POST",
        "http://127.0.0.1:11434/v1/chat/completions",
        "-H",
        "Content-Type: application/json",
        "-d",
        payload,
      ],
      { artifactName: "direct-ollama-chat", env: env(), timeoutMs: 150_000 },
    );
    expect(direct.exitCode, resultText(direct)).toBe(0);
    expect(chatContent(direct.stdout)).toMatch(/PONG/i);

    const sandboxChat = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        `curl -skS --max-time 90 https://inference.local/v1/chat/completions -H 'Content-Type: application/json' -d '${payload.replace(/'/gu, `'\\''`)}'`,
      ),
      { artifactName: "sandbox-inference-local-chat", env: env(), timeoutMs: 150_000 },
    );
    expect(sandboxChat.exitCode, resultText(sandboxChat)).toBe(0);
    expect(chatContent(sandboxChat.stdout)).toMatch(/PONG/i);
  },
);
