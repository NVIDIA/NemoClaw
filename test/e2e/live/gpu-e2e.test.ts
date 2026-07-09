// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { parseOpenClawAgentText } from "./common-egress-agent-helpers.ts";
import {
  assertGpuInstallProofs,
  assertNvidiaAvailable,
  CLI,
  chatContent,
  cleanupGpu,
  cleanupOllama,
  detectOllamaModel,
  ensureOllama,
  env,
  ollamaProxyTokenFile,
  openClawModelConfigProjectionScript,
  PROXY_PORT,
  proxyStatus,
  REPO_ROOT,
  readTokenFileChecked,
  restartProxy,
  SANDBOX_NAME,
} from "./gpu-e2e-helpers.ts";

const TIMEOUT_MS = 75 * 60_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function modelIdentifier(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? (value[key] as string) : undefined;
}

function assertSmallContextCompactionPolicy(configText: string): void {
  const config = asRecord(JSON.parse(configText));
  const agents = asRecord(config?.agents);
  const defaults = asRecord(agents?.defaults);
  const modelDefaults = asRecord(defaults?.model);
  const primary = modelIdentifier(modelDefaults ?? {}, "primary");
  const compaction = asRecord(defaults?.compaction);
  const modelsRoot = asRecord(config?.models);
  const providers = asRecord(modelsRoot?.providers);
  const primaryWithoutProvider = primary?.startsWith("inference/")
    ? primary.slice("inference/".length)
    : primary;
  const model = Object.values(providers ?? {})
    .flatMap((provider) => {
      const models = asRecord(provider)?.models;
      return Array.isArray(models) ? models : [];
    })
    .map(asRecord)
    .find((candidate) => {
      const identifiers =
        candidate && primary && primaryWithoutProvider
          ? ["id", "name", "label"].flatMap((key) => {
              const value = modelIdentifier(candidate, key);
              return value ? [value] : [];
            })
          : [];
      return identifiers.some(
        (identifier) =>
          identifier === primary ||
          identifier === primaryWithoutProvider ||
          identifier === `inference/${primaryWithoutProvider}`,
      );
    });

  expect(primary, "OpenClaw config must declare the active model").toBeTruthy();
  expect(model, `OpenClaw config must include active Ollama model ${primary}`).toBeDefined();
  expect(typeof model?.contextWindow).toBe("number");
  expect(typeof model?.maxTokens).toBe("number");
  const contextWindow = model?.contextWindow as number;
  const maxTokens = model?.maxTokens as number;
  expect(
    contextWindow,
    `active Ollama model ${primary} must stay on the small-context lane`,
  ).toBeLessThanOrEqual(28_000);
  const expectedReserve = Math.min(maxTokens, Math.max(0, contextWindow - 8_000));

  expect(compaction).toEqual({
    reserveTokens: expectedReserve,
    reserveTokensFloor: expectedReserve,
  });
}

function loadedOllamaModels(raw: string): string[] {
  const parsed = JSON.parse(raw) as { models?: Array<{ name?: unknown; model?: unknown }> };
  return (parsed.models ?? []).flatMap((entry) => {
    const name = typeof entry.name === "string" ? entry.name : entry.model;
    return typeof name === "string" && name.trim() ? [name.trim()] : [];
  });
}

test("GPU Ollama onboard enables CUDA, auth proxy, and sandbox inference", {
  timeout: TIMEOUT_MS,
}, async ({ artifacts, cleanup, host, sandbox, skip }) => {
  await artifacts.target.declare({
    id: "gpu-e2e",
    boundary:
      "GPU host + install.sh Ollama provider + OpenShell sandbox + auth proxy + inference.local",
    credentialBoundary:
      "The proxy token remains host/OpenShell-owned and is absent from sandbox env and uploaded config evidence.",
    remoteInstallerBoundary:
      "The official Ollama installer compatibility path runs before proxy tokens are read; the workflow uses a read-only checkout token and no explicit repository secrets. Replace with a pinned package once the GPU image provides a stable install source.",
    sandboxName: SANDBOX_NAME,
    delegatedLegacyContracts: [
      "uninstall --delete-models remains a separate cleanup lane until it has dedicated Vitest coverage",
      "The #5468 interactive TUI first-turn smoke remains waived until a TUI fixture exists; this Vitest asserts the baked compaction budget directly",
    ],
  });

  cleanup.add("destroy GPU Ollama sandbox", () => cleanupGpu(host, sandbox));
  await cleanupGpu(host, sandbox);

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
  assertNvidiaAvailable(nvidia, skip);

  await ensureOllama(host);
  await cleanupOllama(host, "pre-cleanup-ollama");

  const install = await host.command("bash", ["install.sh", "--non-interactive"], {
    artifactName: "install-gpu-ollama",
    cwd: REPO_ROOT,
    env: env(),
    timeoutMs: 55 * 60_000,
  });
  expect(install.exitCode, resultText(install)).toBe(0);
  await artifacts.writeText("install-gpu-ollama.log", resultText(install));

  const config = await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript(openClawModelConfigProjectionScript()),
    { artifactName: "sandbox-openclaw-model-config", env: env(), timeoutMs: 30_000 },
  );
  expect(config.exitCode, resultText(config)).toBe(0);
  await artifacts.writeText("openclaw-model-config.json", config.stdout);
  assertSmallContextCompactionPolicy(config.stdout);

  const status = await host.command("node", [CLI, SANDBOX_NAME, "status"], {
    artifactName: "status-gpu-ollama",
    env: env(),
    timeoutMs: 120_000,
  });
  expect(status.exitCode, resultText(status)).toBe(0);
  expect(resultText(status)).toContain("Sandbox GPU: enabled");
  expect(resultText(status)).toMatch(/CUDA verified|CUDA unverified|last CUDA proof failed/i);
  expect(resultText(status)).not.toMatch(/last CUDA proof failed|CUDA unverified/i);

  assertGpuInstallProofs(resultText(install));
  const route = await sandbox.openshell(["inference", "get"], {
    artifactName: "openshell-inference-route",
    env: env(),
    timeoutMs: 30_000,
  });
  expect(route.exitCode, resultText(route)).toBe(0);
  expect(resultText(route)).toMatch(/ollama/i);

  const tokenRecord = readTokenFileChecked(ollamaProxyTokenFile());
  expect(tokenRecord.mode).toBe("600");
  const token = tokenRecord.token;
  expect(token).not.toBe("");

  const proxyUnauth = await host.command(
    "curl",
    ["-sS", "-o", "/dev/null", "-w", "%{http_code}", `http://127.0.0.1:${PROXY_PORT}/api/tags`],
    { artifactName: "ollama-proxy-unauthorized", env: env(), timeoutMs: 30_000 },
  );
  expect(proxyUnauth.exitCode, resultText(proxyUnauth)).toBe(0);
  expect(proxyUnauth.stdout).toBe("401");

  const proxyAuth = await host.command(
    "curl",
    ["-sS", "-H", `Authorization: Bearer ${token}`, `http://127.0.0.1:${PROXY_PORT}/api/tags`],
    {
      artifactName: "ollama-proxy-authorized",
      env: env(),
      redactionValues: [token],
      timeoutMs: 30_000,
    },
  );
  expect(proxyAuth.exitCode, resultText(proxyAuth)).toBe(0);
  expect(proxyAuth.stdout).toMatch(/models|name/i);

  const proxyBefore = await proxyStatus(host, token, "proxy-status-before-restart");
  expect(proxyBefore.exitCode, resultText(proxyBefore)).toBe(0);
  await restartProxy(host, token);
  const proxyAfter = await proxyStatus(host, token, "proxy-status-after-restart");
  expect(proxyAfter.exitCode, resultText(proxyAfter)).toBe(0);

  const sandboxToken = await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript("printenv OLLAMA_API_KEY 2>/dev/null || true"),
    { artifactName: "sandbox-ollama-api-key", env: env(), timeoutMs: 30_000 },
  );
  expect(sandboxToken.exitCode, resultText(sandboxToken)).toBe(0);
  expect(
    sandboxToken.stdout.trim(),
    "OpenShell owns proxy authentication; the host proxy token must not enter sandbox env",
  ).toBe("");

  const model = await detectOllamaModel(host);
  const chat = await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript(
      `curl -sS --max-time 120 https://inference.local/v1/chat/completions -H 'Content-Type: application/json' --data '${JSON.stringify(
        {
          model,
          messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
          max_tokens: 32,
        },
      )}'`,
    ),
    { artifactName: "sandbox-inference-local-chat", env: env(), timeoutMs: 150_000 },
  );
  expect(chat.exitCode, resultText(chat)).toBe(0);
  expect(chatContent(chat.stdout)).toMatch(/pong/i);

  const restart = await host.command(
    "bash",
    [
      "-c",
      `set -euo pipefail
if sudo -n systemctl restart ollama 2>/dev/null; then
  restart_mode=system
elif systemctl --user restart ollama 2>/dev/null; then
  restart_mode=user
else
  pkill -f '[o]llama serve' 2>/dev/null || true
  OLLAMA_HOST=127.0.0.1:11434 nohup ollama serve >/tmp/nemoclaw-gpu-e2e-ollama.log 2>&1 &
  restart_mode=manual
fi
for attempt in $(seq 1 60); do
  tags_json="$(curl -fsS --connect-timeout 2 http://127.0.0.1:11434/api/tags 2>/dev/null || true)"
  if [ -n "$tags_json" ]; then
    ps_json="$(curl -fsS --connect-timeout 2 http://127.0.0.1:11434/api/ps 2>/dev/null || true)"
    if [ -n "$ps_json" ]; then
      printf 'restart_mode=%s\n%s\n' "$restart_mode" "$ps_json"
      exit 0
    fi
  fi
  sleep 1
done
echo 'Ollama did not become ready after restart' >&2
exit 1`,
    ],
    { artifactName: "ollama-daemon-restart-unloaded", env: env(), timeoutMs: 90_000 },
  );
  expect(restart.exitCode, resultText(restart)).toBe(0);
  const restartLines = restart.stdout.trim().split("\n");
  expect(restartLines[0]).toMatch(/^restart_mode=(system|user|manual)$/u);
  expect(loadedOllamaModels(restartLines.slice(1).join("\n"))).toEqual([]);

  const recovered = await host.nemoclaw(
    [
      SANDBOX_NAME,
      "agent",
      "--agent",
      "main",
      "--json",
      "--session-id",
      `e2e-gpu-ollama-restart-${Date.now()}-${process.pid}`,
      "-m",
      "Reply with exactly one word: PONG",
    ],
    {
      artifactName: "agent-after-ollama-daemon-restart",
      env: env(),
      timeoutMs: 12 * 60_000,
    },
  );
  expect(recovered.exitCode, resultText(recovered)).toBe(0);
  expect(resultText(recovered)).toContain("Checking Ollama model readiness after daemon restart");
  expect(resultText(recovered)).toContain(`Ollama model '${model}' is loaded and ready.`);
  expect(parseOpenClawAgentText(recovered.stdout)).toMatch(/pong/i);

  const loaded = await host.command("curl", ["-fsS", "http://127.0.0.1:11434/api/ps"], {
    artifactName: "ollama-model-loaded-after-recovery",
    env: env(),
    timeoutMs: 30_000,
  });
  expect(loaded.exitCode, resultText(loaded)).toBe(0);
  expect(loadedOllamaModels(loaded.stdout)).toContain(model);
});
