// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXPORTED_VLLM_PROFILE_ID } from "../../../src/lib/config/model.ts";
import type {
  V1Alpha1OllamaProxyService,
  V1Alpha1VllmService,
} from "../../../src/lib/config/v1alpha1-export.ts";
import { cleanupLocalModelRuntimes } from "../../../src/lib/inference/local-model-profile/cleanup.ts";
import { HOST_LOCAL_VLLM_CONTAINER_NAME } from "../../../src/lib/inference/serving/vllm-host-local-lifecycle.ts";
import { loadManagedVllmApiKey } from "../../../src/lib/inference/vllm-api-key.ts";
import { execTimeout, testTimeout } from "../../helpers/timeouts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { parseConfigExport } from "../fixtures/phases/config-export-validation.ts";
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
  startAttachedOllama,
  waitForAttachedOllama,
} from "./gpu-e2e-helpers.ts";
import { assertHermesFollowUpReplies } from "./hermes-cli-adapter-live.ts";

const TIMEOUT_MS = testTimeout(75 * 60_000);
const HERMES_RESPONSE_TIMEOUT_MS = testTimeout(90 * 60_000);
const VLLM_EXPORT_TIMEOUT_MS = testTimeout(90 * 60_000);

function vllmExportEnv(): NodeJS.ProcessEnv {
  return env({
    NEMOCLAW_AGENT: "openclaw",
    NEMOCLAW_MODEL: "",
    NEMOCLAW_PROVIDER: "",
    NEMOCLAW_SANDBOX_GPU: "0",
    NEMOCLAW_SANDBOX_GPU_DEVICE: "",
    NEMOCLAW_SERVING_PRESET: "",
    NEMOCLAW_VLLM_EXTRA_ARGS_JSON: "",
    NEMOCLAW_VLLM_MODEL: "",
    NEMOCLAW_VLLM_PORT: "18000",
    NEMOCLAW_WEB_SEARCH_PROVIDER: "none",
  });
}

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
    await cleanupOllama(host, "pre-cleanup-ollama");

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
    expect(resultText(status)).toContain("Sandbox GPU: enabled");
    expect(resultText(status)).toContain("CUDA verified");

    const installLog = resultText(install);
    assertGpuInstallProofs(installLog);
    expect(installLog).not.toMatch(
      /Recreating OpenShell Docker sandbox container with NVIDIA GPU access|Docker GPU mode selected/u,
    );

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
    expect(proxyAuth.stdout).toMatch(/models|name/i);

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
    expect(chatContent(chat.stdout)).toMatch(/pong/i);

    const readySandbox = await sandbox.openshell(["sandbox", "get", SANDBOX_NAME], {
      artifactName: "openshell-sandbox-ready-after-inference",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
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
    assertAgentExecutionSucceeded(recovered.stdout, "inference", model);

    const loaded = await host.command("curl", ["-fsS", "http://127.0.0.1:11434/api/ps"], {
      artifactName: "ollama-model-loaded-after-recovery",
      env: env(),
      timeoutMs: 30_000,
    });
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

test(
  "OpenClaw exports attached Ollama through a named proxy service (#11435, #11977, #12012)",
  {
    timeout: TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "prepare the Ollama export host",
        "onboard OpenClaw without sandbox GPU",
        "attach the export daemon",
        "export the attached Ollama configuration",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox }) => {
    await artifacts.target.declare({
      id: "gpu-e2e",
      boundary:
        "native Linux Docker + attached Ollama daemon + NemoClaw proxy + managed OpenClaw + SDK configuration export",
      credentialBoundary:
        "The existing proxy owner authenticates observation; exported inference providers omit credentials and internal endpoints.",
    });
    const exportEnv = env({
      NEMOCLAW_AGENT: "openclaw",
      NEMOCLAW_SANDBOX_GPU: "0",
      NEMOCLAW_SANDBOX_GPU_DEVICE: "",
      NEMOCLAW_OLLAMA_PORT: "11439",
      NEMOCLAW_MODEL: "qwen2.5:0.5b",
      NEMOCLAW_WEB_SEARCH_PROVIDER: "none",
      OLLAMA_HOST: "127.0.0.1:11439",
      OLLAMA_CONTEXT_LENGTH: "32768",
    });
    let daemonOwner: ReturnType<typeof startAttachedOllama> | undefined;
    cleanup.trackDisposable("stop Ollama processes after export qualification", async () => {
      const result = await cleanupOllama(host, "export-cleanup-ollama-processes");
      expect(result.exitCode, resultText(result)).toBe(0);
    });
    cleanup.trackDisposable("stop the fixture-owned Ollama daemon", () => daemonOwner?.terminate());
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-export-"));
    cleanup.trackDisposable("remove private Ollama export documents", () =>
      fs.rmSync(directory, { recursive: true, force: true }),
    );
    await cleanupGpu(host, sandbox);
    await runtimeProvider.requireAvailable({
      artifactName: "export-runtime-info",
      scenarioLabel: "attached Ollama export",
    });
    await ensureOllama(host);
    await cleanupOllama(host, "export-stop-default-ollama");
    const preparedModel = await host.command(
      "bash",
      [
        "-c",
        `set -e
sudo -n systemctl start ollama.service
curl -q --noproxy '*' -fsS --max-time 2 --retry 20 --retry-connrefused --retry-delay 1 --retry-max-time 60 http://127.0.0.1:11434/api/tags
exec ollama pull qwen2.5:0.5b`,
      ],
      {
        artifactName: "export-prepare-installed-model",
        env: env({ OLLAMA_HOST: "127.0.0.1:11434" }),
        timeoutMs: execTimeout(20 * 60000),
      },
    );
    expect(preparedModel.exitCode, resultText(preparedModel)).toBe(0);
    cleanup.trackGateway(host, "nemoclaw", {
      artifactName: "export-cleanup-gateway",
      env: exportEnv,
      timeoutMs: 60000,
    });
    cleanup.trackDisposable("delete the export sandbox", () =>
      sandbox.cleanupSandbox(SANDBOX_NAME, {
        artifactName: "export-cleanup-openshell",
        env: exportEnv,
        timeoutMs: 60000,
      }),
    );
    cleanup.trackSandbox(host, SANDBOX_NAME, {
      artifactName: "export-cleanup-sandbox",
      env: exportEnv,
      timeoutMs: 120000,
    });
    progress.phase("onboard OpenClaw without sandbox GPU");
    const onboard = await host.command(
      "node",
      [CLI, "onboard", "--fresh", "--non-interactive", "--yes-i-accept-third-party-software"],
      {
        artifactName: "export-onboard-ollama",
        cwd: REPO_ROOT,
        env: exportEnv,
        timeoutMs: execTimeout(20 * 60000),
      },
    );
    expect(onboard.exitCode, resultText(onboard)).toBe(0);
    progress.phase("attach the export daemon");
    // Onboarding restarts the installer service on the same port; stop it before the child binds.
    const stoppedService = await host.command(
      "sudo",
      ["-n", "systemctl", "stop", "ollama.service"],
      {
        artifactName: "export-stop-competing-service",
        env: exportEnv,
        timeoutMs: 60000,
      },
    );

    expect(stoppedService.exitCode, resultText(stoppedService)).toBe(0);
    daemonOwner = startAttachedOllama(progress, exportEnv);
    await waitForAttachedOllama(host, exportEnv);
    await host.command("ollama", ["pull", "qwen2.5:0.5b"], {
      artifactName: "export-prepare-attached-model",
      env: exportEnv,
      timeoutMs: execTimeout(20 * 60000),
    });
    const tags = await host.command(
      "curl",
      ["-q", "--noproxy", "*", "-fsS", "--max-time", "5", "http://127.0.0.1:11439/api/tags"],
      { artifactName: "export-attached-model-identity", env: exportEnv, timeoutMs: 10000 },
    );
    const model = (
      JSON.parse(tags.stdout) as { models: Array<{ name: string; digest: string }> }
    ).models.find(({ name }) => name === "qwen2.5:0.5b");
    progress.phase("export the attached Ollama configuration");
    const firstPath = path.join(directory, "first.yaml");
    const exported = await host.command(
      "node",
      [CLI, "config", "export", SANDBOX_NAME, "--output", firstPath, "--json"],
      { artifactName: "export-ollama-first", cwd: REPO_ROOT, env: exportEnv, timeoutMs: 60000 },
    );
    expect(exported.exitCode, resultText(exported)).toBe(0);
    const firstYaml = fs.readFileSync(firstPath, "utf8");
    const first = parseConfigExport(firstYaml);
    const service = first.spec.services?.["ollama-auth"] as V1Alpha1OllamaProxyService | undefined;
    expect(service?.image).toBeNull();
    expect(service?.upstream.model.digest).toBe(model!.digest.replace(/^sha256:/u, ""));
    const proxyToken = readTokenFileChecked(ollamaProxyTokenFile()).token;
    artifacts.addRedactionValues([proxyToken]);
    expect(
      firstYaml.includes(proxyToken) ||
        /credential|NEMOCLAW_|openshell:resolve:env/u.test(firstYaml),
    ).toBe(false);
    await artifacts.writeText("ollama-config-export.yaml", firstYaml);
  },
);

test(
  "OpenClaw exports the fixed managed vLLM profile through a named service (#12012)",
  {
    timeout: VLLM_EXPORT_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "qualify the managed vLLM export host",
        "onboard the fixed managed vLLM profile",
        "export the managed vLLM configuration",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox }) => {
    const exportEnv = vllmExportEnv();
    let managedVllmOnboarded = false;
    await artifacts.target.declare({
      id: "gpu-e2e",
      boundary:
        "native Linux Docker + fixed catalog-owned managed vLLM + managed OpenClaw + SDK configuration export",
      credentialBoundary:
        "The managed vLLM bearer key remains in owner-only host state and is registered with the artifact redactor before evidence publication.",
      profileId: EXPORTED_VLLM_PROFILE_ID,
      sandboxName: SANDBOX_NAME,
    });

    progress.phase("qualify the managed vLLM export host");
    await runtimeProvider.requireAvailable({
      artifactName: "vllm-export-runtime-info",
      scenarioLabel: "managed vLLM export",
    });
    const preflight = await host.command(
      "docker",
      ["inspect", "--format", "{{.Id}}", HOST_LOCAL_VLLM_CONTAINER_NAME],
      {
        artifactName: "vllm-export-preflight-container",
        env: exportEnv,
        timeoutMs: 30_000,
      },
    );
    expect(
      `${String(preflight.exitCode)}\n${resultText(preflight)}`,
      `Refusing to replace a pre-existing ${HOST_LOCAL_VLLM_CONTAINER_NAME} container.`,
    ).toMatch(/^1\n[\s\S]*no such (?:object|container)/iu);
    await cleanupGpu(host, sandbox);

    cleanup.trackDisposable("remove the exact managed vLLM runtime", () => {
      const result = cleanupLocalModelRuntimes({ env: exportEnv, sandboxName: SANDBOX_NAME });
      expect(
        result.ok &&
          (!managedVllmOnboarded ||
            result.removed.some((resource) => resource.startsWith("container:"))),
        JSON.stringify(result),
      ).toBe(true);
    });
    cleanup.trackGateway(host, "nemoclaw", {
      artifactName: "vllm-export-cleanup-gateway",
      env: exportEnv,
      timeoutMs: 60_000,
    });
    cleanup.trackDisposable("delete the managed vLLM export OpenShell sandbox", () =>
      sandbox.cleanupSandbox(SANDBOX_NAME, {
        artifactName: "vllm-export-cleanup-openshell",
        env: exportEnv,
        timeoutMs: 60_000,
      }),
    );
    cleanup.trackSandbox(host, SANDBOX_NAME, {
      artifactName: "vllm-export-cleanup-sandbox",
      env: exportEnv,
      timeoutMs: 15 * 60_000,
    });

    progress.phase("onboard the fixed managed vLLM profile");
    const onboard = await host.command(
      "node",
      [
        CLI,
        "onboard",
        "--profile",
        EXPORTED_VLLM_PROFILE_ID,
        "--fresh",
        "--non-interactive",
        "--yes-i-accept-third-party-software",
      ],
      {
        artifactName: "vllm-export-onboard",
        cwd: REPO_ROOT,
        env: exportEnv,
        timeoutMs: execTimeout(75 * 60_000),
      },
    );
    expect(onboard.exitCode, resultText(onboard)).toBe(0);
    managedVllmOnboarded = true;
    const apiKey = loadManagedVllmApiKey();
    artifacts.addRedactionValues([apiKey ?? ""]);

    progress.phase("export the managed vLLM configuration");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-vllm-export-"));
    cleanup.trackDisposable("remove private managed vLLM export documents", () =>
      fs.rmSync(directory, { recursive: true, force: true }),
    );
    const outputPath = path.join(directory, "export.yaml");
    const exported = await host.command(
      "node",
      [CLI, "config", "export", SANDBOX_NAME, "--output", outputPath, "--json"],
      {
        artifactName: "vllm-export",
        cwd: REPO_ROOT,
        env: exportEnv,
        timeoutMs: 60_000,
      },
    );
    expect(exported.exitCode, resultText(exported)).toBe(0);
    const yaml = fs.readFileSync(outputPath, "utf8");
    const document = parseConfigExport(yaml);
    const service = document.spec.services?.vllm as V1Alpha1VllmService | undefined;
    expect(service?.image).toBeNull();
    expect(apiKey && yaml.includes(apiKey)).toBe(false);
    await artifacts.writeText("vllm-config-export.yaml", yaml);
  },
);
