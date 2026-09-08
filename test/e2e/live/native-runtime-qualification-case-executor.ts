// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  capturePodmanSocketAuthority,
  createPodmanContainerEngine,
  type PodmanBoundContainerEngine,
} from "../../../src/lib/adapters/podman/index.ts";
import type { RuntimeProviderLifecycleInput } from "../../../src/lib/onboard/runtime-provider/contract.ts";
import { createPodmanRuntimeProviderBundle } from "../../../src/lib/onboard/runtime-provider/podman.ts";
import {
  PODMAN_MANAGED_LABEL,
  PODMAN_SANDBOX_CONTAINER_PREFIX,
  PODMAN_SANDBOX_ID_LABEL,
  PODMAN_SANDBOX_NAME_LABEL,
  PODMAN_SANDBOX_NAMESPACE,
  PODMAN_SANDBOX_NAMESPACE_LABEL,
  PODMAN_SANDBOX_WORKSPACE,
  PODMAN_SANDBOX_WORKSPACE_LABEL,
} from "../../../src/lib/onboard/runtime-provider/podman-lifecycle.ts";
import type { SandboxEntry } from "../../../src/lib/state/registry/types.ts";
import { expect } from "../fixtures/e2e-test.ts";
import { spawnObservedChild } from "../fixtures/observed-child-process.ts";
import type { TestProgress } from "../fixtures/progress.ts";
import type {
  NativeRuntimeQualificationAcceleration,
  NativeRuntimeQualificationAgent,
  NativeRuntimeQualificationInference,
  NativeRuntimeQualificationObligation,
} from "../registry/native-runtime-qualification.ts";
import { nativeRuntimeQualificationOperationFile } from "../../../tools/e2e/native-runtime-qualification-producer-plan.mts";
import {
  assertCredentialFreeQualificationEnvironment,
  assertNativeRuntimeQualificationModelResource,
  digestFromImageReference,
  nativeRuntimeQualificationAgentImage,
  nativeRuntimeQualificationInferenceImage,
  nativeRuntimeQualificationPodmanExecutable,
  nativeRuntimeQualificationRunnerContractPath,
  parseNativeRuntimeQualificationRow,
  readNativeRuntimeQualificationRunnerContract,
} from "./native-runtime-qualification-case-helpers.ts";

const FULL_ID = /^[a-f0-9]{64}$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/gu;
// nvidia-smi defines the immutable UUID as alphanumeric; retain the repository's
// bounded physical GPU identifier envelope while excluding MIG device names.
const PHYSICAL_GPU_UUID = /^GPU-[A-Za-z0-9][A-Za-z0-9-]{6,121}[A-Za-z0-9]$/u;
const COMMAND_TIMEOUT = 60_000;
const INFERENCE_TIMEOUT = 900_000;
const QUALIFICATION_LABEL = "ai.nvidia.nemoclaw.qualification";
const LIFECYCLE_SANDBOX_NAMES = Object.freeze({
  hermes: "q-hermes",
  "langchain-deepagents-code": "q-deepagents",
  openclaw: "q-openclaw",
} as const satisfies Record<NativeRuntimeQualificationAgent, string>);
export const NATIVE_RUNTIME_QUALIFICATION_E2E_PHASES = [
  "validate credential-free Docker-unavailable isolation",
  "bind the rootless Podman engine",
  "launch exact local inference",
  "onboard the managed agent image",
  "exercise sandbox lifecycle and state recovery",
  "restart and reconcile inference",
  "prove exact cleanup",
  "emit bounded case evidence",
] as const;

interface PodmanNetworkAuthority {
  readonly id: string;
  readonly name: string;
  readonly gateway: string;
}

interface PodmanQualificationService {
  readonly child: ChildProcess;
  readonly diagnostic: () => string;
}

interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface GpuComputeProcess {
  readonly gpuUuid: string;
  readonly pid: number;
  readonly processName: string;
  readonly usedMemoryMiB: number;
}

function bounded(value: string): string {
  return value.replace(CONTROL, " ").replace(/\s+/gu, " ").trim().slice(-500);
}

function command(command: string, args: readonly string[]): CommandResult {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    env: process.env,
    timeout: 10_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  return {
    status: result.status ?? (result.signal ? 128 : 127),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

function requireCommand(executable: string, args: readonly string[], label: string): string {
  const result = command(executable, args);
  if (result.status !== 0) {
    throw new Error(
      `${label} failed with exit ${String(result.status)}: ${bounded(result.stderr || result.stdout)}`,
    );
  }
  return result.stdout.trim();
}

function capture(
  engine: PodmanBoundContainerEngine,
  args: readonly string[],
  label: string,
  timeout = COMMAND_TIMEOUT,
): string {
  const result = engine.capture(args, timeout);
  if (result.status !== 0 || result.error) {
    throw new Error(
      `${label} failed with exit ${String(result.status)}: ${bounded(result.stderr || result.stdout || result.error?.message || "unknown failure")}`,
    );
  }
  return result.stdout.trim();
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactDirectory(directory: string): void {
  const metadata = fs.lstatSync(directory);
  const uid = process.getuid?.() ?? -1;
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== uid ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error("Qualification receipt directory must be private and current-user owned");
  }
}

function removeQualificationSnapshot(snapshot: string | null): void {
  if (snapshot !== null) fs.rmSync(snapshot, { force: true });
}

function writeJson(directory: string, file: string, value: unknown): void {
  const target = path.join(directory, file);
  const temporary = `${target}.tmp`;
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(temporary, serialized, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  fs.renameSync(temporary, target);
}

function assertDockerUnavailable(): Record<string, true> {
  const guarded = command("docker", ["version"]);
  if (guarded.status !== 97) {
    throw new Error(`Docker PATH invocation guard returned ${String(guarded.status)}, expected 97`);
  }
  for (const executable of ["/usr/bin/docker", "/usr/local/bin/docker", "/snap/bin/docker"]) {
    if (!fs.existsSync(executable)) continue;
    const result = command(executable, ["version"]);
    if (result.status === 0)
      throw new Error(`Absolute Docker client remained usable: ${executable}`);
  }
  for (const socket of ["/var/run/docker.sock", "/run/docker.sock"]) {
    const metadata = fs.lstatSync(socket, { throwIfNoEntry: false });
    if (metadata?.isSocket()) throw new Error(`Docker socket remained available: ${socket}`);
  }
  for (const unit of ["docker.service", "docker.socket"]) {
    if (command("systemctl", ["is-active", "--quiet", unit]).status === 0) {
      throw new Error(`Docker unit remained active: ${unit}`);
    }
  }
  const proc = fs.readdirSync("/proc").filter((entry) => /^[1-9][0-9]*$/u.test(entry));
  for (const pid of proc) {
    try {
      if (fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "dockerd") {
        throw new Error("Docker daemon process remained active");
      }
    } catch (error) {
      if (error instanceof Error && error.message === "Docker daemon process remained active") {
        throw error;
      }
    }
  }
  return {
    dockerCommandGuarded: true,
    dockerServiceInactive: true,
    dockerSocketUnitInactive: true,
    dockerdProcessNameAbsent: true,
    defaultSocketPathsAbsent: true,
  };
}

async function waitForSocket(socket: string, service: PodmanQualificationService): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { child } = service;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Rootless Podman API service exited before its socket became ready (exit=${String(child.exitCode)}, signal=${String(child.signalCode)}): ${service.diagnostic() || "no bounded diagnostic"}`,
      );
    }
    const metadata = fs.lstatSync(socket, { throwIfNoEntry: false });
    if (metadata?.isSocket()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Rootless Podman API service did not create its socket");
}

function startPodmanQualificationService(
  socket: string,
  podmanExecutable: string,
  progress: TestProgress,
): PodmanQualificationService {
  let diagnostic = "";
  const child = spawnObservedChild(
    podmanExecutable,
    ["system", "service", "--time=0", `unix://${socket}`],
    {
      activityLabel: "command: rootless Podman qualification service",
      progress,
      spawn: { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    },
  );
  child.stderr?.on("data", (value: Buffer | string) => {
    diagnostic = bounded(`${diagnostic} ${String(value)}`);
  });
  return Object.freeze({ child, diagnostic: () => diagnostic });
}

async function stopService(child: ChildProcess | null, socket: string): Promise<void> {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (child.exitCode === null && child.signalCode === null) {
      if (!child.kill("SIGKILL")) {
        throw new Error("Rootless Podman API service rejected SIGKILL");
      }
      const killDeadline = Date.now() + 10_000;
      while (Date.now() < killDeadline && child.exitCode === null && child.signalCode === null) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (child.exitCode === null && child.signalCode === null) {
        throw new Error("Rootless Podman API service remained alive after SIGKILL");
      }
    }
  }
  fs.rmSync(socket, { force: true });
}

function createProviderNetwork(
  engine: PodmanBoundContainerEngine,
  name: string,
  caseId: string,
): PodmanNetworkAuthority {
  let created = false;
  try {
    const createdIdentity = capture(
      engine,
      ["network", "create", "--label", `${QUALIFICATION_LABEL}=${caseId}`, name],
      "provider network creation",
    );
    created = true;
    if (createdIdentity !== name && !FULL_ID.test(createdIdentity)) {
      throw new Error("Provider network creation returned an unexpected identity");
    }
    type NetworkInspection = {
      id?: unknown;
      labels?: unknown;
      name?: unknown;
      subnets?: Array<{ gateway?: unknown }>;
    };
    const inspect = (identity: string, label: string): NetworkInspection => {
      const inspected = JSON.parse(capture(engine, ["network", "inspect", identity], label)) as
        | NetworkInspection[]
        | unknown;
      if (!Array.isArray(inspected) || inspected.length !== 1) {
        throw new Error("Provider network inspection lacks one exact identity");
      }
      return inspected[0] as NetworkInspection;
    };
    const entry = inspect(createdIdentity, "provider network creation inspection");
    const id = typeof entry.id === "string" ? entry.id : "";
    const gateway = entry?.subnets?.[0]?.gateway;
    const labels =
      typeof entry.labels === "object" && entry.labels !== null && !Array.isArray(entry.labels)
        ? (entry.labels as Record<string, unknown>)
        : null;
    if (
      !FULL_ID.test(id) ||
      (FULL_ID.test(createdIdentity) && createdIdentity !== id) ||
      entry.name !== name ||
      typeof gateway !== "string" ||
      labels?.[QUALIFICATION_LABEL] !== caseId
    ) {
      throw new Error("Provider network inspection lacks exact identity");
    }
    const immutable = inspect(id, "provider network immutable-ID inspection");
    if (
      immutable.id !== id ||
      immutable.name !== name ||
      immutable.subnets?.[0]?.gateway !== gateway ||
      typeof immutable.labels !== "object" ||
      immutable.labels === null ||
      Array.isArray(immutable.labels) ||
      (immutable.labels as Record<string, unknown>)[QUALIFICATION_LABEL] !== caseId
    ) {
      throw new Error("Provider network identity changed after immutable-ID resolution");
    }
    return Object.freeze({ id, name, gateway });
  } catch (error) {
    if (created) {
      const removalOutcome = (() => {
        try {
          const removal = engine.capture(["network", "rm", "--force", name], COMMAND_TIMEOUT);
          return `exit ${String(removal.status)}`;
        } catch (cleanupError) {
          return `threw ${bounded(
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          )}`;
        }
      })();
      const existence = (() => {
        try {
          const result = engine.capture(["network", "exists", name], COMMAND_TIMEOUT);
          return { outcome: `exit ${String(result.status)}`, removalProven: result.status === 1 };
        } catch (cleanupError) {
          return {
            outcome: `threw ${bounded(
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            )}`,
            removalProven: false,
          };
        }
      })();
      if (!existence.removalProven) {
        const validationFailure = bounded(error instanceof Error ? error.message : String(error));
        throw new Error(
          `${validationFailure}; provider network cleanup could not prove removal (remove ${removalOutcome}; exists ${existence.outcome})`,
        );
      }
    }
    throw error;
  }
}

function pullPublicImage(engine: PodmanBoundContainerEngine, imageRef: string): void {
  capture(engine, ["pull", imageRef], `pull ${imageRef}`, INFERENCE_TIMEOUT);
  capture(engine, ["image", "exists", imageRef], `inspect pulled image ${imageRef}`);
}

function requirePreloadedImage(engine: PodmanBoundContainerEngine, imageRef: string): void {
  capture(engine, ["image", "exists", imageRef], `inspect preloaded image ${imageRef}`);
}

function parsePhysicalGpuDevices(output: string): readonly string[] {
  const devices = output
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort();
  if (
    devices.length === 0 ||
    new Set(devices).size !== devices.length ||
    devices.some((device) => !PHYSICAL_GPU_UUID.test(device))
  ) {
    throw new Error(
      `NVIDIA CDI runtime proof did not return exact physical GPU UUIDs: ${bounded(JSON.stringify(devices))}`,
    );
  }
  return Object.freeze(devices);
}

function proveGpuDevices(
  engine: PodmanBoundContainerEngine,
  probeImageRef: string,
): readonly string[] {
  return parsePhysicalGpuDevices(
    capture(
      engine,
      [
        "run",
        "--rm",
        "--pull=never",
        "--device",
        "nvidia.com/gpu=all",
        "--entrypoint",
        "nvidia-smi",
        probeImageRef,
        "--query-gpu=uuid",
        "--format=csv,noheader",
      ],
      "NVIDIA CDI runtime proof",
    ),
  );
}

function proveGpuBackedInference(
  engine: PodmanBoundContainerEngine,
  containerId: string,
  selectedDevices: readonly string[],
): readonly GpuComputeProcess[] {
  const output = capture(
    engine,
    [
      "exec",
      containerId,
      "nvidia-smi",
      "--query-compute-apps=gpu_uuid,pid,process_name,used_memory",
      "--format=csv,noheader,nounits",
    ],
    "GPU-backed inference process proof",
  );
  const processes = output
    .split(/\r?\n/u)
    .map((line) => line.split(",").map((field) => field.trim()))
    .filter((fields) => fields.length === 4)
    .map(([gpuUuid, pid, processName, usedMemoryMiB]) => ({
      gpuUuid: gpuUuid ?? "",
      pid: Number(pid),
      processName: processName ?? "",
      usedMemoryMiB: Number(usedMemoryMiB),
    }))
    .filter(
      (entry) =>
        selectedDevices.includes(entry.gpuUuid) &&
        Number.isSafeInteger(entry.pid) &&
        entry.pid > 0 &&
        entry.processName.length > 0 &&
        !/[\u0000-\u001f\u007f-\u009f]/u.test(entry.processName) &&
        Number.isSafeInteger(entry.usedMemoryMiB) &&
        entry.usedMemoryMiB > 0,
    );
  if (processes.length === 0) {
    throw new Error("Inference turn did not leave an exact GPU compute process proof");
  }
  return Object.freeze(processes.map((entry) => Object.freeze(entry)));
}

function inferenceFailureDiagnostic(
  engine: PodmanBoundContainerEngine,
  containerId: string,
): string {
  let result: ReturnType<PodmanBoundContainerEngine["capture"]>;
  try {
    result = engine.capture(
      ["inspect", "--format", "{{json .State}}", containerId],
      COMMAND_TIMEOUT,
    );
  } catch {
    return "state=unavailable; inspect=threw";
  }
  if (result.status !== 0) {
    return `state=unavailable; inspectExit=${String(result.status)}`;
  }
  try {
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "state=unparseable";
    }
    const knownStatuses = new Set([
      "configured",
      "created",
      "exited",
      "initialized",
      "paused",
      "removing",
      "running",
      "stopped",
      "stopping",
      "unknown",
    ]);
    return `state=${JSON.stringify({
      status:
        typeof parsed.Status === "string" && knownStatuses.has(parsed.Status)
          ? parsed.Status
          : "unknown",
      exitCode: Number.isSafeInteger(parsed.ExitCode) ? parsed.ExitCode : null,
      oomKilled: parsed.OOMKilled === true,
      running: parsed.Running === true,
    })}`;
  } catch {
    return "state=unparseable";
  }
}

type OwnedResourceKind = "container" | "network" | "volume";

type OwnedResourceGroup = {
  readonly engine: PodmanBoundContainerEngine;
  readonly identities: readonly string[];
  readonly kind: OwnedResourceKind;
};

function collectOwnedResourceCleanupFailures(groups: readonly OwnedResourceGroup[]): Error[] {
  const failures: Error[] = [];
  for (const { engine, identities, kind } of groups) {
    for (const identity of identities) {
      const outcomes: string[] = [];
      const removeArgs =
        kind === "container" ? ["rm", "--force", identity] : [kind, "rm", "--force", identity];
      try {
        const removal = engine.capture(removeArgs, COMMAND_TIMEOUT);
        if (removal.status !== 0) outcomes.push(`remove exit ${String(removal.status)}`);
      } catch {
        outcomes.push("remove threw");
      }
      try {
        const existence = engine.capture([kind, "exists", identity], COMMAND_TIMEOUT);
        if (existence.status !== 1) outcomes.push(`exists exit ${String(existence.status)}`);
      } catch {
        outcomes.push("exists threw");
      }
      if (outcomes.length > 0) {
        failures.push(
          new Error(
            `Native runtime qualification ${kind} cleanup failed for ${identity} (${outcomes.join("; ")})`,
          ),
        );
      }
    }
  }
  return failures;
}

function collectQualificationResourceCleanupFailures(input: {
  readonly inferenceContainers: readonly string[];
  readonly inferenceEngine: PodmanBoundContainerEngine | null;
  readonly lifecycleContainers: readonly string[];
  readonly lifecycleEngine: PodmanBoundContainerEngine | null;
  readonly networks: readonly string[];
  readonly volumes: readonly string[];
}): Error[] {
  return collectOwnedResourceCleanupFailures([
    ...(input.lifecycleEngine
      ? [
          {
            engine: input.lifecycleEngine,
            identities: input.lifecycleContainers,
            kind: "container" as const,
          },
          {
            engine: input.lifecycleEngine,
            identities: input.volumes,
            kind: "volume" as const,
          },
        ]
      : []),
    ...(input.inferenceEngine
      ? [
          {
            engine: input.inferenceEngine,
            identities: input.inferenceContainers,
            kind: "container" as const,
          },
          {
            engine: input.inferenceEngine,
            identities: input.networks,
            kind: "network" as const,
          },
        ]
      : []),
  ]);
}

function vllmServeArguments(model: string, port: number): readonly string[] {
  return [
    "vllm",
    "serve",
    "/models",
    "--served-model-name",
    model,
    "--host",
    "0.0.0.0",
    "--port",
    String(port),
    "--max-model-len",
    "2048",
  ];
}

function inferenceContainerPlan(input: {
  readonly acceleration: NativeRuntimeQualificationAcceleration;
  readonly caseId: string;
  readonly imageRef: string;
  readonly inference: NativeRuntimeQualificationInference;
  readonly model: string;
  readonly modelPath?: string;
  readonly name: string;
  readonly network: string;
  readonly port: number;
}): { readonly arguments: readonly string[]; readonly endpoint: string } {
  if ((input.inference === "nim" || input.inference === "vllm") && !input.modelPath) {
    throw new Error("Native runtime qualification GPU inference requires a model path");
  }
  return {
    arguments: [
      "run",
      "--detach",
      "--pull=never",
      "--name",
      input.name,
      "--network",
      input.network,
      "--label",
      `${QUALIFICATION_LABEL}=${input.caseId}`,
      ...(input.acceleration === "nvidia-gpu" ? ["--device", "nvidia.com/gpu=all"] : []),
      ...(input.inference === "nim"
        ? [
            "--shm-size",
            "16g",
            "--env",
            "NIM_MODEL_PATH=/models",
            "--env",
            `NIM_SERVED_MODEL_NAME=${input.model}`,
            "--volume",
            `${input.modelPath}:/models:ro`,
          ]
        : []),
      ...(input.inference === "vllm"
        ? ["--shm-size", "16g", "--volume", `${input.modelPath}:/models:ro`]
        : []),
      input.imageRef,
      ...(input.inference === "vllm" ? vllmServeArguments(input.model, input.port) : []),
    ],
    endpoint: `http://${input.name}:${String(input.port)}`,
  };
}

function createAgentContainer(input: {
  readonly engine: PodmanBoundContainerEngine;
  readonly imageRef: string;
  readonly name: string;
  readonly network: string;
  readonly qualificationId: string;
  readonly sandboxId: string;
  readonly sandboxName: string;
  readonly volume: string;
}): string {
  const id = capture(
    input.engine,
    [
      "run",
      "--detach",
      "--pull=never",
      "--name",
      input.name,
      "--network",
      input.network,
      "--label",
      `${PODMAN_MANAGED_LABEL}=true`,
      "--label",
      `${PODMAN_SANDBOX_NAME_LABEL}=${input.sandboxName}`,
      "--label",
      `${PODMAN_SANDBOX_ID_LABEL}=${input.sandboxId}`,
      "--label",
      `${PODMAN_SANDBOX_NAMESPACE_LABEL}=${PODMAN_SANDBOX_NAMESPACE}`,
      "--label",
      `${PODMAN_SANDBOX_WORKSPACE_LABEL}=${PODMAN_SANDBOX_WORKSPACE}`,
      "--label",
      `${QUALIFICATION_LABEL}=${input.qualificationId}`,
      "--volume",
      `${input.volume}:/qualification`,
      "--entrypoint",
      "/bin/sh",
      input.imageRef,
      "-c",
      "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done",
    ],
    "agent container creation",
    INFERENCE_TIMEOUT,
  );
  if (!FULL_ID.test(id)) throw new Error("Agent container did not return a full immutable ID");
  return id;
}

async function agentTurn(
  engine: PodmanBoundContainerEngine,
  containerId: string,
  endpoint: string,
  model: string,
  inference: NativeRuntimeQualificationInference,
): Promise<string> {
  const body = JSON.stringify({
    model,
    ...(inference === "ollama" ? { reasoning_effort: "none" } : {}),
    messages: [
      {
        role: "user",
        content:
          inference === "ollama"
            ? "/no_think\nReply with the single word qualified."
            : "Reply with the single word qualified.",
      },
    ],
    max_tokens: 128,
    stream: false,
  });
  const args = [
    "exec",
    containerId,
    "curl",
    "--fail-with-body",
    "--silent",
    "--show-error",
    "--connect-timeout",
    "5",
    "--max-time",
    "60",
    "--header",
    "Content-Type: application/json",
    "--data-binary",
    body,
    `${endpoint}/v1/chat/completions`,
  ];
  const deadline = Date.now() + 600_000;
  let output = "";
  let lastFailure = "inference request was not attempted";
  while (Date.now() < deadline) {
    const result = engine.capture(args, 90_000);
    if (result.status === 0 && !result.error) {
      output = result.stdout.trim();
      break;
    }
    lastFailure = bounded(result.stderr || result.stdout || result.error?.message || "failed");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (!output) throw new Error(`Agent inference turn did not become ready: ${lastFailure}`);
  const response = JSON.parse(output) as {
    model?: unknown;
    choices?: Array<{
      finish_reason?: unknown;
      message?: { content?: unknown; reasoning?: unknown; tool_calls?: unknown };
    }>;
  };
  const first = response.choices?.[0];
  const completeMessage =
    typeof first?.message?.content === "string" ||
    typeof first?.message?.reasoning === "string" ||
    Array.isArray(first?.message?.tool_calls);
  if (
    response.model !== model ||
    typeof first?.finish_reason !== "string" ||
    first.finish_reason === "length" ||
    !completeMessage
  ) {
    throw new Error(
      `Agent turn did not return a complete exact-model inference response (modelMatch=${String(response.model === model)}; finishReason=${typeof first?.finish_reason === "string" ? bounded(first.finish_reason) : typeof first?.finish_reason}; contentType=${typeof first?.message?.content}; reasoningType=${typeof first?.message?.reasoning}; toolCalls=${String(Array.isArray(first?.message?.tool_calls))})`,
    );
  }
  return sha256(output);
}

function lifecycleInput(agent: string, sandboxName: string): RuntimeProviderLifecycleInput {
  const sandbox: SandboxEntry = {
    agent,
    name: sandboxName,
    openshellDriver: "podman",
  };
  return {
    environment: process.env,
    log: () => undefined,
    sandbox,
    sandboxName,
  };
}

function lifecycleSandboxName(agent: NativeRuntimeQualificationAgent): string {
  return LIFECYCLE_SANDBOX_NAMES[agent];
}

function assertNoQualificationResidue(engine: PodmanBoundContainerEngine, caseId: string): void {
  for (const [resource, args] of [
    ["container", ["ps", "--all", "--quiet", "--filter", `label=${QUALIFICATION_LABEL}=${caseId}`]],
    ["volume", ["volume", "ls", "--quiet", "--filter", `label=${QUALIFICATION_LABEL}=${caseId}`]],
    ["network", ["network", "ls", "--quiet", "--filter", `label=${QUALIFICATION_LABEL}=${caseId}`]],
  ] as const) {
    if (capture(engine, args, `qualification ${resource} residue inspection`) !== "") {
      throw new Error(`Qualification cleanup left an owned ${resource}`);
    }
  }
}

export async function executeNativeRuntimeQualificationCase(progress: TestProgress): Promise<void> {
  progress.phase("validate credential-free Docker-unavailable isolation");
  assertCredentialFreeQualificationEnvironment(process.env);
  expect(process.platform).toBe("linux");
  const uid = process.getuid?.() ?? 0;
  expect(uid, "Native runtime qualification must execute as an unprivileged UID").toBeGreaterThan(
    0,
  );
  const row = parseNativeRuntimeQualificationRow(
    process.env.NEMOCLAW_NATIVE_RUNTIME_QUALIFICATION_ROW ?? "",
  );
  const expectedArchitecture = process.arch === "x64" ? "amd64" : process.arch;
  expect(expectedArchitecture).toBe(row.case.architecture);
  const receiptPath = process.env.NEMOCLAW_NATIVE_RUNTIME_QUALIFICATION_RECEIPT ?? "";
  expect(path.basename(receiptPath)).toBe("execution.json");
  const receiptDirectory = path.dirname(receiptPath);
  exactDirectory(receiptDirectory);

  const dockerBefore = assertDockerUnavailable();
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR ?? "";
  expect(runtimeDirectory).toBe(`/run/user/${String(uid)}`);
  const podmanExecutable = nativeRuntimeQualificationPodmanExecutable(process.env, uid);
  const socket = path.join(runtimeDirectory, "podman", "podman.sock");
  fs.mkdirSync(path.dirname(socket), { recursive: true, mode: 0o700 });

  let service: PodmanQualificationService | null = startPodmanQualificationService(
    socket,
    podmanExecutable,
    progress,
  );
  let hostEngine: PodmanBoundContainerEngine | null = null;
  let inferenceEngine: PodmanBoundContainerEngine | null = null;
  let lifecycleEngine: PodmanBoundContainerEngine | null = null;
  const ownedInferenceContainers = new Set<string>();
  const ownedLifecycleContainers = new Set<string>();
  const ownedVolumes = new Set<string>();
  const ownedNetworks = new Set<string>();
  let inferenceContainerId = "";
  let gpuDevices: readonly string[] = [];
  let gpuComputeProcesses: readonly GpuComputeProcess[] = [];
  let completed = false;
  let qualificationFailure: unknown;
  const cleanupFailures: unknown[] = [];
  let snapshot: string | null = null;
  const operationDetails = new Map<NativeRuntimeQualificationObligation, Record<string, unknown>>();

  try {
    progress.phase("bind the rootless Podman engine");
    await waitForSocket(socket, service);
    const socketAuthority = capturePodmanSocketAuthority(socket);
    hostEngine = createPodmanContainerEngine({
      executable: podmanExecutable,
      operation: "host-doctor",
      socketAuthority,
    });
    inferenceEngine = createPodmanContainerEngine({
      executable: podmanExecutable,
      operation: "host-local-inference",
      socketAuthority,
    });
    lifecycleEngine = createPodmanContainerEngine({
      executable: podmanExecutable,
      operation: "sandbox-lifecycle",
      socketAuthority,
    });
    const bundle = createPodmanRuntimeProviderBundle({
      engines: {
        hostDoctor: hostEngine,
        sandboxLifecycle: lifecycleEngine,
      },
    });
    expect(bundle.identity.id).toBe("podman");
    expect(bundle.workload.profile).toMatchObject({
      support: {
        exactDigestReferences: true,
        platforms: ["linux/amd64", "linux/arm64"],
      },
      hostArchitectures: ["amd64", "arm64"],
      managedImageSelectionPolicy: "require-managed",
      legacyDockerfileBuilds: false,
    });
    const hostInspection = bundle.preflightDoctor.inspectHost();
    if (hostInspection.status !== "ok") {
      throw new Error(`Podman host qualification failed: ${bounded(hostInspection.detail)}`);
    }
    const caseSuffix = sha256(row.id).slice(0, 12);
    const networkName = `nemoclaw-q-${caseSuffix}`;
    const network = createProviderNetwork(inferenceEngine, networkName, row.id);
    ownedNetworks.add(network.id);
    const runnerContractFile =
      row.case.acceleration === "nvidia-gpu"
        ? nativeRuntimeQualificationRunnerContractPath(process.env, uid)
        : undefined;
    const runnerContract = runnerContractFile
      ? readNativeRuntimeQualificationRunnerContract(row.case.architecture, runnerContractFile)
      : undefined;
    const agentImage = nativeRuntimeQualificationAgentImage(row.case.architecture, row.case.agent);
    const inference = nativeRuntimeQualificationInferenceImage({
      architecture: row.case.architecture,
      acceleration: row.case.acceleration,
      inference: row.case.inference,
      ...(runnerContract ? { runnerContract } : {}),
    });
    pullPublicImage(inferenceEngine, agentImage);
    if (row.case.inference === "ollama") pullPublicImage(inferenceEngine, inference.imageRef);
    else {
      if (!inference.modelPath || !runnerContractFile || !path.isAbsolute(inference.modelPath)) {
        throw new Error("Native runtime qualification GPU model path must be absolute");
      }
      requirePreloadedImage(inferenceEngine, inference.imageRef);
      assertNativeRuntimeQualificationModelResource(inference.modelPath, uid, runnerContractFile);
    }
    if (runnerContract) {
      requirePreloadedImage(inferenceEngine, runnerContract.gpuProbeImageRef);
    }

    const inferenceName = `nemoclaw-inference-${caseSuffix}`;
    progress.phase("launch exact local inference");
    const inferencePort = row.case.inference === "ollama" ? 11434 : 8000;
    const inferencePlan = inferenceContainerPlan({
      acceleration: row.case.acceleration,
      caseId: row.id,
      imageRef: inference.imageRef,
      inference: row.case.inference,
      model: inference.model,
      ...(inference.modelPath ? { modelPath: inference.modelPath } : {}),
      name: inferenceName,
      network: network.name,
      port: inferencePort,
    });
    inferenceContainerId = capture(
      inferenceEngine,
      inferencePlan.arguments,
      `${row.case.inference} container start`,
      INFERENCE_TIMEOUT,
    );
    if (!FULL_ID.test(inferenceContainerId)) {
      throw new Error("Inference container did not return a full immutable ID");
    }
    ownedInferenceContainers.add(inferenceContainerId);
    if (row.case.inference === "ollama") {
      capture(
        inferenceEngine,
        ["exec", inferenceContainerId, "ollama", "pull", inference.model],
        "Ollama model acquisition",
        INFERENCE_TIMEOUT,
      );
    }
    if (row.case.acceleration === "nvidia-gpu") {
      if (!runnerContract) throw new Error("GPU runner contract is unavailable");
      gpuDevices = proveGpuDevices(inferenceEngine, runnerContract.gpuProbeImageRef);
    }

    const sandboxId = caseSuffix;
    progress.phase("onboard the managed agent image");
    const sandboxName = lifecycleSandboxName(row.case.agent);
    const agentName = `${PODMAN_SANDBOX_CONTAINER_PREFIX}${sandboxName}-${sandboxId}`;
    const volumeName = `nemoclaw-q-state-${caseSuffix}`;
    capture(
      lifecycleEngine,
      ["volume", "create", "--label", `${QUALIFICATION_LABEL}=${row.id}`, volumeName],
      "agent volume creation",
    );
    ownedVolumes.add(volumeName);
    let agentId = createAgentContainer({
      engine: lifecycleEngine,
      imageRef: agentImage,
      name: agentName,
      network: network.name,
      qualificationId: row.id,
      sandboxId,
      sandboxName,
      volume: volumeName,
    });
    ownedLifecycleContainers.add(agentId);
    capture(
      lifecycleEngine,
      ["exec", agentId, "/bin/sh", "-c", "printf '%s\\n' qualified >/qualification/state"],
      "agent state initialization",
    );
    operationDetails.set("agent.onboard", {
      containerId: agentId,
      agent: row.case.agent,
      imageDigest: digestFromImageReference(agentImage),
    });

    const turnSha256 = await agentTurn(
      lifecycleEngine,
      agentId,
      inferencePlan.endpoint,
      inference.model,
      row.case.inference,
    );
    if (row.case.acceleration === "nvidia-gpu") {
      gpuComputeProcesses = proveGpuBackedInference(
        inferenceEngine,
        inferenceContainerId,
        gpuDevices,
      );
    }
    operationDetails.set("agent.turn", {
      protocol: "openai-chat-completions",
      model: inference.model,
      responseSha256: turnSha256,
      route: "provider-network-dns",
    });

    if (!bundle.lifecycle.supported) throw new Error("Podman lifecycle surface is unavailable");
    progress.phase("exercise sandbox lifecycle and state recovery");
    const lifecycle = bundle.lifecycle;
    const input = lifecycleInput(row.case.agent, sandboxName);
    let beforeStopCalled = false;
    const firstStop = lifecycle.stop(input, {
      beforeStop: () => {
        beforeStopCalled = true;
      },
    });
    if (firstStop.exitCode !== 0) {
      throw new Error(`Initial sandbox stop failed: ${bounded(firstStop.message ?? "unknown")}`);
    }
    expect(firstStop.state).toBe("stopped");
    expect(beforeStopCalled).toBe(true);
    expect(lifecycle.start(input)).toEqual({ exitCode: 0 });
    operationDetails.set("sandbox.stop-start", {
      containerId: agentId,
      executionPath: "runtime-provider-bundle",
      stoppedAndStarted: true,
    });

    snapshot = path.join(os.tmpdir(), `nemoclaw-q-${caseSuffix}.tar`);
    const snapshotStop = lifecycle.stop(input, { beforeStop: () => undefined });
    if (snapshotStop.exitCode !== 0) {
      throw new Error(
        `Snapshot sandbox stop failed: ${bounded(snapshotStop.message ?? "unknown")}`,
      );
    }
    capture(
      lifecycleEngine,
      ["volume", "export", "--output", snapshot, volumeName],
      "sandbox volume snapshot",
      INFERENCE_TIMEOUT,
    );
    const snapshotBytes = fs.readFileSync(snapshot);
    const snapshotSha256 = sha256(snapshotBytes);
    expect(lifecycle.start(input)).toEqual({ exitCode: 0 });
    capture(
      lifecycleEngine,
      ["exec", agentId, "/bin/sh", "-c", "printf '%s\\n' drifted >/qualification/state"],
      "sandbox state mutation",
    );
    capture(lifecycleEngine, ["rm", "--force", agentId], "remove sandbox before rebuild");
    ownedLifecycleContainers.delete(agentId);
    capture(lifecycleEngine, ["volume", "rm", volumeName], "remove sandbox volume");
    ownedVolumes.delete(volumeName);
    capture(
      lifecycleEngine,
      ["volume", "create", "--label", `${QUALIFICATION_LABEL}=${row.id}`, volumeName],
      "recreate sandbox volume",
    );
    ownedVolumes.add(volumeName);
    capture(
      lifecycleEngine,
      ["volume", "import", volumeName, snapshot],
      "restore sandbox volume snapshot",
      INFERENCE_TIMEOUT,
    );
    agentId = createAgentContainer({
      engine: lifecycleEngine,
      imageRef: agentImage,
      name: agentName,
      network: network.name,
      qualificationId: row.id,
      sandboxId,
      sandboxName,
      volume: volumeName,
    });
    ownedLifecycleContainers.add(agentId);
    expect(
      capture(lifecycleEngine, ["exec", agentId, "cat", "/qualification/state"], "restored state"),
    ).toBe("qualified");
    operationDetails.set("sandbox.snapshot-restore", {
      snapshotSha256,
      restoredStateSha256: sha256("qualified\n"),
    });
    operationDetails.set("sandbox.rebuild", {
      priorContainerReplaced: true,
      rebuiltContainerId: agentId,
      preservedState: true,
    });

    const focusedResults: Record<string, unknown> = Object.create(null);
    if (row.focusedOperations.length > 0) {
      const cloneVolume = `${volumeName}-clone`;
      const cloneName = `${agentName}-clone`;
      capture(
        lifecycleEngine,
        ["volume", "create", "--label", `${QUALIFICATION_LABEL}=${row.id}`, cloneVolume],
        "clone volume creation",
      );
      ownedVolumes.add(cloneVolume);
      capture(
        lifecycleEngine,
        ["volume", "import", cloneVolume, snapshot],
        "clone volume restore",
        INFERENCE_TIMEOUT,
      );
      const cloneId = createAgentContainer({
        engine: lifecycleEngine,
        imageRef: agentImage,
        name: cloneName,
        network: network.name,
        qualificationId: row.id,
        sandboxId: `${sandboxId}c`,
        sandboxName: `${sandboxName}-clone`,
        volume: cloneVolume,
      });
      ownedLifecycleContainers.add(cloneId);
      expect(
        capture(lifecycleEngine, ["exec", cloneId, "cat", "/qualification/state"], "clone state"),
      ).toBe("qualified");
      const duplicate = lifecycleEngine.capture([
        "run",
        "--detach",
        "--pull=never",
        "--name",
        agentName,
        "--entrypoint",
        "/bin/sh",
        agentImage,
        "-c",
        "exit 0",
      ]);
      if (duplicate.status === 0) throw new Error("Podman allowed unsafe managed-name reuse");
      capture(lifecycleEngine, ["kill", "--signal", "KILL", agentId], "sandbox crash injection");
      expect(lifecycle.start(input)).toEqual({ exitCode: 0 });
      expect(
        capture(
          lifecycleEngine,
          ["exec", agentId, "cat", "/qualification/state"],
          "recovered state",
        ),
      ).toBe("qualified");
      focusedResults.clone = { cloneContainerId: cloneId, restored: true };
      focusedResults.backup = {
        sha256: snapshotSha256,
        bytes: snapshotBytes.length,
      };
      focusedResults["crash-recovery"] = {
        signal: "SIGKILL",
        recovered: true,
      };
      focusedResults.rollback = { restoredSnapshotSha256: snapshotSha256 };
      focusedResults["name-reuse"] = { rejected: true };
    }

    if (!inferenceContainerId) throw new Error("Inference runtime identity is missing");
    progress.phase("restart and reconcile inference");
    capture(
      inferenceEngine,
      ["restart", inferenceContainerId],
      `${row.case.inference} runtime restart`,
      INFERENCE_TIMEOUT,
    );
    const reconciledTurnSha256 = await agentTurn(
      lifecycleEngine,
      agentId,
      inferencePlan.endpoint,
      inference.model,
      row.case.inference,
    );
    const reconciledGpuComputeProcesses =
      row.case.acceleration === "nvidia-gpu"
        ? proveGpuBackedInference(inferenceEngine, inferenceContainerId, gpuDevices)
        : [];
    operationDetails.set("runtime.restart-reconcile", {
      service: row.case.inference,
      runtimeIdentity: inferenceContainerId,
      responseSha256: reconciledTurnSha256,
      gpuComputeProcesses: reconciledGpuComputeProcesses,
      revalidated: true,
    });

    operationDetails.set("installer.install", {
      authority: "trusted-installer-step",
      candidateSha: row.source.candidateSha,
      installerSha256: row.installerSha256,
    });
    const rootfulSelectionDenied = row.rootModes.includes("rootful")
      ? command("podman", ["--root", "/var/lib/containers/storage", "info"]).status !== 0
      : true;
    if (!rootfulSelectionDenied) {
      throw new Error(
        "Unprivileged qualification unexpectedly obtained a rootful Podman storage authority",
      );
    }
    operationDetails.set("runtime.docker-unavailable", {
      beforeCandidate: dockerBefore,
      rootfulSelectionDenied,
      executedRootMode: "rootless",
    });

    progress.phase("prove exact cleanup");
    capture(lifecycleEngine, ["rm", "--force", agentId], "agent cleanup");
    ownedLifecycleContainers.delete(agentId);
    for (const containerId of [...ownedLifecycleContainers]) {
      capture(lifecycleEngine, ["rm", "--force", containerId], "focused container cleanup");
      ownedLifecycleContainers.delete(containerId);
    }
    for (const volume of [...ownedVolumes]) {
      capture(lifecycleEngine, ["volume", "rm", volume], "qualification volume cleanup");
      ownedVolumes.delete(volume);
    }
    capture(inferenceEngine, ["rm", "--force", inferenceContainerId], "inference runtime cleanup");
    ownedInferenceContainers.delete(inferenceContainerId);
    capture(inferenceEngine, ["network", "rm", network.id], "provider network cleanup");
    ownedNetworks.delete(network.id);
    removeQualificationSnapshot(snapshot);
    snapshot = null;
    assertNoQualificationResidue(lifecycleEngine, row.id);
    operationDetails.set("cleanup.exact", {
      containersRemaining: 0,
      volumesRemaining: 0,
      networksRemaining: 0,
    });

    if (row.focusedOperations.length > 0) {
      Object.assign(focusedResults, {
        restart: operationDetails.get("runtime.restart-reconcile"),
        rebuild: operationDetails.get("sandbox.rebuild"),
        "snapshot-restore": operationDetails.get("sandbox.snapshot-restore"),
        installer: operationDetails.get("installer.install"),
        cleanup: operationDetails.get("cleanup.exact"),
      });
      const missing = row.focusedOperations.filter(
        (operation) => !Object.hasOwn(focusedResults, operation),
      );
      if (missing.length > 0) {
        throw new Error(`Focused qualification operations are incomplete: ${missing.join(", ")}`);
      }
    }

    const dockerAfter = assertDockerUnavailable();
    progress.phase("emit bounded case evidence");
    const podmanVersion = requireCommand("podman", ["--version"], "Podman version");
    const managedImages = [
      { role: "agent", digest: digestFromImageReference(agentImage) },
      {
        role: "inference",
        digest: digestFromImageReference(inference.imageRef),
      },
      ...(runnerContract
        ? [
            {
              role: "gpu-probe",
              digest: digestFromImageReference(runnerContract.gpuProbeImageRef),
            },
          ]
        : []),
    ];
    writeJson(receiptDirectory, "runtime-result.json", {
      schemaVersion: 1,
      kind: "nemoclaw-native-runtime-qualification-runtime-v1",
      caseId: row.id,
      result: "passed",
      details: {
        providerId: "podman",
        executionPath: "runtime-provider-bundle",
        rootMode: "rootless",
        podmanVersion,
        inferenceService: row.case.inference,
        modelRevision: inference.modelRevision ?? null,
        focusedOperations: focusedResults,
        dockerBefore,
        dockerAfter,
      },
    });
    for (const obligation of row.case.obligations) {
      const details = operationDetails.get(obligation);
      if (!details) throw new Error(`Qualification operation '${obligation}' was not executed`);
      writeJson(receiptDirectory, nativeRuntimeQualificationOperationFile(obligation), {
        schemaVersion: 1,
        kind: "nemoclaw-native-runtime-qualification-operation-v1",
        caseId: row.id,
        operationId: obligation,
        result: "passed",
        details,
      });
    }
    if (row.case.acceleration === "nvidia-gpu") {
      writeJson(receiptDirectory, "nvidia-cdi.json", {
        schemaVersion: 1,
        kind: "nemoclaw-native-runtime-qualification-nvidia-cdi-v1",
        caseId: row.id,
        result: "passed",
        details: {
          requested: "nvidia.com/gpu=all",
          selectedDevices: gpuDevices,
          inferenceRuntimeId: inferenceContainerId,
          inferenceComputeProcesses: gpuComputeProcesses,
        },
      });
    }
    writeJson(receiptDirectory, "case-evidence.json", {
      schemaVersion: 1,
      kind: "nemoclaw-native-runtime-qualification-case-details-v1",
      caseId: row.id,
      runtime: {
        engineName: "Podman",
        engineVersion: podmanVersion.replace(/^podman version\s+/u, ""),
        managedImages,
        resultFile: "runtime-result.json",
      },
      operations: row.case.obligations.map((id) => ({
        id,
        file: nativeRuntimeQualificationOperationFile(id),
      })),
      ...(row.case.acceleration === "nvidia-gpu"
        ? {
            nvidiaCdi: {
              device: "nvidia.com/gpu=all",
              file: "nvidia-cdi.json",
            },
          }
        : {}),
    });
    writeJson(receiptDirectory, "execution.json", {
      schemaVersion: 1,
      kind: "nemoclaw-native-runtime-qualification-execution-v1",
      caseId: row.id,
      candidateSha: row.source.candidateSha,
      installerSha256: row.installerSha256,
      architecture: row.case.architecture,
      acceleration: row.case.acceleration,
      agent: row.case.agent,
      inference: row.case.inference,
      rootModes: row.rootModes,
      obligations: row.case.obligations,
      focusedOperations: row.focusedOperations,
      evidenceKinds: row.case.evidenceKinds,
      dockerUnavailable: { beforeCandidate: true, afterCandidate: true },
      credentialBoundary: {
        githubCredentialsAbsent: true,
        modelCredentialsAbsent: true,
        isolatedUid: true,
      },
      result: "passed",
    });
    completed = true;
  } catch (error) {
    qualificationFailure = error;
  } finally {
    try {
      removeQualificationSnapshot(snapshot);
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (!completed) {
      if (inferenceEngine && FULL_ID.test(inferenceContainerId)) {
        console.error(
          `Native runtime qualification inference failure diagnostic: ${inferenceFailureDiagnostic(inferenceEngine, inferenceContainerId)}`,
        );
      }
      cleanupFailures.push(
        ...collectQualificationResourceCleanupFailures({
          inferenceContainers: [...ownedInferenceContainers],
          inferenceEngine,
          lifecycleContainers: [...ownedLifecycleContainers],
          lifecycleEngine,
          networks: [...ownedNetworks],
          volumes: [...ownedVolumes],
        }),
      );
    }
    try {
      await stopService(service?.child ?? null, socket);
    } catch (error) {
      cleanupFailures.push(error);
    }
    service = null;
  }
  if (cleanupFailures.length > 0 && qualificationFailure === undefined) {
    throw new AggregateError(cleanupFailures, "Native runtime qualification cleanup failed");
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      [qualificationFailure, ...cleanupFailures],
      "Native runtime qualification failed and cleanup could not be proven",
    );
  }
  if (qualificationFailure !== undefined) {
    throw qualificationFailure;
  }
}

export const nativeRuntimeQualificationCaseInternals = Object.freeze({
  collectOwnedResourceCleanupFailures,
  collectQualificationResourceCleanupFailures,
  createProviderNetwork,
  inferenceContainerPlan,
  inferenceFailureDiagnostic,
  lifecycleSandboxName,
  parsePhysicalGpuDevices,
  proveGpuDevices,
  removeQualificationSnapshot,
  vllmServeArguments,
});
