// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MANAGED_LLAMA_CPP_CONTAINER_NAME,
  MANAGED_LLAMA_CPP_NETWORK_NAME,
} from "../../../src/lib/inference/llama-cpp/managed-installer.ts";
import {
  loadManagedLlamaCppApiKey,
  loadManagedLlamaCppReceipt,
  managedLlamaCppStatePaths,
} from "../../../src/lib/inference/llama-cpp/managed-state.ts";
import { isLlamaCppServingRecipe } from "../../../src/lib/inference/serving/adapter-registry.ts";
import { loadManagedInferenceCatalog } from "../../../src/lib/inference/serving/catalog-loader.ts";
import { createDockerLlamaCppPrivateBridgeController } from "../../../src/lib/onboard/runtime-provider/docker-llama-cpp-private-bridge.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { trustedSandboxShellScript, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { CLI_ENTRYPOINT, REPO_ROOT } from "../fixtures/paths.ts";
import {
  assertAgentExecutionSucceeded,
  chatContent,
  hasExactReadyPhase,
} from "./gpu-e2e-helpers.ts";

const TIMEOUT_MS = 110 * 60_000;
const RECIPE_ID = "llama-cpp.nemotron-3-nano-30b-a3b.spark-single.v1";
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-llamacpp-gpu";
validateSandboxName(SANDBOX_NAME);

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {
    ...buildAvailabilityProbeEnv(process.env),
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_LLAMACPP_RECIPE: RECIPE_ID,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_PROVIDER: "install-llama-cpp",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
    ...extra,
  };
  delete selected.NEMOCLAW_MODEL;
  return selected;
}

function loadGenericGpuSetting() {
  const catalog = loadManagedInferenceCatalog();
  const recipe = catalog.recipes.find(({ metadata }) => metadata.id === RECIPE_ID);
  assert(recipe && isLlamaCppServingRecipe(recipe), "generic GPU E2E llama.cpp recipe is missing");
  const modelFile = recipe.spec.model.files[0];
  assert(modelFile && "sizeBytes" in modelFile, "generic GPU E2E GGUF identity is incomplete");
  return { modelFile, recipe };
}

test(
  "installs managed llama.cpp, routes a real agent turn, and destroys its runtime (#8144, #9888)",
  {
    timeout: TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "validate exact source and generic NVIDIA GPU host",
        "run the declarative managed llama.cpp installer",
        "verify full GPU offload",
        "verify authenticated host and sandbox inference",
        "verify OpenClaw agent inference and owned cleanup",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, sandbox }) => {
    await artifacts.target.declare({
      id: "llama-cpp-generic-gpu",
      boundary:
        "Linux amd64 host + Docker Engine + one NVIDIA GPU + install.sh managed llama.cpp + OpenShell sandbox route",
      configurationAuthority:
        "The repository-owned serving recipe and hardware preset supply every model, image, runtime, and serving value.",
      credentialBoundary:
        "The generated llama.cpp API key remains in owner-only host state and enters commands only through redacted process input.",
    });

    const cleanupEnv = env();
    cleanup.trackGateway(host, "nemoclaw", {
      artifactName: "cleanup-gateway",
      env: cleanupEnv,
      timeoutMs: 60_000,
    });
    cleanup.trackDisposable(`delete OpenShell sandbox ${SANDBOX_NAME}`, () =>
      sandbox.cleanupSandbox(SANDBOX_NAME, {
        artifactName: "cleanup-openshell-sandbox",
        env: cleanupEnv,
        timeoutMs: 60_000,
      }),
    );
    cleanup.trackSandbox(host, SANDBOX_NAME, {
      artifactName: "cleanup-nemoclaw-sandbox",
      env: cleanupEnv,
      timeoutMs: 180_000,
    });

    progress.phase("validate exact source and generic NVIDIA GPU host");
    const qualificationHeadSha = process.env.NEMOCLAW_LLAMA_CPP_QUALIFICATION_HEAD_SHA ?? "";
    assert.match(
      qualificationHeadSha,
      /^[a-f0-9]{40}$/u,
      "workflow must bind the exact candidate commit",
    );
    const architecture = await host.command("uname", ["-m"], {
      artifactName: "host-architecture",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    expect(architecture.exitCode, resultText(architecture)).toBe(0);
    expect(architecture.stdout.trim()).toBe("x86_64");

    const { modelFile, recipe } = loadGenericGpuSetting();

    progress.phase("run the declarative managed llama.cpp installer");
    const install = await host.command("bash", ["install.sh", "--non-interactive"], {
      artifactName: "install-managed-llama-cpp",
      cwd: REPO_ROOT,
      env: env(),
      timeoutMs: 75 * 60_000,
    });
    expect(install.exitCode, resultText(install)).toBe(0);

    progress.phase("verify full GPU offload");
    const paths = managedLlamaCppStatePaths(os.homedir());
    const modelCacheEntry = path.join(
      os.homedir(),
      ".cache",
      "huggingface",
      "hub",
      `models--${recipe.spec.model.id.replaceAll("/", "--")}`,
      "snapshots",
      recipe.spec.model.revision,
      modelFile.path,
    );
    const receipt = loadManagedLlamaCppReceipt(paths);
    assert(
      receipt?.runtime.kind === "container" &&
        "model" in receipt.runtime &&
        receipt.runtime.model !== undefined,
      "managed llama.cpp receipt runtime is incomplete",
    );
    const transactionId = receipt.runtime.model.generation;

    const inspect = await host.command(
      "docker",
      ["container", "inspect", MANAGED_LLAMA_CPP_CONTAINER_NAME],
      {
        artifactName: "managed-llama-cpp-container-inspect",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(inspect.exitCode, resultText(inspect)).toBe(0);
    const inspectedRuntime = JSON.parse(inspect.stdout) as Array<{
      HostConfig?: { PortBindings?: Record<string, unknown> };
      NetworkSettings?: { Ports?: Record<string, unknown> };
      State?: { Running?: unknown };
    }>;
    const runtime = inspectedRuntime[0];
    expect(runtime?.State?.Running).toBe(true);
    expect(inspectedRuntime[0]?.HostConfig?.PortBindings).toEqual({});
    expect(
      Object.values(inspectedRuntime[0]?.NetworkSettings?.Ports ?? {}).every(
        (value) => value === null,
      ),
    ).toBe(true);
    await host.command("docker", ["logs", "--tail", "20000", MANAGED_LLAMA_CPP_CONTAINER_NAME], {
      artifactName: "managed-llama-cpp-container-logs",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    const processes = await host.command(
      "docker",
      ["container", "top", MANAGED_LLAMA_CPP_CONTAINER_NAME, "-eo", "pid,comm"],
      {
        artifactName: "managed-llama-cpp-container-processes",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(processes.exitCode, resultText(processes)).toBe(0);
    const llamaProcess = processes.stdout
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/u))
      .find(([, processName]) => processName === "llama-server");
    expect(llamaProcess, resultText(processes)).toBeDefined();
    const llamaPid = Number(llamaProcess?.[0]);
    const computeApps = await host.command(
      "nvidia-smi",
      ["--query-compute-apps=pid,process_name,used_gpu_memory", "--format=csv,noheader,nounits"],
      {
        artifactName: "managed-llama-cpp-nvidia-compute-apps",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(computeApps.exitCode, resultText(computeApps)).toBe(0);
    const llamaGpuProcess = computeApps.stdout
      .trim()
      .split("\n")
      .map((line) => line.split(",").map((value) => value.trim()))
      .find(([pid, processName]) => Number(pid) === llamaPid && /llama-server$/u.test(processName));
    expect(llamaGpuProcess, resultText(computeApps)).toBeDefined();
    const usedGpuMemoryMiB = Number(llamaGpuProcess?.[2]);
    const minimumFullOffloadMemoryMiB = Math.floor((modelFile.sizeBytes / 1024 ** 2) * 0.75);
    expect(usedGpuMemoryMiB).toBeGreaterThanOrEqual(minimumFullOffloadMemoryMiB);

    progress.phase("verify authenticated host and sandbox inference");
    const apiKey = loadManagedLlamaCppApiKey(managedLlamaCppStatePaths(os.homedir()));
    assert(apiKey, "managed llama.cpp API key is missing");
    artifacts.addRedactionValues([apiKey]);
    const unauthorized = await host.command(
      "curl",
      [
        "-sS",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        `http://127.0.0.1:${String(recipe.spec.serve.port)}/props`,
      ],
      {
        artifactName: "llama-cpp-unauthorized",
        env: env(),
        timeoutMs: 30_000,
      },
    );
    expect(unauthorized.exitCode, resultText(unauthorized)).toBe(0);
    expect(unauthorized.stdout).toBe("401");

    const hostChat = await host.command(
      "curl",
      [
        "-fsS",
        "-H",
        `Authorization: Bearer ${apiKey}`,
        "-H",
        "Content-Type: application/json",
        `http://127.0.0.1:${String(recipe.spec.serve.port)}/v1/chat/completions`,
        "--data",
        JSON.stringify({
          model: recipe.spec.model.servedName,
          messages: [{ role: "user", content: "Respond with a short greeting." }],
          max_tokens: 32,
        }),
      ],
      {
        artifactName: "llama-cpp-host-chat",
        env: env(),
        redactionValues: [apiKey],
        timeoutMs: 5 * 60_000,
      },
    );
    expect(hostChat.exitCode, resultText(hostChat)).toBe(0);
    expect(chatContent(hostChat.stdout)).not.toBe("");

    const sandboxChat = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        `curl -fsS --max-time 300 https://inference.local/v1/chat/completions -H 'Content-Type: application/json' --data '${JSON.stringify(
          {
            model: recipe.spec.model.servedName,
            messages: [{ role: "user", content: "Respond with a short greeting." }],
            max_tokens: 32,
          },
        )}'`,
      ),
      { artifactName: "sandbox-inference-local-chat", env: env(), timeoutMs: 6 * 60_000 },
    );
    expect(sandboxChat.exitCode, resultText(sandboxChat)).toBe(0);
    expect(chatContent(sandboxChat.stdout)).not.toBe("");

    progress.phase("verify OpenClaw agent inference and owned cleanup");
    const agent = await host.nemoclaw(
      [
        SANDBOX_NAME,
        "agent",
        "--agent",
        "main",
        "--json",
        "--session-id",
        `e2e-llama-cpp-generic-gpu-${Date.now()}-${process.pid}`,
        "-m",
        "Respond with a short greeting.",
      ],
      {
        artifactName: "openclaw-agent-through-managed-llama-cpp",
        env: env(),
        timeoutMs: 12 * 60_000,
      },
    );
    expect(agent.exitCode, resultText(agent)).toBe(0);
    assertAgentExecutionSucceeded(agent.stdout, "inference", recipe.spec.model.servedName);

    const readySandbox = await sandbox.openshell(["sandbox", "get", SANDBOX_NAME], {
      artifactName: "openshell-sandbox-ready-after-agent",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    expect(readySandbox.exitCode, resultText(readySandbox)).toBe(0);
    expect(hasExactReadyPhase(readySandbox.stdout)).toBe(true);

    await artifacts.writeJson("qualification-evidence.json", {
      candidateSha: qualificationHeadSha,
      recipe: RECIPE_ID,
      model: {
        id: recipe.spec.model.id,
        digest: modelFile.digest,
        servedName: recipe.spec.model.servedName,
      },
      gpu: {
        architecture: architecture.stdout.trim(),
        computeProcess: computeApps.stdout.trim(),
        usedMemoryMiB: usedGpuMemoryMiB,
        minimumFullOffloadMemoryMiB,
      },
      probes: {
        unauthorizedStatus: 401,
        hostChat: "passed",
        sandboxChat: "passed",
        openClawAgent: "passed",
      },
    });

    const destroyEnv = env();
    delete destroyEnv.NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE;
    delete destroyEnv.NEMOCLAW_LLAMACPP_RECIPE;
    delete destroyEnv.NEMOCLAW_NON_INTERACTIVE;
    delete destroyEnv.NEMOCLAW_PROVIDER;
    delete destroyEnv.NEMOCLAW_RECREATE_SANDBOX;
    const destroy = await host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: "destroy-managed-llama-cpp-sandbox",
      env: destroyEnv,
      timeoutMs: 180_000,
    });
    expect(destroy.exitCode, resultText(destroy)).toBe(0);
    expect(() =>
      createDockerLlamaCppPrivateBridgeController().assertStopped(transactionId),
    ).not.toThrow();
    const listAfterDestroy = await host.command("node", [CLI_ENTRYPOINT, "list", "--json"], {
      artifactName: "list-after-managed-llama-cpp-destroy",
      env: destroyEnv,
      timeoutMs: 30_000,
    });
    expect(listAfterDestroy.exitCode, resultText(listAfterDestroy)).toBe(0);
    const inventory = JSON.parse(listAfterDestroy.stdout) as {
      sandboxes: Array<{ name: string }>;
    };
    expect(inventory.sandboxes.map(({ name }) => name)).not.toContain(SANDBOX_NAME);
    const runtimeAbsent = await host.command(
      "docker",
      ["container", "inspect", MANAGED_LLAMA_CPP_CONTAINER_NAME],
      {
        artifactName: "managed-llama-cpp-container-absent",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(runtimeAbsent.exitCode).toBe(1);
    const networkAbsent = await host.command(
      "docker",
      ["network", "inspect", MANAGED_LLAMA_CPP_NETWORK_NAME],
      {
        artifactName: "managed-llama-cpp-network-absent",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(networkAbsent.exitCode).toBe(1);
    expect(fs.existsSync(paths.stateDir), "destroy must remove managed llama.cpp state").toBe(
      false,
    );
    expect(
      fs.existsSync(modelCacheEntry),
      "destroy must preserve the shared Hugging Face cache entry",
    ).toBe(true);

    await artifacts.target.complete({
      id: "llama-cpp-generic-gpu",
      status: "passed",
      candidateSha: qualificationHeadSha,
      fullGpuOffload: true,
      model: recipe.spec.model.servedName,
    });
  },
);
