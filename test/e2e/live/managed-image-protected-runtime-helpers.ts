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
import { PROTECTED_MANAGED_IMAGE_COHORT_PATTERN } from "../../../scripts/checks/protected-managed-image-contract.ts";
import {
  adoptServedModelId,
  dockerLoginNgc,
  pullNimImage,
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
const NIM_CATALOG_MODEL = "nvidia/nemotron-3-nano-30b-a3b";
const AGENT_QUALIFICATION_TIMEOUT_MS = 10 * 60_000;
const ROLLBACK_QUALIFICATION_TIMEOUT_MS = 10 * 60_000;
const PROTECTED_READINESS_CAPTURE_LIMIT_BYTES = 4 * 1024 * 1024;
const PROTECTED_PROVIDER_CONTAINER_MAX_LENGTH = 63;

export const PROTECTED_PROVIDER_OWNER_LABEL = "io.nvidia.nemoclaw.e2e-owner";
export const PROTECTED_PROVIDER_KIND_LABEL = "io.nvidia.nemoclaw.e2e-provider";

export type ProtectedProviderKind = "nim" | "vllm";

export interface ProtectedProviderContainerAuthority {
  readonly containerId: string;
  readonly imageId: string;
  readonly kind: ProtectedProviderKind;
  readonly name: string;
  readonly owner: string;
  readonly requestedImage: string;
}

interface ProtectedProviderContainerState {
  authority: ProtectedProviderContainerAuthority | null;
  readonly kind: ProtectedProviderKind;
  readonly name: string;
  readonly owner: string;
  removed: boolean;
  reportedContainerId: string | null;
}

type RuntimeFixtures = Pick<E2ETargetFixtures, "artifacts" | "cleanup" | "host" | "progress">;

interface ProtectedRuntimeReadinessCommand {
  readonly command: "bash";
  readonly args: string[];
  readonly captureLimitBytes: number;
}

export function protectedProviderContainerName(
  kind: ProtectedProviderKind,
  cohort = process.env.NEMOCLAW_PROTECTED_MANAGED_IMAGE_COHORT ?? "",
): string {
  if (!PROTECTED_MANAGED_IMAGE_COHORT_PATTERN.test(cohort)) {
    throw new Error("NEMOCLAW_PROTECTED_MANAGED_IMAGE_COHORT has an invalid protected cohort");
  }
  const name = `nemoclaw-mi-${kind}-${cohort}`;
  if (
    name.length > PROTECTED_PROVIDER_CONTAINER_MAX_LENGTH ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(name)
  ) {
    throw new Error("protected provider container name is outside the Docker name contract");
  }
  return name;
}

export function protectedProviderReportedContainerId(name: string, stdout: string): string {
  if (
    name.length > PROTECTED_PROVIDER_CONTAINER_MAX_LENGTH ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(name)
  ) {
    throw new Error("protected provider container name is outside the Docker name contract");
  }
  const candidate = stdout.trim();
  if (!/^[a-f0-9]{64}$/u.test(candidate)) {
    throw new Error(`provider start did not report one full container ID for ${name}`);
  }
  return candidate;
}

function assertProviderAuthority(authority: ProtectedProviderContainerAuthority): void {
  if (
    !/^[a-f0-9]{64}$/u.test(authority.containerId) ||
    !/^sha256:[a-f0-9]{64}$/u.test(authority.imageId) ||
    !PROTECTED_MANAGED_IMAGE_COHORT_PATTERN.test(authority.owner) ||
    protectedProviderContainerName(authority.kind, authority.owner) !== authority.name ||
    !authority.requestedImage ||
    /[\0\r\n|]/u.test(authority.requestedImage)
  ) {
    throw new Error("protected provider container authority is invalid");
  }
}

export function protectedProviderContainerPreflightCommand(
  name: string,
): ProtectedRuntimeReadinessCommand {
  if (
    name.length > PROTECTED_PROVIDER_CONTAINER_MAX_LENGTH ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(name)
  ) {
    throw new Error("protected provider container name is outside the Docker name contract");
  }
  return {
    command: "bash",
    captureLimitBytes: PROTECTED_READINESS_CAPTURE_LIMIT_BYTES,
    args: [
      "--noprofile",
      "--norc",
      "-c",
      [
        "set -euo pipefail",
        'expected_name="$1"',
        'rows="$(docker ps -a --no-trunc --filter "name=^/${expected_name}$" --format \'{{.ID}}\')" || {',
        "  printf 'provider container preflight is indeterminate for %s\\n' \"$expected_name\" >&2",
        "  exit 70",
        "}",
        '[[ -z "$rows" ]] || {',
        '  printf \'refusing to replace pre-existing provider container %s: %s\\n\' "$expected_name" "$rows" >&2',
        "  exit 70",
        "}",
        "printf 'provider-container-absent name=%s\\n' \"$expected_name\"",
      ].join("\n"),
      "protected-provider-preflight",
      name,
    ],
  };
}

export function protectedProviderContainerCleanupCommand(
  authority: ProtectedProviderContainerAuthority,
): ProtectedRuntimeReadinessCommand {
  assertProviderAuthority(authority);
  return {
    command: "bash",
    captureLimitBytes: PROTECTED_READINESS_CAPTURE_LIMIT_BYTES,
    args: [
      "--noprofile",
      "--norc",
      "-c",
      [
        "set -euo pipefail",
        'expected_name="$1"',
        'expected_id="$2"',
        'expected_image="$3"',
        'expected_image_id="$4"',
        'expected_owner="$5"',
        'expected_kind="$6"',
        `owner_label=${JSON.stringify(PROTECTED_PROVIDER_OWNER_LABEL)}`,
        `kind_label=${JSON.stringify(PROTECTED_PROVIDER_KIND_LABEL)}`,
        'name_rows="$(docker ps -a --no-trunc --filter "name=^/${expected_name}$" --format \'{{.ID}}\')" || {',
        "  printf 'provider cleanup inventory is indeterminate for %s\\n' \"$expected_name\" >&2",
        "  exit 70",
        "}",
        '[[ -n "$name_rows" ]] || {',
        "  printf 'provider cleanup evidence is missing for %s\\n' \"$expected_name\" >&2",
        "  exit 70",
        "}",
        "[[ \"$name_rows\" != *$'\\n'* ]] || {",
        '  printf \'provider cleanup evidence is ambiguous for %s: %s\\n\' "$expected_name" "$name_rows" >&2',
        "  exit 70",
        "}",
        '[[ "$name_rows" == "$expected_id" ]] || {',
        '  printf \'provider container name %s was reused: expected %s, got %s\\n\' "$expected_name" "$expected_id" "$name_rows" >&2',
        "  exit 70",
        "}",
        'inspection="$(docker container inspect --format \'{{.Id}}|{{.Name}}|{{.Config.Image}}|{{.Image}}|{{ index .Config.Labels "io.nvidia.nemoclaw.e2e-owner" }}|{{ index .Config.Labels "io.nvidia.nemoclaw.e2e-provider" }}\' "$expected_id")" || {',
        "  printf 'provider authority inspection is indeterminate for %s\\n' \"$expected_name\" >&2",
        "  exit 70",
        "}",
        "IFS='|' read -r actual_id actual_name actual_image actual_image_id actual_owner actual_kind extra <<<\"$inspection\"",
        '[[ -z "${extra:-}" && "$actual_id" == "$expected_id" && "$actual_name" == "/$expected_name" && "$actual_image" == "$expected_image" && "$actual_image_id" == "$expected_image_id" && "$actual_owner" == "$expected_owner" && "$actual_kind" == "$expected_kind" ]] || {',
        "  printf 'provider cleanup authority drifted for %s; refusing removal\\n' \"$expected_name\" >&2",
        "  exit 70",
        "}",
        'docker rm -f "$expected_id" >/dev/null || {',
        "  printf 'provider cleanup removal is indeterminate for %s\\n' \"$expected_name\" >&2",
        "  exit 70",
        "}",
        'id_rows="$(docker ps -a --no-trunc --filter "id=${expected_id}" --format \'{{.ID}}\')" || {',
        "  printf 'provider cleanup ID verification is indeterminate for %s\\n' \"$expected_name\" >&2",
        "  exit 70",
        "}",
        'name_rows="$(docker ps -a --no-trunc --filter "name=^/${expected_name}$" --format \'{{.ID}}\')" || {',
        "  printf 'provider cleanup name verification is indeterminate for %s\\n' \"$expected_name\" >&2",
        "  exit 70",
        "}",
        '[[ -z "$id_rows" && -z "$name_rows" ]] || {',
        '  printf \'provider cleanup retained or replaced %s: id=%s name=%s\\n\' "$expected_name" "$id_rows" "$name_rows" >&2',
        "  exit 70",
        "}",
        'printf \'provider-container-removed name=%s id=%s image=%s image_id=%s %s=%s %s=%s\\n\' "$expected_name" "$expected_id" "$expected_image" "$expected_image_id" "$owner_label" "$expected_owner" "$kind_label" "$expected_kind"',
      ].join("\n"),
      "protected-provider-cleanup",
      authority.name,
      authority.containerId,
      authority.requestedImage,
      authority.imageId,
      authority.owner,
      authority.kind,
    ],
  };
}

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

export const PROTECTED_OLLAMA_READY_ATTEMPTS = 20;
export const PROTECTED_OLLAMA_CURL_MAX_SECONDS = 5;
export const PROTECTED_OLLAMA_READY_SLEEP_SECONDS = 1;
export const PROTECTED_OLLAMA_START_TIMEOUT_MS = 150_000;

export function protectedOllamaStartScript(logPath: string): string {
  if (!path.isAbsolute(logPath) || /[\0\r\n]/u.test(logPath)) {
    throw new Error(`protected Ollama log path must be absolute: ${JSON.stringify(logPath)}`);
  }
  const logPathLiteral = `'${logPath.replaceAll("'", "'\\''")}'`;
  return `set -euo pipefail
log_path=${logPathLiteral}
: >"$log_path"
restart_mode=''
sudo_prefix=()
if [ "$(id -u)" -eq 0 ]; then
  sudo_prefix=()
elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  sudo_prefix=(sudo -n)
fi

diagnose_ollama() {
  tail -n 200 "$log_path" >&2 || true
  if [ "$restart_mode" = system ]; then
    "\${sudo_prefix[@]}" journalctl -u ollama.service --no-pager -n 200 >&2 || true
  elif [ "$restart_mode" = user ]; then
    journalctl --user -u ollama.service --no-pager -n 200 >&2 || true
  fi
}

system_service=0
if command -v systemctl >/dev/null 2>&1 &&
  systemctl cat ollama.service >/dev/null 2>&1; then
  system_service=1
fi

if [ "$system_service" -eq 1 ]; then
  restart_mode=system
  if [ "$(id -u)" -ne 0 ] && [ "\${#sudo_prefix[@]}" -eq 0 ]; then
    echo 'Ollama system service is installed but cannot be restarted without root or passwordless sudo' >&2
    exit 1
  fi
  if ! "\${sudo_prefix[@]}" systemctl restart ollama.service; then
    echo 'Ollama system service restart failed' >&2
    diagnose_ollama
    exit 1
  fi
elif command -v systemctl >/dev/null 2>&1 && systemctl --user restart ollama.service; then
  restart_mode=user
else
  nohup setsid -f env OLLAMA_HOST=127.0.0.1:11434 ollama serve >"$log_path" 2>&1
  restart_mode=manual
fi

for _ in $(seq 1 ${PROTECTED_OLLAMA_READY_ATTEMPTS}); do
  if curl -fsS --connect-timeout 2 --max-time ${PROTECTED_OLLAMA_CURL_MAX_SECONDS} http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    printf 'restart_mode=%s\n' "$restart_mode"
    exit 0
  fi
  if [ "$restart_mode" = system ] &&
    "\${sudo_prefix[@]}" systemctl is-failed --quiet ollama.service; then
    echo 'Ollama system service failed before becoming ready' >&2
    diagnose_ollama
    exit 1
  fi
  sleep ${PROTECTED_OLLAMA_READY_SLEEP_SECONDS}
done

echo 'Ollama did not become ready on 127.0.0.1:11434' >&2
diagnose_ollama
exit 1`;
}

export function protectedOllamaReadinessCommand(logPath: string): ProtectedRuntimeReadinessCommand {
  const startScript = protectedOllamaStartScript(logPath);
  return {
    command: "bash",
    captureLimitBytes: PROTECTED_READINESS_CAPTURE_LIMIT_BYTES,
    args: [
      "-c",
      `(
${startScript}
)
status=$?
if [ "$status" -eq 0 ]; then
  printf 'managed-image-ollama-ready\n'
else
  printf 'managed-image-ollama-not-ready status=%s\n' "$status" >&2
fi
exit "$status"`,
    ],
  };
}

export async function startProtectedOllama(host: HostCliClient): Promise<string> {
  await ensureOllama(host);
  const cleanup = await cleanupOllama(host, "pre-cleanup-managed-image-ollama");
  expect(cleanup.exitCode, resultText(cleanup)).toBe(0);
  const readiness = protectedOllamaReadinessCommand(
    path.join(process.env.RUNNER_TEMP ?? "/tmp", "managed-image-ollama.log"),
  );
  const start = await host.command(readiness.command, readiness.args, {
    artifactName: "start-managed-image-ollama",
    captureLimitBytes: readiness.captureLimitBytes,
    env: gpuEnv(),
    timeoutMs: PROTECTED_OLLAMA_START_TIMEOUT_MS,
  });
  expect(
    start.exitCode,
    `protected Ollama startup failed; see the redacted artifact ${start.artifacts.result}`,
  ).toBe(0);
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

function protectedProviderContainerState(
  kind: ProtectedProviderKind,
  owner: string,
): ProtectedProviderContainerState {
  return {
    authority: null,
    kind,
    name: protectedProviderContainerName(kind, owner),
    owner,
    removed: false,
    reportedContainerId: null,
  };
}

async function assertProtectedProviderContainerAbsent(
  host: HostCliClient,
  state: ProtectedProviderContainerState,
  artifactName: string,
): Promise<void> {
  const command = protectedProviderContainerPreflightCommand(state.name);
  const result = await host.command(command.command, command.args, {
    artifactName,
    captureLimitBytes: command.captureLimitBytes,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  expect(result.exitCode, resultText(result)).toBe(0);
}

async function inspectProtectedProviderContainer(
  host: HostCliClient,
  state: ProtectedProviderContainerState,
  requestedImage: string,
  artifactName: string,
): Promise<ProtectedProviderContainerAuthority> {
  const reportedContainerId = state.reportedContainerId;
  if (!reportedContainerId) {
    throw new Error(`provider start did not report authority for ${state.name}`);
  }
  const result = await host.command(
    "docker",
    [
      "container",
      "inspect",
      "--format",
      '{{.Id}}|{{.Name}}|{{.Config.Image}}|{{.Image}}|{{ index .Config.Labels "io.nvidia.nemoclaw.e2e-owner" }}|{{ index .Config.Labels "io.nvidia.nemoclaw.e2e-provider" }}',
      reportedContainerId,
    ],
    {
      artifactName,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `provider authority inspection failed for ${state.name}: ${resultText(result)}`,
    );
  }
  const lines = result.stdout.trim().split("\n");
  const fields = lines.length === 1 ? lines[0]!.split("|") : [];
  if (fields.length !== 6) {
    throw new Error(`provider authority inspection was ambiguous for ${state.name}`);
  }
  const [containerId, actualName, actualImage, imageId, owner, kind] = fields;
  const authority: ProtectedProviderContainerAuthority = {
    containerId: containerId!,
    imageId: imageId!,
    kind: state.kind,
    name: state.name,
    owner: state.owner,
    requestedImage,
  };
  if (
    containerId !== reportedContainerId ||
    actualName !== `/${state.name}` ||
    actualImage !== requestedImage ||
    owner !== state.owner ||
    kind !== state.kind
  ) {
    throw new Error(`provider authority drifted after start for ${state.name}`);
  }
  assertProviderAuthority(authority);
  return authority;
}

async function removeProtectedProviderContainer(
  host: HostCliClient,
  state: ProtectedProviderContainerState,
  artifactName: string,
): Promise<void> {
  if (state.removed || !state.reportedContainerId) {
    await assertProtectedProviderContainerAbsent(host, state, `${artifactName}-absent`);
    return;
  }
  if (!state.authority) {
    const command = protectedProviderContainerPreflightCommand(state.name);
    const evidence = await host.command(command.command, command.args, {
      artifactName: `${artifactName}-authority-missing`,
      captureLimitBytes: command.captureLimitBytes,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    throw new Error(
      `provider cleanup authority is missing for ${state.name}; see ${evidence.artifacts.result}`,
    );
  }
  const command = protectedProviderContainerCleanupCommand(state.authority);
  const result = await host.command(command.command, command.args, {
    artifactName,
    captureLimitBytes: command.captureLimitBytes,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 120_000,
  });
  expect(result.exitCode, resultText(result)).toBe(0);
  state.removed = true;
}

async function startProtectedVllm(
  host: HostCliClient,
  state: ProtectedProviderContainerState,
): Promise<void> {
  const start = await host.command(
    "docker",
    [
      "run",
      "--detach",
      "--name",
      state.name,
      "--label",
      `${PROTECTED_PROVIDER_OWNER_LABEL}=${state.owner}`,
      "--label",
      `${PROTECTED_PROVIDER_KIND_LABEL}=${state.kind}`,
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
  state.reportedContainerId = protectedProviderReportedContainerId(state.name, start.stdout);
  state.authority = await inspectProtectedProviderContainer(
    host,
    state,
    VLLM_IMAGE,
    "inspect-vllm-authority",
  );
  const readiness = protectedVllmReadinessCommand(state.name);
  const ready = await host.command(readiness.command, readiness.args, {
    artifactName: "wait-vllm",
    captureLimitBytes: readiness.captureLimitBytes,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 11 * 60_000,
  });
  expect(ready.exitCode, resultText(ready)).toBe(0);
  const cuda = await host.command(
    "docker",
    [
      "exec",
      state.name,
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

export function protectedVllmReadinessCommand(
  containerName: string,
): ProtectedRuntimeReadinessCommand {
  if (
    containerName.length > PROTECTED_PROVIDER_CONTAINER_MAX_LENGTH ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(containerName)
  ) {
    throw new Error("protected provider container name is outside the Docker name contract");
  }
  return {
    command: "bash",
    captureLimitBytes: PROTECTED_READINESS_CAPTURE_LIMIT_BYTES,
    args: [
      "--noprofile",
      "--norc",
      "-c",
      `set -euo pipefail
attempt=0
deadline=$((SECONDS + 600))
while [ "$SECONDS" -lt "$deadline" ]; do
  attempt=$((attempt + 1))
  if curl -fsS --connect-timeout 2 --max-time 5 http://127.0.0.1:8000/v1/models >/dev/null 2>&1; then
    printf 'managed-image-vllm-ready attempts=%s\n' "$attempt"
    exit 0
  fi
  if ! docker container inspect "${containerName}" --format '{{.State.Running}}' | grep -Fx true >/dev/null; then
    break
  fi
  sleep 2
done
docker logs --tail 200 "${containerName}" >&2 || true
printf 'managed-image-vllm-not-ready attempts=%s\n' "$attempt" >&2
exit 1`,
    ],
  };
}

export function protectedNimReadinessCommand(
  containerName: string,
): ProtectedRuntimeReadinessCommand {
  if (
    containerName.length > PROTECTED_PROVIDER_CONTAINER_MAX_LENGTH ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(containerName)
  ) {
    throw new Error("protected provider container name is outside the Docker name contract");
  }
  return {
    command: "bash",
    captureLimitBytes: PROTECTED_READINESS_CAPTURE_LIMIT_BYTES,
    args: [
      "--noprofile",
      "--norc",
      "-c",
      `set -euo pipefail
attempt=0
deadline=$((SECONDS + 1200))
while [ "$SECONDS" -lt "$deadline" ]; do
  attempt=$((attempt + 1))
  if curl -fsS --connect-timeout 5 --max-time 5 http://127.0.0.1:8000/v1/models >/dev/null 2>&1; then
    printf 'managed-image-nim-ready attempts=%s\n' "$attempt"
    exit 0
  fi
  if ! docker container inspect "${containerName}" --format '{{.State.Running}}' | grep -Fx true >/dev/null; then
    break
  fi
  sleep 5
done
docker logs --tail 200 "${containerName}" >&2 || true
printf 'managed-image-nim-not-ready attempts=%s\n' "$attempt" >&2
exit 1`,
    ],
  };
}

async function startProtectedNim(
  host: HostCliClient,
  state: ProtectedProviderContainerState,
  apiKey: string,
): Promise<string> {
  expect(dockerLoginNgc(apiKey), "NGC login must succeed for protected NIM qualification").toBe(
    true,
  );
  const image = pullNimImage(NIM_CATALOG_MODEL);
  const start = await host.command(
    "docker",
    [
      "run",
      "--detach",
      "--name",
      state.name,
      "--label",
      `${PROTECTED_PROVIDER_OWNER_LABEL}=${state.owner}`,
      "--label",
      `${PROTECTED_PROVIDER_KIND_LABEL}=${state.kind}`,
      "--gpus",
      "all",
      "--publish",
      "8000:8000",
      "--shm-size",
      "16g",
      "--env",
      "NGC_API_KEY",
      "--env",
      "NIM_NGC_API_KEY",
      image,
    ],
    {
      artifactName: "start-nim",
      env: {
        ...buildAvailabilityProbeEnv(),
        NGC_API_KEY: apiKey,
        NIM_NGC_API_KEY: apiKey,
      },
      redactionValues: [apiKey],
      timeoutMs: 20 * 60_000,
    },
  );
  expect(start.exitCode, resultText(start)).toBe(0);
  state.reportedContainerId = protectedProviderReportedContainerId(state.name, start.stdout);
  state.authority = await inspectProtectedProviderContainer(
    host,
    state,
    image,
    "inspect-nim-authority",
  );
  const readiness = protectedNimReadinessCommand(state.name);
  const ready = await host.command(readiness.command, readiness.args, {
    artifactName: "wait-nim",
    captureLimitBytes: readiness.captureLimitBytes,
    env: buildAvailabilityProbeEnv(),
    redactionValues: [apiKey],
    timeoutMs: 21 * 60_000,
  });
  expect(ready.exitCode, resultText(ready)).toBe(0);
  const servedModel = adoptServedModelId(NIM_CATALOG_MODEL, 8000);
  expect(servedModel, "NIM must report one safe served model").toBeTruthy();
  const cuda = await host.command("docker", ["exec", state.name, "nvidia-smi", "-L"], {
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
    `retained one exact quiescent ${contract.agent} sandbox for owner cleanup`,
  );
  expect(result.stdout).toContain(
    `retained only its exact quiescent sandbox until harness owner cleanup and left no sandbox, container, network, or harness state orphan for ${contract.agent}`,
  );
}

async function qualifyEveryRollback(
  host: HostCliClient,
  contracts: readonly ProtectedManagedImageContract[],
): Promise<void> {
  for (const contract of contracts) await qualifyRollback(host, contract);
}

export function protectedProviderFinalInventoryCommand(
  cohort: string,
  vllmName: string,
  nimName: string,
): ProtectedRuntimeReadinessCommand {
  if (
    protectedProviderContainerName("vllm", cohort) !== vllmName ||
    protectedProviderContainerName("nim", cohort) !== nimName
  ) {
    throw new Error("protected provider inventory requires exact cohort container names");
  }
  return {
    command: "bash",
    captureLimitBytes: PROTECTED_READINESS_CAPTURE_LIMIT_BYTES,
    args: [
      "--noprofile",
      "--norc",
      "-c",
      [
        "set -euo pipefail",
        'cohort="$1"',
        'vllm_name="$2"',
        'nim_name="$3"',
        'sandbox_prefix="$4"',
        `owner_label=${JSON.stringify(PROTECTED_PROVIDER_OWNER_LABEL)}`,
        `kind_label=${JSON.stringify(PROTECTED_PROVIDER_KIND_LABEL)}`,
        'printf \'expected-provider name=%s %s=%s %s=vllm\\n\' "$vllm_name" "$owner_label" "$cohort" "$kind_label"',
        'printf \'expected-provider name=%s %s=%s %s=nim\\n\' "$nim_name" "$owner_label" "$cohort" "$kind_label"',
        'provider_rows="$(docker ps -a --no-trunc --filter "label=${owner_label}=${cohort}" --filter "label=${kind_label}" --format \'{{.ID}}|{{.Names}}|{{.Label "io.nvidia.nemoclaw.e2e-owner"}}|{{.Label "io.nvidia.nemoclaw.e2e-provider"}}\')" || {',
        "  echo 'provider-owned container inventory is indeterminate' >&2",
        "  exit 70",
        "}",
        'vllm_rows="$(docker ps -a --no-trunc --filter "name=^/${vllm_name}$" --format \'{{.ID}}\')" || {',
        "  echo 'vLLM container-name inventory is indeterminate' >&2",
        "  exit 70",
        "}",
        'nim_rows="$(docker ps -a --no-trunc --filter "name=^/${nim_name}$" --format \'{{.ID}}\')" || {',
        "  echo 'NIM container-name inventory is indeterminate' >&2",
        "  exit 70",
        "}",
        'sandbox_labels="$(docker ps -a --format \'{{.Label "openshell.ai/sandbox-name"}}\' --filter label=openshell.ai/managed-by=openshell)" || {',
        "  echo 'managed sandbox container inventory is indeterminate' >&2",
        "  exit 70",
        "}",
        'containers="$(printf \'%s\\n\' "$sandbox_labels" | grep "^${sandbox_prefix}" || true)"',
        "network_names=\"$(docker network ls --format '{{.Name}}')\" || {",
        "  echo 'managed network inventory is indeterminate' >&2",
        "  exit 70",
        "}",
        "networks=\"$(printf '%s\\n' \"$network_names\" | grep '^nemoclaw-managed-pr-' || true)\"",
        '[[ -z "$provider_rows" && -z "$vllm_rows" && -z "$nim_rows" && -z "$containers" && -z "$networks" ]] || {',
        '  printf \'protected runtime inventory retained state: providers=%s vllm=%s nim=%s sandboxes=%s networks=%s\\n\' "$provider_rows" "$vllm_rows" "$nim_rows" "$containers" "$networks" >&2',
        "  exit 70",
        "}",
        "printf 'protected-runtime-inventory-clean\\n'",
      ].join("\n"),
      "protected-provider-final-inventory",
      cohort,
      vllmName,
      nimName,
      MANAGED_IMAGE_PROTECTED_SANDBOX_PREFIX,
    ],
  };
}

async function proveOwnedRuntimeInventoryClean(
  host: HostCliClient,
  cohort: string,
  providerStates: readonly ProtectedProviderContainerState[],
): Promise<void> {
  const vllmName = providerStates.find(({ kind }) => kind === "vllm")?.name;
  const nimName = providerStates.find(({ kind }) => kind === "nim")?.name;
  if (!vllmName || !nimName) {
    throw new Error("protected provider inventory requires vLLM and NIM container names");
  }
  const command = protectedProviderFinalInventoryCommand(cohort, vllmName, nimName);
  const result = await host.command(command.command, command.args, {
    artifactName: "final-managed-image-owned-runtime-inventory",
    captureLimitBytes: command.captureLimitBytes,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  expect(result.exitCode, resultText(result)).toBe(0);
}

export async function qualifyProtectedManagedImageRuntime(
  fixtures: RuntimeFixtures,
  ngcApiKeyInput: string,
): Promise<void> {
  const { artifacts, cleanup, host, progress } = fixtures;
  const contracts = imageContracts();
  const ngcApiKey = requiredNgcApiKey(ngcApiKeyInput);
  const cohort = process.env.NEMOCLAW_PROTECTED_MANAGED_IMAGE_COHORT ?? "";
  const vllmState = protectedProviderContainerState("vllm", cohort);
  const nimState = protectedProviderContainerState("nim", cohort);
  const providerStates = [vllmState, nimState] as const;

  cleanup.trackDisposable("remove protected vLLM container", async () => {
    await removeProtectedProviderContainer(host, vllmState, "cleanup-vllm-container");
  });
  cleanup.trackDisposable("remove protected NIM container", async () => {
    await removeProtectedProviderContainer(host, nimState, "cleanup-nim-container");
  });
  cleanup.trackDisposable("stop protected Ollama runtime", async () => {
    killStaleProxy();
    const result = await cleanupOllama(host, "cleanup-managed-image-ollama");
    expect(result.exitCode, resultText(result)).toBe(0);
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
    await assertProtectedProviderContainerAbsent(host, vllmState, "preflight-vllm-container");
    await assertProtectedProviderContainerAbsent(host, nimState, "preflight-nim-container");

    activePhase = "qualify all managed agents with GPU-backed Ollama";
    progress.phase("qualify all managed agents with GPU-backed Ollama");
    const proxyToken = await startProtectedOllama(host);
    await qualifyEveryAgent(host, contracts, "ollama", OLLAMA_MODEL, {
      NEMOCLAW_OLLAMA_PROXY_TOKEN: proxyToken,
    });
    await proveOllamaGpuPlacement(host);
    killStaleProxy();
    const ollamaCleanup = await cleanupOllama(host, "stop-ollama-before-vllm");
    expect(ollamaCleanup.exitCode, resultText(ollamaCleanup)).toBe(0);

    activePhase = "qualify all managed agents with GPU-backed vLLM";
    progress.phase("qualify all managed agents with GPU-backed vLLM");
    await startProtectedVllm(host, vllmState);
    await qualifyEveryAgent(host, contracts, "vllm", VLLM_MODEL, {
      NEMOCLAW_VLLM_LOCAL_TOKEN: randomBytes(24).toString("hex"),
    });
    await removeProtectedProviderContainer(host, vllmState, "stop-vllm-before-nim");

    activePhase = "qualify all managed agents with GPU-backed NVIDIA NIM";
    progress.phase("qualify all managed agents with GPU-backed NVIDIA NIM");
    const nimModel = await startProtectedNim(host, nimState, ngcApiKey);
    await qualifyEveryAgent(host, contracts, "nim", nimModel, {
      NEMOCLAW_VLLM_LOCAL_TOKEN: randomBytes(24).toString("hex"),
    });
    await removeProtectedProviderContainer(host, nimState, "stop-nim-before-rollback");

    activePhase = "prove all-agent managed bootstrap rollback and exact cleanup";
    progress.phase("prove all-agent managed bootstrap rollback and exact cleanup");
    await qualifyEveryRollback(host, contracts);
    await proveOwnedRuntimeInventoryClean(host, cohort, providerStates);
    const providerContainers = providerStates.map(({ authority }) => {
      if (!authority) throw new Error("protected provider authority is missing from the receipt");
      return authority;
    });
    await artifacts.writeJson("managed-image-protected-runtime-summary.json", {
      agents: PROTECTED_MANAGED_IMAGE_AGENTS,
      providerContainers,
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
