// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ContainerEngineCommandResult } from "../../../src/lib/adapters/container-engine.ts";
import {
  LLAMA_CPP_CREDENTIAL_ENV,
  LLAMA_CPP_SELECTION_KEY,
} from "../../../src/lib/inference/llama-cpp/contract.ts";
import {
  buildLlamaCppHostLocalServerArgv,
  LLAMA_CPP_HOST_LOCAL_CONTAINER_API_KEY_PATH,
  type LlamaCppHostLocalLaunchContract,
} from "../../../src/lib/inference/llama-cpp/host-local-runtime.ts";
import {
  loadManagedLlamaCppApiKey,
  loadManagedLlamaCppReceipt,
  managedLlamaCppStatePaths,
} from "../../../src/lib/inference/llama-cpp/managed-state.ts";
import { createManagedLlamaCppLifecycleAdapter } from "../../../src/lib/inference/llama-cpp/managed-lifecycle-adapter.ts";
import { isLlamaCppServingRecipe } from "../../../src/lib/inference/serving/adapter-registry.ts";
import { loadManagedInferenceCatalog } from "../../../src/lib/inference/serving/catalog-loader.ts";
import { resolveNemoClawGatewayRuntime } from "../../../src/lib/onboard/runtime-provider/configured-runtime.ts";
import { resolveRegisteredRuntimeProviderBundle } from "../../../src/lib/onboard/runtime-provider/current.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { trustedSandboxShellScript, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { CLI_ENTRYPOINT, REPO_ROOT } from "../fixtures/paths.ts";
import { pollUntil } from "../fixtures/polling.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { assertAgentExecutionSucceeded, hasExactReadyPhase } from "./gpu-e2e-helpers.ts";

const TIMEOUT_MS = 110 * 60_000;
const RECIPE_ID =
  process.env.NEMOCLAW_LLAMACPP_RECIPE ?? "llama-cpp.nemotron-3-nano-30b-a3b.spark-single.v1";
const TARGET_ID = process.env.E2E_TARGET_ID ?? "llama-cpp-generic-gpu";
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-llamacpp-gpu";
const OPERATOR_CONTAINER_PREFIX = "e2e-llamacpp-operator-loopback";
const TRANSIENT_OPERATOR_CURL_EXIT_CODES = new Set([7, 28]);
validateSandboxName(SANDBOX_NAME);
assert.match(RECIPE_ID, /^[a-z0-9][a-z0-9._-]{0,159}$/u, "invalid llama.cpp recipe ID");
assert.match(TARGET_ID, /^[a-z0-9][a-z0-9-]{0,63}$/u, "invalid E2E target ID");

function llamaGpuApplications(output: string): string[][] {
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(",").map((value) => value.trim()))
    .filter(([, processName]) => /llama-server$/u.test(processName ?? ""));
}

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
  delete selected.NEMOCLAW_CONTEXT_WINDOW;
  return selected;
}

function loadGpuSetting() {
  const catalog = loadManagedInferenceCatalog();
  const recipe = catalog.recipes.find(({ metadata }) => metadata.id === RECIPE_ID);
  assert(recipe && isLlamaCppServingRecipe(recipe), "GPU E2E llama.cpp recipe is missing");
  const modelFile = recipe.spec.model.files[0];
  assert(modelFile && "sizeBytes" in modelFile, "generic GPU E2E GGUF identity is incomplete");
  return { modelFile, recipe };
}

/**
 * Operator-run llama.cpp with the reported #11626 shape: the same recipe image
 * and cached GGUF the managed install proved, published on host loopback only.
 * The managed install publishes on the Docker gateway address as well, so only
 * this operator shape can leave the sandbox hop unreachable.
 */
function operatorLoopbackRunArgv(
  recipe: ReturnType<typeof loadGpuSetting>["recipe"],
  bindings: { containerName: string; keyHostPath: string; modelHostPath: string },
): string[] {
  const { model, runtime, serve } = recipe.spec;
  const modelFile = model.files[0]!;
  const containerModelPath = `/models/${modelFile.path}`;
  const contract: LlamaCppHostLocalLaunchContract = {
    model: {
      servedName: model.servedName,
      file: {
        digest: modelFile.digest,
        path: modelFile.path,
        sizeBytes: modelFile.sizeBytes,
      },
    },
    policy: recipe.spec.policy,
    runtime: {
      restartPolicy: runtime.restartPolicy,
      gpu: runtime.gpu,
      resources: runtime.resources,
    },
    serve,
    surfaces: recipe.spec.surfaces,
  };
  return [
    "container",
    "run",
    "--detach",
    "--name",
    bindings.containerName,
    "--publish",
    `127.0.0.1:${String(serve.port)}:${String(serve.port)}`,
    "--gpus",
    "driver=nvidia,count=1",
    "--mount",
    `type=bind,source=${bindings.modelHostPath},target=${containerModelPath},readonly`,
    "--mount",
    `type=bind,source=${bindings.keyHostPath},target=${LLAMA_CPP_HOST_LOCAL_CONTAINER_API_KEY_PATH},readonly`,
    runtime.image,
    ...buildLlamaCppHostLocalServerArgv(contract),
  ];
}

interface OperatorReadinessAttempt {
  readonly container: ContainerEngineCommandResult;
  readonly models: ShellProbeResult;
}

function operatorReadinessTerminal(attempt: OperatorReadinessAttempt): string | undefined {
  switch (true) {
    case attempt.container.status !== 0 || attempt.container.stdout.trim() !== "true":
      return "The operator llama.cpp container stopped before readiness.";
    case attempt.models.exitCode === 0:
    case TRANSIENT_OPERATOR_CURL_EXIT_CODES.has(attempt.models.exitCode ?? -1):
      return undefined;
    default:
      return "The operator llama.cpp readiness read failed.";
  }
}

test(
  "installs managed llama.cpp, routes a real agent turn, destroys its runtime, and rejects a loopback-only operator attachment (#8144, #9888, #11626)",
  {
    timeout: TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "validate exact source and NVIDIA GPU host",
        "run the declarative managed llama.cpp installer",
        "verify full GPU offload",
        "verify authenticated host and sandbox inference",
        "verify OpenClaw agent inference and owned cleanup",
        "reject an operator-attached loopback-only llama.cpp publish",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, sandbox }) => {
    await artifacts.target.declare({
      id: TARGET_ID,
      boundary:
        "Linux AMD64 RTX runner + Docker-qualified managed llama.cpp target + operator-attached loopback-only publish + OpenShell sandbox route",
      configurationAuthority:
        "The repository-owned serving recipe supplies every model and serving value; the selected runtime-provider bundle owns materialization, and the artifact records the provider this lane exercised.",
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

    progress.phase("validate exact source and NVIDIA GPU host");
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
    assert(
      architecture.exitCode === 0 && architecture.stdout.trim() === "x86_64",
      resultText(architecture),
    );

    const { modelFile, recipe } = loadGpuSetting();

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
      receipt?.service === "llama-cpp" &&
        receipt.runtime.kind === "container" &&
        receipt.providerId === resolveNemoClawGatewayRuntime(env()),
      "managed llama.cpp container receipt does not match the target-selected runtime provider",
    );
    const runtimeProvider = resolveRegisteredRuntimeProviderBundle(receipt.providerId);
    assert(
      runtimeProvider?.hostLocalInference.supported === true &&
        runtimeProvider.hostLocalInference.services.includes("llama-cpp"),
      "receipt runtime provider does not expose managed llama.cpp authority",
    );
    const apiKey = loadManagedLlamaCppApiKey(managedLlamaCppStatePaths(os.homedir()));
    assert(apiKey, "managed llama.cpp API key is missing");
    artifacts.addRedactionValues([apiKey]);
    const runtimeOperation = runtimeProvider.hostLocalInference.createOperation({ env: env() });
    runtimeOperation.assertAuthority();
    const runtimeLogs = runtimeOperation.engine.capture(
      ["container", "logs", "--tail", "20000", receipt.runtime.runtimeId],
      30_000,
    );
    await artifacts.writeJson("managed-runtime-logs.json", {
      providerId: receipt.providerId,
      runtimeId: receipt.runtime.runtimeId,
      status: runtimeLogs.status,
      error: runtimeLogs.error?.message ?? null,
      stdout: runtimeLogs.stdout,
      stderr: runtimeLogs.stderr,
    });
    const runtimeInspection = runtimeOperation.engine.capture(
      ["container", "inspect", receipt.runtime.runtimeId],
      30_000,
    );
    const inspectedRuntime = (
      runtimeInspection.status === 0 ? JSON.parse(runtimeInspection.stdout) : []
    ) as Array<{
      HostConfig?: { PortBindings?: Record<string, unknown> };
      NetworkSettings?: { Ports?: Record<string, unknown> };
    }>;
    const inspectedContainer = inspectedRuntime[0];
    const portBindings = inspectedContainer?.HostConfig?.PortBindings;
    const runtimePorts = inspectedContainer?.NetworkSettings?.Ports;
    assert(
      runtimeInspection.status === 0 &&
        portBindings !== undefined &&
        Object.keys(portBindings).length === 0 &&
        runtimePorts !== undefined &&
        Object.values(runtimePorts).every((value) => value === null),
      runtimeInspection.error?.message ||
        runtimeInspection.stderr ||
        "managed llama.cpp runtime ports must remain unpublished",
    );
    await artifacts.writeJson("managed-runtime-network.json", {
      providerId: receipt.providerId,
      runtimeId: receipt.runtime.runtimeId,
      portBindings,
      ports: runtimePorts,
    });
    const runtimeProcesses = runtimeOperation.engine.capture(
      ["container", "top", receipt.runtime.runtimeId, "-eo", "pid,comm"],
      30_000,
    );
    assert.equal(
      runtimeProcesses.status,
      0,
      runtimeProcesses.error?.message || runtimeProcesses.stderr,
    );
    await artifacts.writeJson("managed-runtime-processes.json", {
      providerId: receipt.providerId,
      runtimeId: receipt.runtime.runtimeId,
      processes: runtimeProcesses.stdout.trim(),
    });
    const managedLlamaProcess = runtimeProcesses.stdout
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/u))
      .find(([, processName]) => /llama-server$/u.test(processName ?? ""));
    const managedLlamaPid = Number(managedLlamaProcess?.[0]);
    assert(
      managedLlamaProcess && Number.isSafeInteger(managedLlamaPid) && managedLlamaPid > 0,
      "managed runtime does not contain one valid llama-server process",
    );
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
    const llamaGpuProcess = llamaGpuApplications(computeApps.stdout).find(
      ([pid]) => Number(pid) === managedLlamaPid,
    );
    const usedGpuMemoryMiB = Number(llamaGpuProcess?.[2]);
    const minimumFullOffloadMemoryMiB = Math.ceil(modelFile.sizeBytes / 1024 ** 2);
    expect(usedGpuMemoryMiB).toBeGreaterThanOrEqual(minimumFullOffloadMemoryMiB);

    progress.phase("verify authenticated host and sandbox inference");
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
    expect(unauthorized.stdout, resultText(unauthorized)).toBe("401");

    const hostModels = await host.command(
      "curl",
      [
        "-fsS",
        "--max-time",
        "30",
        "-H",
        `Authorization: Bearer ${apiKey}`,
        `http://127.0.0.1:${String(recipe.spec.serve.port)}/v1/models`,
      ],
      {
        artifactName: "llama-cpp-served-context",
        env: env(),
        redactionValues: [apiKey],
        timeoutMs: 35_000,
      },
    );
    const servedModels = JSON.parse(hostModels.stdout) as {
      data: Array<{ id: string; meta?: { n_ctx?: number } }>;
    };
    const servedContextWindow = servedModels.data.find(
      ({ id }) => id === recipe.spec.model.servedName,
    )?.meta?.n_ctx;
    assert(
      Number.isSafeInteger(servedContextWindow) && (servedContextWindow ?? 0) > 0,
      "selected llama.cpp model must report a positive served context window",
    );
    const runtimeContext = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(`node - <<'NODE'
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync("/sandbox/.openclaw/openclaw.json", "utf8"));
const model = config.agents.defaults.model.primary;
const separator = model.indexOf("/");
const provider = model.slice(0, separator);
const id = model.slice(separator + 1);
const selected = config.models.providers[provider].models.find((entry) => entry.id === id);
process.stdout.write(JSON.stringify({ model, contextWindow: selected?.contextWindow }));
NODE`),
      { artifactName: "openclaw-served-context", env: env(), timeoutMs: 30_000 },
    );
    expect(JSON.parse(runtimeContext.stdout)).toEqual({
      model: `inference/${recipe.spec.model.servedName}`,
      contextWindow: servedContextWindow,
    });

    progress.phase("verify OpenClaw agent inference and owned cleanup");
    const agent = await host.nemoclaw(
      [
        SANDBOX_NAME,
        "agent",
        "--agent",
        "main",
        "--json",
        "--session-id",
        `${TARGET_ID}-${Date.now()}-${process.pid}`,
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
    const listAfterDestroy = await host.command("node", [CLI_ENTRYPOINT, "list", "--json"], {
      artifactName: "list-after-managed-llama-cpp-destroy",
      env: destroyEnv,
      timeoutMs: 30_000,
    });
    const inventory = JSON.parse(listAfterDestroy.stdout) as {
      sandboxes: Array<{ name: string }>;
    };
    expect(
      inventory.sandboxes.map(({ name }) => name),
      resultText(listAfterDestroy),
    ).not.toContain(SANDBOX_NAME);
    const computeAfter = await host.command(
      "nvidia-smi",
      ["--query-compute-apps=pid,process_name,used_gpu_memory", "--format=csv,noheader,nounits"],
      {
        artifactName: "llama-cpp-nvidia-compute-apps-after",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(computeAfter.exitCode, resultText(computeAfter)).toBe(0);
    expect(
      llamaGpuApplications(computeAfter.stdout).some(([pid]) => Number(pid) === managedLlamaPid),
      resultText(computeAfter),
    ).toBe(false);
    expect(fs.existsSync(paths.stateDir), "destroy must remove managed llama.cpp state").toBe(
      false,
    );
    expect(
      fs.existsSync(modelCacheEntry),
      "destroy must preserve the shared Hugging Face cache entry",
    ).toBe(true);
    const cleanupProof = createManagedLlamaCppLifecycleAdapter({
      runtimeProvider,
      runtimeOwnerSandboxName: SANDBOX_NAME,
      expectedModel: recipe.spec.model.servedName,
      expectedReceipt: receipt,
      gatewayPort: recipe.spec.serve.port,
      homeDir: os.homedir(),
      environment: destroyEnv,
      operation: runtimeProvider.hostLocalInference.createOperation({ env: destroyEnv }),
    }).runtime.destroy(receipt);
    expect(cleanupProof.status).toBe("already-absent");

    progress.phase("reject an operator-attached loopback-only llama.cpp publish");
    // The managed phases above leave the OpenShell Docker network in place, so
    // the reachability probe takes the real sandbox hop. Destroy freed this GPU
    // and port 8081 for the operator server, and preserved its cached GGUF.
    const operatorRunId = randomUUID();
    const operatorApiKey = randomUUID();
    const operatorContainerName = `${OPERATOR_CONTAINER_PREFIX}-${operatorRunId.slice(0, 8)}`;
    artifacts.addRedactionValues([operatorApiKey]);
    const operatorKeyDir = fs.mkdtempSync(path.join(os.tmpdir(), `${TARGET_ID}-operator-`));
    const operatorKeyPath = path.join(operatorKeyDir, "api-key");
    fs.writeFileSync(operatorKeyPath, operatorApiKey, { mode: 0o600 });
    const operatorEngine = runtimeProvider.hostLocalInference.createOperation({
      env: destroyEnv,
    }).engine;
    cleanup.trackDisposable(`remove operator llama.cpp server ${operatorContainerName}`, () => {
      const removal = operatorEngine.capture(
        ["container", "rm", "--force", "--volumes", operatorContainerName],
        60_000,
      );
      const inspection = operatorEngine.capture(
        ["container", "inspect", operatorContainerName],
        30_000,
      );
      fs.rmSync(operatorKeyDir, { recursive: true, force: true });
      const missingPattern =
        /no such (?:container|object)|no container with name or id|does not exist/iu;
      const removalText = `${removal.error?.message ?? ""}\n${removal.stdout}\n${removal.stderr}`;
      const inspectionText = `${inspection.error?.message ?? ""}\n${inspection.stdout}\n${inspection.stderr}`;
      assert(
        (removal.status === 0 || missingPattern.test(removalText)) &&
          inspection.status !== 0 &&
          missingPattern.test(inspectionText),
        `operator llama.cpp cleanup could not prove container absence: ${removalText}\n${inspectionText}`,
      );
      return Promise.resolve();
    });
    const operatorLaunch = operatorEngine.capture(
      operatorLoopbackRunArgv(recipe, {
        containerName: operatorContainerName,
        keyHostPath: operatorKeyPath,
        modelHostPath: modelCacheEntry,
      }),
      120_000,
    );
    await artifacts.writeJson("operator-llama-cpp-loopback-launch.json", {
      publish: `127.0.0.1:${String(recipe.spec.serve.port)}`,
      status: operatorLaunch.status,
      error: operatorLaunch.error?.message ?? null,
      stderr: operatorLaunch.stderr,
    });
    expect(operatorLaunch.status, operatorLaunch.error?.message ?? operatorLaunch.stderr).toBe(0);
    const operatorModels = (
      await pollUntil<OperatorReadinessAttempt>({
        artifactPrefix: "operator-llama-cpp-loopback-host-models",
        deadlineMs: recipe.spec.readiness.timeoutSeconds * 1_000,
        delayMs: 5_000,
        probe: async (attempt, artifactName) => {
          const container = operatorEngine.capture(
            ["container", "inspect", "--format", "{{.State.Running}}", operatorContainerName],
            30_000,
          );
          await artifacts.writeJson(`${artifactName}-container.json`, {
            attempt,
            name: operatorContainerName,
            status: container.status,
            error: container.error?.message ?? null,
            stdout: container.stdout,
            stderr: container.stderr,
          });
          const models = await host.command(
            "curl",
            [
              "-fsS",
              "--max-time",
              "10",
              "-H",
              `Authorization: Bearer ${operatorApiKey}`,
              `http://127.0.0.1:${String(recipe.spec.serve.port)}/v1/models`,
            ],
            {
              artifactName,
              env: destroyEnv,
              redactionValues: [operatorApiKey],
              timeoutMs: 15_000,
            },
          );
          return { container, models };
        },
        accept: ({ container, models }) =>
          container.status === 0 && container.stdout.trim() === "true" && models.exitCode === 0,
        terminal: operatorReadinessTerminal,
      })
    ).value.models;
    expect(operatorModels.exitCode, resultText(operatorModels)).toBe(0);
    const operatorEnv = env({
      [LLAMA_CPP_CREDENTIAL_ENV]: operatorApiKey,
      NEMOCLAW_PROVIDER: LLAMA_CPP_SELECTION_KEY,
    });
    delete operatorEnv.NEMOCLAW_LLAMACPP_RECIPE;
    const operatorAttach = await host.nemoclaw(["onboard", "--non-interactive", "--yes"], {
      artifactName: "attach-operator-llama-cpp-loopback-only",
      env: operatorEnv,
      redactionValues: [operatorApiKey],
      timeoutMs: 15 * 60_000,
    });
    expect(operatorAttach.exitCode, resultText(operatorAttach)).not.toBe(0);
    expect(`${operatorAttach.stdout}\n${operatorAttach.stderr}`).toContain(
      `host.openshell.internal:${String(recipe.spec.serve.port)}`,
    );

    await artifacts.writeJson("qualification-evidence.json", {
      candidateSha: qualificationHeadSha,
      recipe: RECIPE_ID,
      runtimeProvider: {
        providerId: receipt.providerId,
        authorityId: receipt.engineAuthority.authorityId,
      },
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
        servedContextWindow,
        openClawContextWindow: servedContextWindow,
        unauthorizedStatus: 401,
        authenticatedModels: "passed",
        openClawAgent: "passed",
        publicDestroy: "passed",
        providerCleanupReconciliation: cleanupProof.status,
        operatorLoopbackOnlyAttachment: "rejected",
      },
    });

    await artifacts.target.complete({
      id: TARGET_ID,
      status: "passed",
      candidateSha: qualificationHeadSha,
      fullGpuOffload: true,
      model: recipe.spec.model.servedName,
    });
  },
);
