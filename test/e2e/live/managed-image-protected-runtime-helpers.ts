// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  MANAGED_IMAGE_PROTECTED_SANDBOX_PREFIX,
  type ManagedImageLocalInferenceKind,
  managedImageProtectedSandboxName,
  PROTECTED_MANAGED_IMAGE_AGENTS,
  type ProtectedManagedImageContract,
  parseProtectedManagedImageContracts,
} from "../../../scripts/checks/managed-image-protected-runtime-contract.ts";
import {
  adoptServedModelId,
  dockerLoginNgc,
  pullNimImage,
  startNimContainerByName,
  stopNimContainerByName,
  waitForNimHealth,
} from "../../../src/lib/inference/nim.ts";
import {
  getOllamaProxyToken,
  killStaleProxy,
  persistAndProbeOllamaProxy,
  startOllamaAuthProxy,
} from "../../../src/lib/inference/ollama/proxy.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { resultText } from "../fixtures/clients/index.ts";
import type { E2ETargetFixtures } from "../fixtures/e2e-test.ts";
import { expect } from "../fixtures/e2e-test.ts";
import {
  assertNvidiaAvailable,
  cleanupOllama,
  ensureOllama,
  env as gpuEnv,
  REPO_ROOT,
} from "./gpu-e2e-helpers.ts";

const OLLAMA_MODEL = "qwen3.5:9b";
const VLLM_MODEL = "Qwen/Qwen2.5-0.5B-Instruct";
const VLLM_IMAGE =
  "vllm/vllm-openai@sha256:0fec7ec5f3e6bc168e54899935fb0557da908a4832a1dbc88e2debcf2f889416";
const VLLM_CONTAINER = "nemoclaw-managed-image-vllm-e2e";
const NIM_CATALOG_MODEL = "nvidia/nemotron-3-nano-30b-a3b";
const NIM_CONTAINER = "nemoclaw-managed-image-nim-e2e";
const AGENT_QUALIFICATION_TIMEOUT_MS = 10 * 60_000;
const ROLLBACK_QUALIFICATION_TIMEOUT_MS = 10 * 60_000;

type RuntimeFixtures = Pick<E2ETargetFixtures, "artifacts" | "cleanup" | "host" | "progress">;

function imageContracts(): ProtectedManagedImageContract[] {
  const contractPath = process.env.NEMOCLAW_PROTECTED_MANAGED_IMAGE_CONTRACT;
  if (!contractPath || !path.isAbsolute(contractPath)) {
    throw new Error("NEMOCLAW_PROTECTED_MANAGED_IMAGE_CONTRACT must be an absolute path");
  }
  return parseProtectedManagedImageContracts(
    JSON.parse(fs.readFileSync(contractPath, "utf8")),
    "linux/amd64",
  );
}

function requiredNgcApiKey(value: string): string {
  const key = value.trim();
  if (!key || /[\0\r\n]/u.test(key)) {
    throw new Error("protected managed-image NIM qualification requires NVIDIA_API_KEY");
  }
  return key;
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
      timeoutMs: AGENT_QUALIFICATION_TIMEOUT_MS,
    },
  );
  expect(result.exitCode, resultText(result)).toBe(0);
  expect(result.stdout).toContain(`exact ${contract.agent} PR image ${contract.reference}`);
  expect(result.stdout).toContain("real NVIDIA GPU access");
  expect(result.stdout).toContain(`${kind} inference.local completion`);
}

async function qualifyEveryAgent(
  host: HostCliClient,
  contracts: readonly ProtectedManagedImageContract[],
  kind: ManagedImageLocalInferenceKind,
  model: string,
  extraEnv: NodeJS.ProcessEnv,
): Promise<void> {
  for (const contract of contracts) {
    await runExactImageQualification(host, contract, kind, model, extraEnv);
  }
}

async function startProtectedOllama(host: HostCliClient): Promise<string> {
  await ensureOllama(host);
  await cleanupOllama(host, "pre-cleanup-managed-image-ollama");
  const start = await host.command(
    "bash",
    [
      "-lc",
      `set -euo pipefail
OLLAMA_HOST=127.0.0.1:11434 nohup ollama serve >"${process.env.RUNNER_TEMP ?? "/tmp"}/managed-image-ollama.log" 2>&1 &
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
  expect(start.exitCode, resultText(start)).toBe(0);
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
  return proxyToken!;
}

async function proveOllamaGpuPlacement(host: HostCliClient): Promise<void> {
  const result = await host.command(
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
  expect(result.exitCode, resultText(result)).toBe(0);
}

async function startProtectedVllm(host: HostCliClient): Promise<void> {
  await host.command("docker", ["rm", "-f", VLLM_CONTAINER], {
    artifactName: "pre-cleanup-vllm",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  const start = await host.command(
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
  expect(start.exitCode, resultText(start)).toBe(0);
  const ready = await host.command(
    "bash",
    [
      "-lc",
      `set -euo pipefail
for _ in $(seq 1 300); do
  curl -fsS --connect-timeout 2 http://127.0.0.1:8000/v1/models >/dev/null 2>&1 && exit 0
  docker container inspect "${VLLM_CONTAINER}" --format '{{.State.Running}}' | grep -Fx true >/dev/null
  sleep 2
done
docker logs --tail 200 "${VLLM_CONTAINER}" >&2
exit 1`,
    ],
    {
      artifactName: "wait-vllm",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 11 * 60_000,
    },
  );
  expect(ready.exitCode, resultText(ready)).toBe(0);
  const cuda = await host.command(
    "docker",
    [
      "exec",
      VLLM_CONTAINER,
      "python3",
      "-c",
      "import torch; assert torch.cuda.is_available(); print(torch.cuda.get_device_name(0))",
    ],
    {
      artifactName: "vllm-cuda-initialization",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    },
  );
  expect(cuda.exitCode, resultText(cuda)).toBe(0);
}

async function startProtectedNim(host: HostCliClient, apiKey: string): Promise<string> {
  stopNimContainerByName(NIM_CONTAINER, { silent: true });
  expect(dockerLoginNgc(apiKey), "NGC login must succeed for protected NIM qualification").toBe(
    true,
  );
  pullNimImage(NIM_CATALOG_MODEL);
  startNimContainerByName(NIM_CONTAINER, NIM_CATALOG_MODEL, 8000, { ngcApiKey: apiKey });
  expect(
    waitForNimHealth(8000, 20 * 60, { container: NIM_CONTAINER }),
    "NIM must become healthy",
  ).toBe(true);
  const servedModel = adoptServedModelId(NIM_CATALOG_MODEL, 8000);
  expect(servedModel, "NIM must report one safe served model").toBeTruthy();
  const cuda = await host.command("docker", ["exec", NIM_CONTAINER, "nvidia-smi", "-L"], {
    artifactName: "nim-cuda-initialization",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 60_000,
  });
  expect(cuda.exitCode, resultText(cuda)).toBe(0);
  return servedModel!;
}

async function qualifyRollback(
  host: HostCliClient,
  contract: ProtectedManagedImageContract,
): Promise<void> {
  const sandboxName = managedImageProtectedSandboxName(contract.agent, "rollback");
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
      "--inject-bootstrap-completion-failure",
    ],
    {
      artifactName: `managed-image-${contract.agent}-bootstrap-rollback`,
      cwd: REPO_ROOT,
      env: { ...buildAvailabilityProbeEnv(), NEMOCLAW_NON_INTERACTIVE: "1" },
      timeoutMs: ROLLBACK_QUALIFICATION_TIMEOUT_MS,
    },
  );
  expect(result.exitCode, resultText(result)).toBe(0);
  expect(result.stdout).toContain(
    `removed the failed exact ${contract.agent} sandbox before harness cleanup`,
  );
  expect(result.stdout).toContain(
    `left no sandbox, container, network, or harness state orphan for ${contract.agent}`,
  );
}

async function qualifyEveryRollback(
  host: HostCliClient,
  contracts: readonly ProtectedManagedImageContract[],
): Promise<void> {
  for (const contract of contracts) await qualifyRollback(host, contract);
}

async function proveOwnedRuntimeInventoryClean(host: HostCliClient): Promise<void> {
  const result = await host.command(
    "bash",
    [
      "-lc",
      `set -euo pipefail
containers="$(docker ps -a --format '{{.Label "openshell.ai/sandbox-name"}}' --filter label=openshell.ai/managed-by=openshell | grep '^${MANAGED_IMAGE_PROTECTED_SANDBOX_PREFIX}' || true)"
networks="$(docker network ls --format '{{.Name}}' | grep '^nemoclaw-managed-pr-' || true)"
test -z "$containers"
test -z "$networks"`,
    ],
    {
      artifactName: "final-managed-image-owned-runtime-inventory",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(result.exitCode, resultText(result)).toBe(0);
}

export async function qualifyProtectedManagedImageRuntime(
  fixtures: RuntimeFixtures,
  ngcApiKeyInput: string,
): Promise<void> {
  const { artifacts, cleanup, host, progress } = fixtures;
  const contracts = imageContracts();
  const ngcApiKey = requiredNgcApiKey(ngcApiKeyInput);

  cleanup.trackDisposable("remove protected vLLM container", async () => {
    await host.command("docker", ["rm", "-f", VLLM_CONTAINER], {
      artifactName: "cleanup-vllm-container",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    });
  });
  cleanup.trackDisposable("remove protected NIM container", () => {
    stopNimContainerByName(NIM_CONTAINER, { silent: true });
  });
  cleanup.trackDisposable("stop protected Ollama runtime", async () => {
    killStaleProxy();
    await cleanupOllama(host, "cleanup-managed-image-ollama");
  });

  let activePhase = "validate protected host runtime";
  try {
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
    assertNvidiaAvailable(nvidia, (message) => {
      throw new Error(message ?? "protected GPU runner is unavailable");
    });

    activePhase = "qualify all managed agents with GPU-backed Ollama";
    progress.phase("qualify all managed agents with GPU-backed Ollama");
    const proxyToken = await startProtectedOllama(host);
    await qualifyEveryAgent(host, contracts, "ollama", OLLAMA_MODEL, {
      NEMOCLAW_OLLAMA_PROXY_TOKEN: proxyToken,
    });
    await proveOllamaGpuPlacement(host);
    killStaleProxy();
    await cleanupOllama(host, "stop-ollama-before-vllm");

    activePhase = "qualify all managed agents with GPU-backed vLLM";
    progress.phase("qualify all managed agents with GPU-backed vLLM");
    await startProtectedVllm(host);
    await qualifyEveryAgent(host, contracts, "vllm", VLLM_MODEL, {
      NEMOCLAW_VLLM_LOCAL_TOKEN: randomBytes(24).toString("hex"),
    });
    await host.command("docker", ["rm", "-f", VLLM_CONTAINER], {
      artifactName: "stop-vllm-before-nim",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    });

    activePhase = "qualify all managed agents with GPU-backed NVIDIA NIM";
    progress.phase("qualify all managed agents with GPU-backed NVIDIA NIM");
    const nimModel = await startProtectedNim(host, ngcApiKey);
    await qualifyEveryAgent(host, contracts, "nim", nimModel, {
      NEMOCLAW_VLLM_LOCAL_TOKEN: randomBytes(24).toString("hex"),
    });
    stopNimContainerByName(NIM_CONTAINER, { silent: true });

    activePhase = "prove all-agent managed bootstrap rollback and exact cleanup";
    progress.phase("prove all-agent managed bootstrap rollback and exact cleanup");
    await qualifyEveryRollback(host, contracts);
    await proveOwnedRuntimeInventoryClean(host);
    await artifacts.writeJson("managed-image-protected-runtime-summary.json", {
      agents: PROTECTED_MANAGED_IMAGE_AGENTS,
      providers: ["ollama", "vllm", "nim"],
      rollbackAgents: PROTECTED_MANAGED_IMAGE_AGENTS,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`protected managed-image runtime phase '${activePhase}' failed: ${detail}`, {
      cause: error,
    });
  }
}
