// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Live Vitest replacement for test/e2e/test-gpu-e2e.sh. */

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
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
  PROXY_PORT,
  proxyStatus,
  REPO_ROOT,
  readTokenFileChecked,
  restartProxy,
  SANDBOX_NAME,
} from "./gpu-e2e-helpers.ts";

const TIMEOUT_MS = 75 * 60_000;

test.skipIf(!shouldRunLiveE2EScenarios())(
  "GPU Ollama onboard enables CUDA, auth proxy, and sandbox inference",
  { timeout: TIMEOUT_MS },
  async ({ artifacts, cleanup, host, sandbox, skip }) => {
    await artifacts.writeJson("scenario.json", {
      id: "gpu-e2e",
      legacySource: "test/e2e/test-gpu-e2e.sh",
      boundary:
        "GPU host + install.sh Ollama provider + OpenShell sandbox + auth proxy + inference.local",
      remoteInstallerBoundary:
        "The official Ollama installer compatibility path runs before proxy tokens are read; the workflow uses a read-only checkout token and no explicit repository secrets. Replace with a pinned package once the GPU image provides a stable install source.",
      sandboxName: SANDBOX_NAME,
      delegatedLegacyContracts: [
        "Phase 11 shell retirement decides whether uninstall --delete-models remains a separate cleanup lane",
        "The #5468 OpenClaw TUI compaction guard remains in the retained legacy shell until a TUI fixture exists",
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
    expect(
      (await proxyStatus(host, "wrong-token", "proxy-wrong-token-tags-status")).stdout.trim(),
    ).toBe("401");
    expect((await proxyStatus(host, token, "proxy-correct-token-tags-status")).stdout.trim()).toBe(
      "200",
    );
    const restarted = await restartProxy(host, token);
    expect(restarted.exitCode, resultText(restarted)).toBe(0);
    expect(restarted.stdout.trim()).toBe("200");

    const model = await detectOllamaModel(host);
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
