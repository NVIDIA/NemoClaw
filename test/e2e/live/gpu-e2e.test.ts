// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execTimeout, testTimeout } from "../../helpers/timeouts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import {
  assertAgentExecutionSucceeded,
  assertGpuInstallProofs,
  assertNvidiaAvailable,
  CLI,
  chatContent,
  cleanupGpu,
  cleanupOllama,
  detectOllamaModel,
  ensureOllama,
  env,
  hasExactReadyPhase,
  ollamaProxyTokenFile,
  PROXY_PORT,
  proxyStatus,
  REPO_ROOT,
  readTokenFileChecked,
  restartProxy,
  SANDBOX_NAME,
} from "./gpu-e2e-helpers.ts";
import { assertHermesFollowUpReplies } from "./hermes-cli-adapter-live.ts";

const TIMEOUT_MS = testTimeout(75 * 60_000);
const HERMES_RESPONSE_TIMEOUT_MS = testTimeout(90 * 60_000);

function hermesResponseEnv(): NodeJS.ProcessEnv {
  return env({
    NEMOCLAW_AGENT: "hermes",
  });
}

function loadedOllamaModels(raw: string): string[] {
  const parsed = JSON.parse(raw) as { models?: Array<{ name?: unknown; model?: unknown }> };
  return (parsed.models ?? []).flatMap((entry) => {
    const name = typeof entry.name === "string" ? entry.name : entry.model;
    return typeof name === "string" && name.trim() ? [name.trim()] : [];
  });
}

test(
  "GPU Ollama onboard enables CUDA, auth proxy, and sandbox inference",
  {
    timeout: TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "prepare clean GPU runtime",
        "install Ollama and GPU sandbox",
        "validate GPU runtime status",
        "validate Ollama proxy credential boundary",
        "run sandbox inference.local chat",
        "restart Ollama and recover agent inference",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox, skip }) => {
    await artifacts.target.declare({
      id: "gpu-e2e",
      boundary:
        "GPU host + install.sh Ollama provider + OpenShell sandbox + auth proxy + inference.local",
      credentialBoundary:
        "The proxy token remains host/OpenShell-owned and is absent from sandbox env.",
      remoteInstallerBoundary:
        "The official Ollama installer compatibility path runs before proxy tokens are read; the workflow uses a read-only checkout token and no explicit repository secrets. Replace with a pinned package once the GPU image provides a stable install source.",
      sandboxName: SANDBOX_NAME,
      delegatedLegacyContracts: [
        "uninstall --delete-models remains a separate cleanup lane until it has dedicated Vitest coverage",
      ],
    });

    const cleanupEnv = env();
    cleanup.trackDisposable("stop GPU Ollama processes", async () => {
      const result = await cleanupOllama(host, "cleanup-ollama-processes");
      expect(result.exitCode, resultText(result)).toBe(0);
    });
    cleanup.trackGateway(host, "nemoclaw", {
      artifactName: "cleanup-gateway-destroy-gpu",
      env: cleanupEnv,
      timeoutMs: 60_000,
    });
    cleanup.trackDisposable(`delete OpenShell sandbox ${SANDBOX_NAME}`, () =>
      sandbox.cleanupSandbox(SANDBOX_NAME, {
        artifactName: "cleanup-delete-gpu",
        env: cleanupEnv,
        timeoutMs: 60_000,
      }),
    );
    cleanup.trackSandbox(host, SANDBOX_NAME, {
      artifactName: "cleanup-destroy-gpu",
      env: cleanupEnv,
      timeoutMs: 120_000,
    });
    await cleanupGpu(host, sandbox);

    await runtimeProvider.requireAvailable({
      artifactName: "runtime-info",
      scenarioLabel: "GPU",
    });
    const nvidia = await host.command("nvidia-smi", [], {
      artifactName: "nvidia-smi",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    assertNvidiaAvailable(nvidia, skip);

    await ensureOllama(host);
    const ollamaCleanup = await cleanupOllama(host, "pre-cleanup-ollama");
    expect(ollamaCleanup.exitCode, resultText(ollamaCleanup)).toBe(0);

    progress.phase("install Ollama and GPU sandbox");
    const install = await host.command("bash", ["install.sh", "--non-interactive"], {
      artifactName: "install-gpu-ollama",
      cwd: REPO_ROOT,
      env: env(),
      timeoutMs: execTimeout(55 * 60_000),
    });
    expect(install.exitCode, resultText(install)).toBe(0);
    await artifacts.writeText("install-gpu-ollama.log", resultText(install));

    progress.phase("validate GPU runtime status");
    const status = await host.command("node", [CLI, SANDBOX_NAME, "status"], {
      artifactName: "status-gpu-ollama",
      env: env(),
      timeoutMs: 120_000,
    });
    expect(status.exitCode, resultText(status)).toBe(0);
    expect(resultText(status)).toContain("Sandbox GPU: enabled");
    expect(resultText(status)).toMatch(/CUDA verified|CUDA unverified|last CUDA proof failed/i);
    expect(resultText(status)).not.toMatch(/last CUDA proof failed|CUDA unverified/i);

    const installLog = resultText(install);
    assertGpuInstallProofs(installLog);
    expect(installLog).toContain(
      "Direct sandbox GPU enabled; allowing OpenShell GPU policy enrichment.",
    );
    expect(installLog).not.toContain(
      "Recreating OpenShell Docker sandbox container with NVIDIA GPU access",
    );
    expect(installLog).not.toContain("Docker GPU mode selected");

    const sandboxContainers = await runtimeProvider.command(
      [
        "container",
        "ps",
        "--all",
        "--filter",
        `label=openshell.ai/sandbox-name=${SANDBOX_NAME}`,
        "--format",
        "{{.Names}}\t{{.State}}\t{{.Status}}",
      ],
      {
        artifactName: "gpu-native-route-sandbox-containers",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(sandboxContainers.exitCode, resultText(sandboxContainers)).toBe(0);
    const sandboxContainerInventory = sandboxContainers.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [Names = "", State = "", Status = ""] = line.split("\t");
        return { Names, State, Status };
      });
    expect(
      sandboxContainerInventory,
      `native GPU route must retain exactly one sandbox container; got ${sandboxContainers.stdout}`,
    ).toHaveLength(1);
    const retainedSandboxContainer = sandboxContainerInventory[0];
    expect(retainedSandboxContainer.Names).not.toContain("-nemoclaw-gpu-backup-");
    expect(retainedSandboxContainer.State).toBe("running");
    expect(retainedSandboxContainer.Status).toMatch(/\(healthy\)/i);

    const route = await sandbox.openshell(["inference", "get"], {
      artifactName: "openshell-inference-route",
      env: env(),
      timeoutMs: 30_000,
    });
    expect(route.exitCode, resultText(route)).toBe(0);
    expect(resultText(route)).toMatch(/ollama/i);

    progress.phase("validate Ollama proxy credential boundary");
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

    progress.phase("run sandbox inference.local chat");
    const model = await detectOllamaModel(host);
    const chat = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        `curl -sS --max-time 120 https://inference.local/v1/chat/completions -H 'Content-Type: application/json' --data '${JSON.stringify(
          {
            model,
            messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
            // Keep this assertion about routed inference, not the model's reasoning-token budget.
            reasoning_effort: "none",
            seed: 0,
            temperature: 0,
            max_tokens: 32,
          },
        )}'`,
      ),
      { artifactName: "sandbox-inference-local-chat", env: env(), timeoutMs: 150_000 },
    );
    expect(chat.exitCode, resultText(chat)).toBe(0);
    expect(chatContent(chat.stdout)).toMatch(/pong/i);

    const readySandbox = await sandbox.openshell(["sandbox", "get", SANDBOX_NAME], {
      artifactName: "openshell-sandbox-ready-after-inference",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    expect(readySandbox.exitCode, resultText(readySandbox)).toBe(0);
    expect(
      hasExactReadyPhase(readySandbox.stdout),
      `OpenShell sandbox must be exactly Ready after routed inference; got ${resultText(readySandbox)}`,
    ).toBe(true);

    progress.phase("restart Ollama and recover agent inference");
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
    assertAgentExecutionSucceeded(recovered.stdout, "inference", model);

    const loaded = await host.command("curl", ["-fsS", "http://127.0.0.1:11434/api/ps"], {
      artifactName: "ollama-model-loaded-after-recovery",
      env: env(),
      timeoutMs: 30_000,
    });
    expect(loaded.exitCode, resultText(loaded)).toBe(0);
    expect(loadedOllamaModels(loaded.stdout)).toContain(model);
  },
);

test(
  "Hermes GPU Ollama initial, resumed, and continued replies contain expected answers without tool-call output (#10215)",
  {
    timeout: HERMES_RESPONSE_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "prepare clean GPU Ollama runtime for Hermes",
        "install Hermes with local Ollama inference",
        "run Hermes initial, resumed, and continued replies",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox, skip }) => {
    await artifacts.target.declare({
      id: "gpu-e2e",
      boundary: "Hermes sandbox + GPU Ollama + initial, resumed, and continued CLI replies",
      sandboxName: SANDBOX_NAME,
      expectedReplies: ["acknowledged", "56", "56"],
    });

    const cleanupEnv = hermesResponseEnv();
    cleanup.trackDisposable("stop Hermes response-validation Ollama processes", async () => {
      const result = await cleanupOllama(host, "cleanup-hermes-response-ollama-processes");
      expect(result.exitCode, resultText(result)).toBe(0);
    });
    cleanup.trackGateway(host, "nemoclaw", {
      artifactName: "cleanup-hermes-response-gateway",
      env: cleanupEnv,
      timeoutMs: 60_000,
    });
    cleanup.trackDisposable(`delete OpenShell sandbox ${SANDBOX_NAME}`, () =>
      sandbox.cleanupSandbox(SANDBOX_NAME, {
        artifactName: "cleanup-hermes-response-openshell-sandbox",
        env: cleanupEnv,
        timeoutMs: 60_000,
      }),
    );
    cleanup.trackSandbox(host, SANDBOX_NAME, {
      artifactName: "cleanup-hermes-response-sandbox",
      env: cleanupEnv,
      timeoutMs: 120_000,
    });
    progress.phase("prepare clean GPU Ollama runtime for Hermes");
    await cleanupGpu(host, sandbox);

    await runtimeProvider.requireAvailable({
      artifactName: "runtime-info-hermes-response",
      scenarioLabel: "Hermes GPU response validation",
    });
    const nvidia = await host.command("nvidia-smi", [], {
      artifactName: "nvidia-smi-hermes-response",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    assertNvidiaAvailable(nvidia, skip);

    await ensureOllama(host);
    const ollamaCleanup = await cleanupOllama(host, "pre-cleanup-hermes-response-ollama");
    expect(ollamaCleanup.exitCode, resultText(ollamaCleanup)).toBe(0);

    progress.phase("install Hermes with local Ollama inference");
    const install = await host.command(
      "bash",
      ["install.sh", "--non-interactive", "--fresh", "--yes-i-accept-third-party-software"],
      {
        artifactName: "install-gpu-hermes-ollama",
        cwd: REPO_ROOT,
        env: hermesResponseEnv(),
        timeoutMs: execTimeout(60 * 60_000),
      },
    );
    expect(install.exitCode, resultText(install)).toBe(0);

    progress.phase("run Hermes initial, resumed, and continued replies");
    await assertHermesFollowUpReplies({
      env: hermesResponseEnv(),
      redactionValues: [],
      sandbox,
      sandboxName: SANDBOX_NAME,
    });
  },
);
