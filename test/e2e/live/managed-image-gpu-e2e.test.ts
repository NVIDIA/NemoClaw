// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import {
  type ManagedImageLocalInferenceKind,
  managedImageProtectedSandboxName,
  PROTECTED_MANAGED_IMAGE_AGENTS,
  type ProtectedManagedImageContract,
} from "../../../scripts/checks/managed-image-protected-runtime-contract.ts";
import {
  getOllamaProxyToken,
  persistAndProbeOllamaProxy,
  startOllamaAuthProxy,
} from "../../../src/lib/inference/ollama/proxy.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import {
  assertNvidiaAvailable,
  ensureOllama,
  env as gpuEnv,
  protectedManagedImageHome,
  REPO_ROOT,
  readProtectedManagedImageContracts,
  stopOwnedProcess,
} from "./gpu-e2e-helpers.ts";

const TIMEOUT_MS = 240 * 60_000;
const OLLAMA_MODEL = "qwen3.5:9b";
const VLLM_MODEL = "Qwen/Qwen2.5-0.5B-Instruct";
const VLLM_IMAGE =
  "vllm/vllm-openai@sha256:0fec7ec5f3e6bc168e54899935fb0557da908a4832a1dbc88e2debcf2f889416";
const VLLM_CONTAINER = "nemoclaw-managed-image-vllm-e2e";
const OLLAMA_LOG = path.join(process.env.RUNNER_TEMP ?? "/tmp", "managed-image-ollama.log");
const OLLAMA_PID = path.join(
  process.env.RUNNER_TEMP ?? "/tmp",
  "protected-managed-image-ollama.pid",
);

async function cleanupProtectedLocalInference(
  host: HostCliClient,
  artifactName: string,
): Promise<void> {
  const home = protectedManagedImageHome();
  const adapterState = path.join(home, ".nemoclaw");
  const proxyPid = path.join(adapterState, "ollama-auth-proxy.pid");
  await stopOwnedProcess(proxyPid, /ollama-auth-proxy\.(?:js|mts)/u, "OLLAMA_PROXY_PORT=11435");
  await stopOwnedProcess(OLLAMA_PID, /ollama\s+serve/u, "OLLAMA_HOST=127.0.0.1:11434");
  const ports = await host.command(
    "bash",
    [
      "-lc",
      "if lsof -tiTCP:11434 -sTCP:LISTEN 2>/dev/null || lsof -tiTCP:11435 -sTCP:LISTEN 2>/dev/null; then exit 1; fi",
    ],
    { artifactName, env: gpuEnv(), timeoutMs: 30_000 },
  );
  expect(ports.exitCode, resultText(ports)).toBe(0);
  for (const ownedPath of [
    proxyPid,
    path.join(adapterState, "ollama-backend"),
    path.join(adapterState, "ollama-proxy-token"),
    OLLAMA_PID,
  ]) {
    fs.rmSync(ownedPath, { force: true });
  }
}

async function runExactImageQualification(
  host: HostCliClient,
  contract: ProtectedManagedImageContract,
  kind: ManagedImageLocalInferenceKind,
  model: string,
  extraEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const sandboxName = managedImageProtectedSandboxName(contract.agent, kind);
  const result = await host.command(
    "npx",
    [
      "--no-install",
      "tsx",
      "scripts/checks/run-managed-image-openshell-e2e.ts",
      "--agent",
      contract.agent,
      "--image",
      contract.reference,
      "--sandbox",
      sandboxName,
      "--gpu",
      "--local-provider",
      kind,
      "--model",
      model,
    ],
    {
      artifactName: `managed-image-${contract.agent}-${kind}`,
      cwd: REPO_ROOT,
      env: {
        ...buildAvailabilityProbeEnv(),
        NEMOCLAW_NON_INTERACTIVE: "1",
        ...extraEnv,
      },
      timeoutMs: 20 * 60_000,
    },
  );
  expect(result.exitCode, resultText(result)).toBe(0);
  expect(result.stdout).toContain(`exact ${contract.agent} PR image ${contract.reference}`);
  expect(result.stdout).toContain("real NVIDIA GPU access");
  expect(result.stdout).toContain(`${kind} inference.local completion`);
  expect(result.stdout).toContain(`real ${contract.agent} agent turn`);
}

test("exact all-agent managed images retain NVIDIA GPU and real Ollama/vLLM inference.local", {
  timeout: TIMEOUT_MS,
  meta: {
    e2ePhases: [
      "prepare exact protected image contracts",
      "qualify all agents through GPU-backed Ollama",
      "qualify all agents through GPU-backed vLLM",
      "verify owned runtime inventory is clean",
    ],
  },
}, async ({ artifacts, cleanup, host, progress, skip }) => {
  const contracts = readProtectedManagedImageContracts();
  await artifacts.target.declare({
    id: "managed-image-gpu-e2e",
    boundary:
      "same-job localhost registry digest + all managed agents + Docker/OpenShell NVIDIA GPU + host-local inference.local",
    sandboxName: "per-agent-and-provider",
    credentialBoundary:
      "Ollama and vLLM use generated/local non-user credentials; no repository inference secret is read.",
    delegatedLegacyContracts: [
      "Actual NIM engine qualification remains outside this target until the protected runner has an NGC pull credential.",
    ],
    agents: PROTECTED_MANAGED_IMAGE_AGENTS,
  });

  cleanup.trackDisposable("remove protected vLLM container", async () => {
    await host.command("docker", ["rm", "-f", VLLM_CONTAINER], {
      artifactName: "cleanup-vllm-container",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    });
  });
  cleanup.trackDisposable("stop protected Ollama runtime", async () => {
    await cleanupProtectedLocalInference(host, "cleanup-managed-image-local-inference");
  });

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

  progress.phase("qualify all agents through GPU-backed Ollama");
  protectedManagedImageHome();
  await ensureOllama(host);
  await cleanupProtectedLocalInference(host, "pre-cleanup-managed-image-local-inference");
  const startOllama = await host.command(
    "bash",
    [
      "-lc",
      `set -euo pipefail
OLLAMA_HOST=127.0.0.1:11434 nohup ollama serve >"${OLLAMA_LOG}" 2>&1 &
printf '%s\n' "$!" >"${OLLAMA_PID}"
for _ in $(seq 1 120); do
  curl -fsS --connect-timeout 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && exit 0
  sleep 1
done
exit 1`,
    ],
    {
      artifactName: "start-managed-image-ollama",
      env: gpuEnv(),
      timeoutMs: 150_000,
    },
  );
  expect(startOllama.exitCode, resultText(startOllama)).toBe(0);
  const pull = await host.command("ollama", ["pull", OLLAMA_MODEL], {
    artifactName: "pull-managed-image-ollama-model",
    env: gpuEnv(),
    timeoutMs: 45 * 60_000,
  });
  expect(pull.exitCode, resultText(pull)).toBe(0);
  expect(startOllamaAuthProxy(), "Ollama auth proxy must start").toBe(true);
  const proxyToken = getOllamaProxyToken();
  expect(proxyToken).toMatch(/^[a-f0-9]{48}$/u);
  await persistAndProbeOllamaProxy(proxyToken!);

  for (const contract of contracts) {
    await runExactImageQualification(host, contract, "ollama", OLLAMA_MODEL, {
      NEMOCLAW_OLLAMA_PROXY_TOKEN: proxyToken!,
    });
  }
  const ollamaGpu = await host.command(
    "bash",
    [
      "-lc",
      `curl -fsS http://127.0.0.1:11434/api/ps | jq -e --arg model "${OLLAMA_MODEL}" '
          [.models[] | select((.name == $model or .model == $model) and ((.size_vram // 0) > 0))]
          | length >= 1
        '`,
    ],
    {
      artifactName: "ollama-gpu-placement",
      env: gpuEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(ollamaGpu.exitCode, resultText(ollamaGpu)).toBe(0);
  await artifacts.writeText("ollama-gpu-placement.txt", resultText(ollamaGpu));
  const ollamaLogs = await host.command(
    "bash",
    [
      "-lc",
      `set -euo pipefail
test -s ${JSON.stringify(OLLAMA_LOG)}
grep -E '\\|[[:space:]]*200[[:space:]]*\\|.*POST[[:space:]]+"?/(api/chat|v1/chat/completions)' ${JSON.stringify(
        OLLAMA_LOG,
      )}`,
    ],
    {
      artifactName: "ollama-logs-after-completions",
      env: gpuEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(ollamaLogs.exitCode, resultText(ollamaLogs)).toBe(0);
  const successfulOllamaCompletions = resultText(ollamaLogs).split(/\r?\n/u).filter(Boolean);
  expect(successfulOllamaCompletions.length).toBeGreaterThanOrEqual(contracts.length * 2);
  await artifacts.writeText("ollama-after-completions.log", resultText(ollamaLogs));

  progress.phase("qualify all agents through GPU-backed vLLM");
  await cleanupProtectedLocalInference(host, "stop-local-inference-before-vllm");
  await host.command("docker", ["rm", "-f", VLLM_CONTAINER], {
    artifactName: "pre-cleanup-vllm",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  const vllmStart = await host.command(
    "docker",
    [
      "run",
      "--detach",
      "--name",
      VLLM_CONTAINER,
      "--gpus",
      "all",
      "--publish",
      "8000:8000",
      VLLM_IMAGE,
      "--model",
      VLLM_MODEL,
      "--served-model-name",
      VLLM_MODEL,
      "--max-model-len",
      "2048",
      "--gpu-memory-utilization",
      "0.45",
    ],
    {
      artifactName: "start-vllm",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 20 * 60_000,
    },
  );
  expect(vllmStart.exitCode, resultText(vllmStart)).toBe(0);
  const vllmReady = await host.command(
    "bash",
    [
      "-lc",
      `set -euo pipefail
for _ in $(seq 1 300); do
  curl -fsS --connect-timeout 2 http://127.0.0.1:8000/v1/models >/dev/null 2>&1 && exit 0
  docker container inspect "${VLLM_CONTAINER}" --format '{{.State.Running}}' | grep -Fx true >/dev/null
  sleep 2
done
docker logs "${VLLM_CONTAINER}" >&2
exit 1`,
    ],
    {
      artifactName: "wait-vllm",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 11 * 60_000,
    },
  );
  expect(vllmReady.exitCode, resultText(vllmReady)).toBe(0);
  const vllmCuda = await host.command(
    "bash",
    [
      "-lc",
      `set -euo pipefail
docker exec "${VLLM_CONTAINER}" python3 - <<'PY'
import torch
assert torch.cuda.is_available()
print(torch.cuda.get_device_name(0))
PY
docker logs "${VLLM_CONTAINER}" 2>&1 | grep -Eai 'cuda|GPU KV cache|GPU blocks'`,
    ],
    {
      artifactName: "vllm-cuda-initialization",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    },
  );
  expect(vllmCuda.exitCode, resultText(vllmCuda)).toBe(0);
  await artifacts.writeText("vllm-cuda-initialization.txt", resultText(vllmCuda));

  for (const contract of contracts) {
    await runExactImageQualification(host, contract, "vllm", VLLM_MODEL, {
      NEMOCLAW_VLLM_LOCAL_TOKEN: "protected-local-vllm",
    });
  }

  const vllmLogs = await host.command("docker", ["logs", VLLM_CONTAINER], {
    artifactName: "vllm-logs-after-completions",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  expect(vllmLogs.exitCode, resultText(vllmLogs)).toBe(0);
  const successfulCompletions =
    resultText(vllmLogs).match(/(?:POST \/v1\/chat\/completions.*200|200.*chat\/completions)/giu) ??
    [];
  expect(successfulCompletions.length).toBeGreaterThanOrEqual(contracts.length * 2);
  await artifacts.writeText("vllm-after-completions.log", resultText(vllmLogs));

  progress.phase("verify owned runtime inventory is clean");
  // Each harness owns and removes its gateway state. Keep an independent
  // Docker inventory check on the protected runner after all six launches.
  const orphans = await host.command(
    "bash",
    [
      "-lc",
      `docker ps -a --format '{{.Label "openshell.ai/sandbox-name"}}' \
        --filter label=openshell.ai/managed-by=openshell \
        | grep '^nemoclaw-managed-' || true`,
    ],
    {
      artifactName: "final-managed-image-sandbox-container-list",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(orphans.exitCode, resultText(orphans)).toBe(0);
  expect(orphans.stdout.trim()).toBe("");
  const networks = await host.command(
    "bash",
    ["-lc", "docker network ls --format '{{.Name}}' | grep '^nemoclaw-managed-pr-' || true"],
    {
      artifactName: "final-managed-image-harness-network-list",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(networks.exitCode, resultText(networks)).toBe(0);
  expect(networks.stdout.trim()).toBe("");
});
