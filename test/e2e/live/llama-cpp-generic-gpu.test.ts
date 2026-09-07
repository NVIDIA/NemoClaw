// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
import {
  assertAgentExecutionSucceeded,
  chatContent,
  hasExactReadyPhase,
} from "./gpu-e2e-helpers.ts";

const TIMEOUT_MS = 110 * 60_000;
const RECIPE_ID =
  process.env.NEMOCLAW_LLAMACPP_RECIPE ?? "llama-cpp.nemotron-3-nano-30b-a3b.spark-single.v1";
const RUNTIME_IMAGE_SCOPE =
  process.env.NEMOCLAW_LLAMA_CPP_RUNTIME_IMAGE_SCOPE ??
  (process.env.NEMOCLAW_E2E_PHASE_COLLECTION === "1" ? "published-base" : "");
const RUNTIME_IMAGE =
  process.env.NEMOCLAW_LLAMA_CPP_RUNTIME_IMAGE ??
  (process.env.NEMOCLAW_E2E_PHASE_COLLECTION === "1"
    ? `ghcr.io/nvidia/nemoclaw/llama-cpp-server@sha256:${"0".repeat(64)}`
    : "");
const TARGET_ID = process.env.E2E_TARGET_ID ?? "llama-cpp-generic-gpu";
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-llamacpp-gpu";
validateSandboxName(SANDBOX_NAME);
assert(
  /^published-base$/u.test(RUNTIME_IMAGE_SCOPE) &&
    /^[a-z0-9][a-z0-9._-]{0,159}$/u.test(RECIPE_ID) &&
    /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)?(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*@sha256:[0-9a-f]{64}$/u.test(
      RUNTIME_IMAGE,
    ),
  "invalid llama.cpp runtime image scope, recipe ID, or base-pinned image",
);
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
  return selected;
}

function loadGpuSetting() {
  const catalog = loadManagedInferenceCatalog();
  const recipe = catalog.recipes.find(({ metadata }) => metadata.id === RECIPE_ID);
  assert(
    recipe && isLlamaCppServingRecipe(recipe) && recipe.spec.runtime.image === RUNTIME_IMAGE,
    "GPU E2E llama.cpp recipe is missing or disagrees with the trusted PR-base image",
  );
  const modelFile = recipe.spec.model.files[0];
  assert(modelFile && "sizeBytes" in modelFile, "generic GPU E2E GGUF identity is incomplete");
  return { modelFile, recipe };
}

type ManagedContainerReceipt = NonNullable<ReturnType<typeof loadManagedLlamaCppReceipt>> & {
  runtime: Extract<
    NonNullable<ReturnType<typeof loadManagedLlamaCppReceipt>>["runtime"],
    { kind: "container" }
  >;
};

function requireExpectedManagedReceipt(
  receipt: ReturnType<typeof loadManagedLlamaCppReceipt>,
  expectedImage: string,
  expectedRuntimeId?: string,
): ManagedContainerReceipt {
  assert(
    receipt?.service === "llama-cpp" &&
      receipt.runtime.kind === "container" &&
      receipt.providerId === resolveNemoClawGatewayRuntime(env()) &&
      receipt.runtime.imageRef === expectedImage &&
      receipt.runtime.model?.recipeId === RECIPE_ID &&
      (expectedRuntimeId === undefined || receipt.runtime.runtimeId === expectedRuntimeId),
    "managed llama.cpp receipt does not match the selected recipe, runtime provider, image, or recovered runtime identity",
  );
  return receipt as ManagedContainerReceipt;
}

test(
  "installs managed llama.cpp, routes a real agent turn, and destroys its runtime (#8144, #9888)",
  {
    timeout: TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "validate exact source and NVIDIA GPU host",
        "run the declarative managed llama.cpp installer",
        "interrupt and recover the recorded managed runtime",
        "verify full GPU offload",
        "verify authenticated host and sandbox inference",
        "verify OpenClaw agent inference and owned cleanup",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, sandbox }) => {
    await artifacts.target.declare({
      id: TARGET_ID,
      boundary:
        "Exact NemoClaw source + published-base llama.cpp image on a Linux AMD64 RTX runner + Docker-qualified managed runtime + OpenShell sandbox route",
      configurationAuthority:
        "The exact source candidate owns orchestration; the base-published serving recipe supplies the runtime image, model, and serving values; the artifact does not qualify the PR-built llama.cpp image.",
      credentialBoundary:
        "The generated llama.cpp API key remains in owner-only host state and enters commands only through redacted process input.",
      prBuiltLlamaCppImageRuntimeQualified: false,
      runtimeImageScope: RUNTIME_IMAGE_SCOPE,
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
      env: env({
        NEMOCLAW_E2E_FAILURE_INJECTION: "1",
        NEMOCLAW_E2E_FORCE_FAIL_AT_STEP: "policies",
      }),
      timeoutMs: 75 * 60_000,
    });

    progress.phase("interrupt and recover the recorded managed runtime");
    const paths = managedLlamaCppStatePaths(os.homedir());
    const interruptedReceipt = requireExpectedManagedReceipt(
      loadManagedLlamaCppReceipt(paths),
      RUNTIME_IMAGE,
    );
    const interruptedRuntimeId = interruptedReceipt.runtime.runtimeId;
    const runtimeProvider = resolveRegisteredRuntimeProviderBundle(interruptedReceipt.providerId);
    assert(
      runtimeProvider?.hostLocalInference.supported === true &&
        runtimeProvider.hostLocalInference.services.includes("llama-cpp"),
      "receipt runtime provider does not expose managed llama.cpp authority",
    );
    const runtimeOperation = runtimeProvider.hostLocalInference.createOperation({ env: env() });
    runtimeOperation.assertAuthority();
    const stopRuntime = runtimeOperation.engine.capture(
      ["container", "stop", interruptedRuntimeId],
      60_000,
    );
    await artifacts.writeJson("stop-managed-llama-cpp-before-resume.json", {
      providerId: interruptedReceipt.providerId,
      runtimeId: interruptedRuntimeId,
      status: stopRuntime.status,
      error: stopRuntime.error?.message ?? null,
      stdout: stopRuntime.stdout,
      stderr: stopRuntime.stderr,
    });
    const resumeEnv = env();
    delete resumeEnv.NEMOCLAW_E2E_FAILURE_INJECTION;
    delete resumeEnv.NEMOCLAW_E2E_FORCE_FAIL_AT_STEP;
    delete resumeEnv.NEMOCLAW_LLAMACPP_RECIPE;
    delete resumeEnv.NEMOCLAW_PROVIDER;
    delete resumeEnv.NEMOCLAW_RECREATE_SANDBOX;
    const resume = await host.command(
      "node",
      [
        CLI_ENTRYPOINT,
        "onboard",
        "--resume",
        "--non-interactive",
        "--yes",
        "--yes-i-accept-third-party-software",
      ],
      {
        artifactName: "resume-managed-llama-cpp-after-runtime-stop",
        cwd: REPO_ROOT,
        env: resumeEnv,
        timeoutMs: 75 * 60_000,
      },
    );
    expect(
      install.exitCode === 1 &&
        resultText(install).includes("Forced onboarding failure at step 'policies'") &&
        stopRuntime.status === 0 &&
        stopRuntime.error === undefined &&
        resume.exitCode === 0,
      [
        resultText(install),
        JSON.stringify({
          error: stopRuntime.error?.message ?? null,
          status: stopRuntime.status,
          stderr: stopRuntime.stderr,
          stdout: stopRuntime.stdout,
        }),
        resultText(resume),
      ].join("\n"),
    ).toBe(true);

    progress.phase("verify full GPU offload");
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
    const receipt = requireExpectedManagedReceipt(
      loadManagedLlamaCppReceipt(paths),
      RUNTIME_IMAGE,
      interruptedRuntimeId,
    );
    const apiKey = loadManagedLlamaCppApiKey(managedLlamaCppStatePaths(os.homedir()));
    assert(apiKey, "managed llama.cpp API key is missing");
    artifacts.addRedactionValues([apiKey]);
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
    assert(managedLlamaProcess, "managed runtime does not contain one llama-server process");
    const managedLlamaPid = Number(managedLlamaProcess[0]);
    assert(
      Number.isSafeInteger(managedLlamaPid) && managedLlamaPid > 0,
      "invalid llama-server PID",
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
    expect(llamaGpuProcess, resultText(computeApps)).toBeDefined();
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
    expect(listAfterDestroy.exitCode, resultText(listAfterDestroy)).toBe(0);
    const inventory = JSON.parse(listAfterDestroy.stdout) as {
      sandboxes: Array<{ name: string }>;
    };
    expect(inventory.sandboxes.map(({ name }) => name)).not.toContain(SANDBOX_NAME);
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

    await artifacts.writeJson("qualification-evidence.json", {
      sourceCandidateSha: qualificationHeadSha,
      recipe: RECIPE_ID,
      runtimeImage: {
        reference: receipt.runtime.imageRef,
        sourceRevision: process.env.NEMOCLAW_LLAMA_CPP_RUNTIME_IMAGE_SOURCE_REVISION ?? null,
        scope: RUNTIME_IMAGE_SCOPE,
        prBuiltCandidateTested: false,
      },
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
        unauthorizedStatus: 401,
        hostChat: "passed",
        sandboxChat: "passed",
        openClawAgent: "passed",
        publicDestroy: "passed",
        providerCleanupReconciliation: cleanupProof.status,
      },
    });

    await artifacts.target.complete({
      id: TARGET_ID,
      status: "passed",
      candidateSha: qualificationHeadSha,
      candidateScope: "NemoClaw source only",
      fullGpuOffload: true,
      model: recipe.spec.model.servedName,
      prBuiltLlamaCppImageRuntimeQualified: false,
      runtimeImageReference: receipt.runtime.imageRef,
      runtimeImageScope: RUNTIME_IMAGE_SCOPE,
    });
  },
);
