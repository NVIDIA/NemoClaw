// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerSpawnSync } from "../../adapters/docker/exec";
import { dockerCapture } from "../../adapters/docker/run";
import { resolvePortableDemoPrivilegedExecTarget } from "../experimental/portable-demo-lifecycle";
import { compareAndSetSandboxLifecycleGeneration } from "../../state/registry/lifecycle-generation-cas";
import type {
  RuntimeProviderPrivilegedSandboxCommandInput,
  RuntimeProviderPrivilegedSandboxCommandResult,
  RuntimeProviderPrivilegedSandboxControl,
  RuntimeProviderPrivilegedSandboxTarget,
} from "./contract";
import {
  DirectSandboxFallbackUnavailableError,
  PinnedSandboxResourceIdentityChangedError,
} from "./privileged-sandbox-control-errors";
import { selectDockerPrivilegedSandboxTarget } from "./docker-privileged-sandbox-identity";
import { createDockerOperationAuthority } from "./docker-operation-authority";
import {
  clearStoppedSandboxStateWithEngine,
  sandboxStateResourceFromMounts,
  type StoppedSandboxStateObservation,
} from "./stopped-sandbox-state-cleanup";

const OPENSHELL_MANAGED_BY_LABEL = "openshell.ai/managed-by";
const OPENSHELL_MANAGED_BY_VALUE = "openshell";
const OPENSHELL_SANDBOX_NAME_LABEL = "openshell.ai/sandbox-name";
const DIRECT_SANDBOX_DISCOVERY_TIMEOUT_MS = 5000;
const SANITIZED_PRIVILEGED_ENV = [
  "BASH_ENV=",
  "ENV=",
  "GCONV_PATH=",
  "GLIBC_TUNABLES=",
  "LD_AUDIT=",
  "LD_LIBRARY_PATH=",
  "LD_PRELOAD=",
  "LOCPATH=",
  "NODE_OPTIONS=",
  "PERL5OPT=",
  "PYTHONHOME=",
  "PYTHONINSPECT=",
  "PYTHONNOUSERSITE=1",
  "PYTHONPATH=",
  "PYTHONSTARTUP=",
  "PYTHONUSERBASE=",
  "RUBYOPT=",
] as const;

type SandboxEntry = import("../../state/registry").SandboxEntry;

function findDirectSandboxContainer(
  sandboxName: string,
  registeredSandboxNames: readonly string[],
): string | null {
  let output: string;
  try {
    output = dockerCapture(
      [
        "ps",
        "--no-trunc",
        "--filter",
        `label=${OPENSHELL_MANAGED_BY_LABEL}=${OPENSHELL_MANAGED_BY_VALUE}`,
        "--filter",
        `label=${OPENSHELL_SANDBOX_NAME_LABEL}=${sandboxName}`,
        "--format",
        "{{.ID}}\t{{.Names}}",
      ],
      { timeout: DIRECT_SANDBOX_DISCOVERY_TIMEOUT_MS },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DirectSandboxFallbackUnavailableError(
      `Direct sandbox container discovery failed for '${sandboxName}': ${detail}`,
      { cause: error },
    );
  }
  return selectDockerPrivilegedSandboxTarget(sandboxName, output, registeredSandboxNames);
}

function expectedDirectContainerPattern(sandboxName: string): string {
  return (
    `openshell-${sandboxName}, openshell-${sandboxName}-*, or ` +
    `openshell-default--${sandboxName}-*`
  );
}

function portableTarget(sandboxName: string, sandbox: SandboxEntry) {
  if (sandbox.openshellDriver?.trim().toLowerCase() !== "docker") return null;
  return resolvePortableDemoPrivilegedExecTarget(sandboxName, {
    ...(sandbox.lifecycleGeneration ? { registryGeneration: sandbox.lifecycleGeneration } : {}),
    backfillRegistryGeneration: (generation) =>
      compareAndSetSandboxLifecycleGeneration(sandbox, generation),
  });
}

function resolveDockerTarget(
  input: Pick<
    RuntimeProviderPrivilegedSandboxCommandInput,
    "registeredSandboxNames" | "sandbox" | "sandboxName"
  >,
): RuntimeProviderPrivilegedSandboxTarget {
  const portable = portableTarget(input.sandboxName, input.sandbox);
  if (portable) {
    portable.assertRuntimeAuthority();
    return Object.freeze({ providerId: "docker", resourceHandle: portable.containerId });
  }
  const containerId = findDirectSandboxContainer(input.sandboxName, input.registeredSandboxNames);
  if (!containerId) {
    throw new DirectSandboxFallbackUnavailableError(
      `No running direct OpenShell sandbox container found for '${input.sandboxName}' ` +
        `(driver: ${input.sandbox.openshellDriver ?? "unspecified"}). Expected one ` +
        `OpenShell-managed container labeled '${OPENSHELL_SANDBOX_NAME_LABEL}=` +
        `${input.sandboxName}' and named ${expectedDirectContainerPattern(input.sandboxName)}. ` +
        "Is the sandbox running?",
    );
  }
  return Object.freeze({ providerId: "docker", resourceHandle: containerId });
}

function executeDockerCommand(
  input: RuntimeProviderPrivilegedSandboxCommandInput,
): RuntimeProviderPrivilegedSandboxCommandResult {
  const argv = buildLegacyDockerArgv(input);
  const result = dockerSpawnSync(argv, {
    encoding: null,
    input: input.input,
    maxBuffer: input.maxOutputBytes,
    stdio: input.input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    timeout: input.timeoutMs,
  });
  return Object.freeze({
    status: result.status,
    signal: result.signal,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ""),
    stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? ""),
    ...(result.error ? { error: result.error } : {}),
  });
}

function buildLegacyDockerArgv(
  input: Omit<RuntimeProviderPrivilegedSandboxCommandInput, "timeoutMs">,
): string[] {
  const portable = portableTarget(input.sandboxName, input.sandbox);
  const target = portable
    ? (() => {
        portable.assertRuntimeAuthority();
        return portable.containerId;
      })()
    : resolveDockerTarget(input).resourceHandle;
  if (input.expectedResourceHandle !== undefined && input.expectedResourceHandle !== target) {
    throw new PinnedSandboxResourceIdentityChangedError(input.sandboxName);
  }
  const environment = input.sanitizeEnvironment
    ? SANITIZED_PRIVILEGED_ENV.flatMap((value) => ["--env", value])
    : [];
  const argv = [
    ...(portable ? ["--host", portable.dockerHost] : []),
    "exec",
    ...(input.input ? ["-i"] : []),
    ...environment,
    "--user",
    portable ? "0" : "root",
    target,
    ...input.command,
  ];
  return argv;
}

function observeStoppedDockerTarget(
  engine: ReturnType<typeof createDockerOperationAuthority>["engine"],
  input: Parameters<
    NonNullable<RuntimeProviderPrivilegedSandboxControl["clearStoppedStateRoots"]>
  >[0],
): StoppedSandboxStateObservation {
  let lookup;
  try {
    lookup = engine.capture(
      [
        "ps",
        "--all",
        "--no-trunc",
        "--filter",
        `label=${OPENSHELL_MANAGED_BY_LABEL}=${OPENSHELL_MANAGED_BY_VALUE}`,
        "--filter",
        `label=${OPENSHELL_SANDBOX_NAME_LABEL}=${input.sandboxName}`,
        "--format",
        "{{.ID}}\t{{.Names}}",
      ],
      DIRECT_SANDBOX_DISCOVERY_TIMEOUT_MS,
    );
  } catch {
    return { failure: "runtime-discovery-failed" };
  }
  if (lookup.status !== 0 || lookup.error) return { failure: "runtime-discovery-failed" };
  let resourceHandle: string | null;
  try {
    resourceHandle = selectDockerPrivilegedSandboxTarget(
      input.sandboxName,
      lookup.stdout,
      input.registeredSandboxNames,
    );
  } catch {
    return { failure: "runtime-ownership-invalid" };
  }
  if (!resourceHandle || /-nemoclaw-gpu-backup-\d+$/u.test(lookup.stdout)) {
    return { failure: "no-eligible-stopped-runtime" };
  }
  const inspected = engine.capture(
    ["inspect", "--format", "{{.Id}}\t{{.State.Running}}\t{{json .Mounts}}", resourceHandle],
    30_000,
  );
  if (inspected.status !== 0 || inspected.error) return { failure: "runtime-inspection-failed" };
  const [id, running, mountsJson, ...unexpected] = inspected.stdout.trim().split("\t");
  if (
    unexpected.length > 0 ||
    id !== resourceHandle ||
    (running !== "true" && running !== "false") ||
    !mountsJson
  ) {
    return { failure: "runtime-ownership-invalid" };
  }
  let mounts: unknown;
  try {
    mounts = JSON.parse(mountsJson);
  } catch {
    return { failure: "state-resource-unavailable" };
  }
  const stateResource = sandboxStateResourceFromMounts(mounts, input.paths);
  return stateResource
    ? { target: { resourceHandle, running: running === "true", stateResource } }
    : { failure: "state-resource-unavailable" };
}

function clearStoppedStateRoots(
  input: Parameters<
    NonNullable<RuntimeProviderPrivilegedSandboxControl["clearStoppedStateRoots"]>
  >[0],
) {
  const engine = createDockerOperationAuthority("sandbox-lifecycle").engine;
  return clearStoppedSandboxStateWithEngine(input.sandboxName, input.paths, {
    capture: (args, timeoutMs = 30_000) => engine.capture(args, timeoutMs),
    observe: () => observeStoppedDockerTarget(engine, input),
  });
}

export function createDockerPrivilegedSandboxControl(): RuntimeProviderPrivilegedSandboxControl {
  return Object.freeze({
    resolveTarget: resolveDockerTarget,
    execute: executeDockerCommand,
    clearStoppedStateRoots,
    buildLegacyDockerArgv,
  });
}
