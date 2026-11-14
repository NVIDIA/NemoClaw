// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseOpenShellSandboxId } from "../../../src/lib/adapters/openshell/sandbox-identity.ts";
import { NATIVE_LOCAL_AUTH_HEADER_SCRIPT } from "../../../src/lib/inference/native-local/agent-config.ts";
import {
  type ManagedWorkloadAuthority,
  readManagedWorkloadAuthority,
} from "../../../src/lib/onboard/workload/authority.ts";
import {
  OPENSHELL_MAIN_PROCESS_SPEC_ENV,
  parseOpenShellMainProcessSpecEnvValue,
} from "../../../src/lib/onboard/docker-startup-command-env.ts";
import { load as loadSandboxRegistry } from "../../../src/lib/state/registry/persistence.ts";
import { OPENSHELL_GATEWAY_START_LINE } from "../../helpers/openshell-gateway-start-output.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import {
  type HostCliClient,
  resultText,
  shellQuote,
  type SandboxClient,
  trustedSandboxShellScript,
} from "../fixtures/clients/index.ts";
import { expect } from "../fixtures/e2e-test.ts";
import type { RuntimeProviderPrerequisite } from "../fixtures/runtime-provider.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { buildHermesManagedStartupIntegrityScript } from "./hermes-gpu-startup-integrity.ts";
import { stripAnsi } from "./json-envelope.ts";

export const HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS = [
  "recreating the OpenShell-managed Docker container",
  "legacy GPU compatibility envelope",
  "may relax container confinement",
  "NEMOCLAW_DOCKER_GPU_PATCH=fallback",
  "explicitly authorized",
] as const;

interface HermesGpuStartupProofOptions {
  env: NodeJS.ProcessEnv;
  gpuRoute: "compatibility-fallback" | "compatibility-only" | "native-success";
  host: HostCliClient;
  install: Pick<ShellProbeResult, "stdout" | "stderr">;
  runtimeProvider: RuntimeProviderPrerequisite;
  sandbox: SandboxClient;
  sandboxName: string;
  status: Pick<ShellProbeResult, "stdout" | "stderr">;
}

const IMMUTABLE_IMAGE_REFERENCE = /^[^@\s]+@sha256:[a-f0-9]{64}$/u;
const IMMUTABLE_IMAGE_CONTENT_ID = /^sha256:[a-f0-9]{64}$/u;
const BARE_IMMUTABLE_IMAGE_CONTENT_ID = /^[a-f0-9]{64}$/u;

export function normalizeImmutableImageContentId(value: unknown): unknown {
  return typeof value === "string" && BARE_IMMUTABLE_IMAGE_CONTENT_ID.test(value)
    ? `sha256:${value}`
    : value;
}

export function hermesRuntimeIntendedCommand(
  runtimeEnvironment: Readonly<Record<string, string>>,
): readonly string[] {
  const mainProcessSpec = runtimeEnvironment[OPENSHELL_MAIN_PROCESS_SPEC_ENV];
  if (mainProcessSpec !== undefined) {
    return parseOpenShellMainProcessSpecEnvValue(mainProcessSpec).command;
  }
  return (runtimeEnvironment.OPENSHELL_SANDBOX_COMMAND ?? "").trim().split(/\s+/u).filter(Boolean);
}

export function assertHermesGpuStartupOutputContract(
  gpuRoute: HermesGpuStartupProofOptions["gpuRoute"],
  runtimeProviderId: RuntimeProviderPrerequisite["id"],
  installText: string,
): void {
  const runtimeLine =
    runtimeProviderId === "podman"
      ? /(?:Container runtime: podman|Podman runtime: rootless server)/u
      : /Container runtime: docker/u;
  expect(stripAnsi(installText)).toMatch(runtimeLine);
  expect(installText).toMatch(OPENSHELL_GATEWAY_START_LINE);
  expect(stripAnsi(installText)).toMatch(/gateway(?: managed service)? is healthy/u);
  expect(installText).not.toContain("Reusing healthy NemoClaw gateway.");
  expect(installText).not.toMatch(/Reusing existing .*gateway/u);
  expect(installText).not.toContain("[reuse] Skipping gateway (running)");
  if (gpuRoute === "compatibility-fallback") {
    expect(installText).toContain(
      "Operator-authorized GPU fallback enabled; trying native OpenShell injection with one compatibility retry.",
    );
    for (const fragment of HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS) {
      expect(installText).toContain(fragment);
    }
  } else {
    for (const fragment of HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS) {
      expect(installText).not.toContain(fragment);
    }
  }
}

export function assertHermesManagedWorkloadAuthority(
  sandboxName: string,
  registryImageTag: string | null | undefined,
  authority: ManagedWorkloadAuthority | null,
): string {
  if (!authority) {
    throw new Error(`Hermes GPU sandbox '${sandboxName}' has no managed workload authority`);
  }
  if (
    typeof registryImageTag !== "string" ||
    typeof authority.receipt.reference !== "string" ||
    !IMMUTABLE_IMAGE_REFERENCE.test(registryImageTag) ||
    !IMMUTABLE_IMAGE_REFERENCE.test(authority.receipt.reference)
  ) {
    throw new Error(`Hermes GPU sandbox '${sandboxName}' has no immutable image reference`);
  }
  const authorityReference = authority.receipt.reference;
  expect(authority).toMatchObject({
    agent: "hermes",
    contract: {
      agent: "hermes",
      reference: authorityReference,
    },
    profile: { agent: "hermes" },
    receipt: {
      kind: "managed-image",
      reference: registryImageTag,
    },
  });
  return authorityReference;
}

export function assertHermesContainerImageAuthority(
  containerImage: unknown,
  authorityReference: string,
  authorityContentId?: string,
): void {
  const normalizedContainerImage = normalizeImmutableImageContentId(containerImage);
  expect(
    normalizedContainerImage === authorityReference ||
      (IMMUTABLE_IMAGE_CONTENT_ID.test(authorityContentId ?? "") &&
        normalizedContainerImage === authorityContentId),
  ).toBe(true);
}

/** The fixture owns this host-alias endpoint; OpenShell supplies its scoped credential. */
export function buildHermesGpuInferenceCommand(endpointUrl: string, model: string): string {
  const payload = JSON.stringify({
    model,
    messages: [{ role: "user", content: "reply with OK" }],
    max_tokens: 8,
  });
  return `${NATIVE_LOCAL_AUTH_HEADER_SCRIPT}; curl -fsS --max-time 60 ${shellQuote(`${endpointUrl}/chat/completions`)} -H 'Content-Type: application/json' -H "$AUTH_HEADER" --data ${shellQuote(payload)}`;
}

interface HermesRuntimeInspection {
  Id: string;
  Image?: unknown;
  ImageName?: unknown;
  Config: {
    Cmd?: unknown;
    Entrypoint?: unknown;
    Env: string[];
    Image?: unknown;
    Labels: Record<string, string>;
  };
}

/** Main-process metadata belongs to the supervisor; the managed image belongs to its workload. */
export function hermesGpuRuntimePair(
  inspections: readonly HermesRuntimeInspection[],
  sandboxName: string,
  sandboxId: string | null,
): { workload: HermesRuntimeInspection; supervisor: HermesRuntimeInspection } | null {
  const workload = inspections.find(
    (row) => row.Config?.Labels?.["openshell.ai/isolation-role"] === "sandbox",
  );
  const supervisor = inspections.find(
    (row) => row.Config?.Labels?.["openshell.ai/isolation-role"] === "supervisor",
  );
  const labels = workload?.Config?.Labels ?? {};
  if (
    inspections.length !== 2 ||
    !sandboxId ||
    !workload ||
    !supervisor ||
    workload.Id === supervisor.Id ||
    !labels["openshell.ai/sandbox-namespace"] ||
    !labels["openshell.ai/sandbox-workspace"] ||
    supervisor.Config.Labels["openshell.ai/sandbox-workspace"] !== undefined ||
    inspections.some(
      (row) =>
        !/^[a-f0-9]{64}$/u.test(row.Id) ||
        !Array.isArray(row.Config?.Env) ||
        row.Config.Labels["openshell.ai/managed-by"] !== "openshell" ||
        row.Config.Labels["openshell.ai/sandbox-name"] !== sandboxName ||
        row.Config.Labels["openshell.ai/sandbox-id"] !== sandboxId ||
        row.Config.Labels["openshell.ai/sandbox-namespace"] !==
          labels["openshell.ai/sandbox-namespace"],
    )
  )
    return null;
  return { workload, supervisor };
}

export async function assertHermesGpuStartupProof({
  env,
  gpuRoute,
  host,
  install,
  runtimeProvider,
  sandbox,
  sandboxName,
  status,
}: HermesGpuStartupProofOptions): Promise<void> {
  const installText = resultText(install);
  assertHermesGpuStartupOutputContract(gpuRoute, runtimeProvider.id, installText);
  const plainStatus = stripAnsi(resultText(status));
  expect(plainStatus).toMatch(/Phase:\s*Ready/i);
  expect(plainStatus).toContain("Sandbox GPU: enabled");
  expect(plainStatus).toContain("CUDA verified");
  expect(plainStatus).not.toMatch(/last CUDA proof failed|CUDA unverified/i);

  const openshellState = await sandbox.openshell(["sandbox", "get", sandboxName], {
    artifactName: "phase-4-openshell-sandbox-ready-gpu-startup",
    env,
    timeoutMs: 30_000,
  });
  expect(openshellState.exitCode, resultText(openshellState)).toBe(0);
  expect(stripAnsi(resultText(openshellState))).toMatch(/Phase:\s*Ready/i);

  const pid1Topology = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(
      String.raw`python3 -c 'import json; from pathlib import Path; argv=[item.decode("utf-8", "strict") for item in Path("/proc/1/cmdline").read_bytes().split(b"\0") if item]; print(json.dumps({"argv0": argv[0] if argv else "", "has_nemoclaw_start": any(item in ("nemoclaw-start", "/usr/local/bin/nemoclaw-start") for item in argv)}))'`,
    ),
    {
      artifactName: "phase-4-gpu-startup-pid1-topology",
      env,
      timeoutMs: 30_000,
    },
  );
  expect(pid1Topology.exitCode, resultText(pid1Topology)).toBe(0);
  expect(JSON.parse(pid1Topology.stdout)).toEqual({
    argv0: "/.openshell/runtime/openshell-sandbox",
    has_nemoclaw_start: false,
  });

  const runningContainers = await runtimeProvider.command(
    [
      "container",
      "ps",
      "--no-trunc",
      "--filter",
      `label=openshell.ai/sandbox-name=${sandboxName}`,
      "--format",
      "{{.ID}}",
    ],
    {
      artifactName: "phase-4-gpu-startup-running-containers",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(runningContainers.exitCode, resultText(runningContainers)).toBe(0);
  const containerRows = runningContainers.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  expect(containerRows.join("\n")).toMatch(/^[a-f0-9]{64}\n[a-f0-9]{64}$/u);

  const registryEntry = loadSandboxRegistry().sandboxes[sandboxName];
  if (!registryEntry) {
    throw new Error(`Hermes GPU sandbox '${sandboxName}' is missing from the registry`);
  }
  const managedAuthority = readManagedWorkloadAuthority(registryEntry);
  const managedImageReference = assertHermesManagedWorkloadAuthority(
    sandboxName,
    registryEntry.imageTag,
    managedAuthority,
  );
  const managedImageInspection = await runtimeProvider.command(
    ["image", "inspect", managedImageReference],
    {
      artifactName: "phase-4-gpu-startup-managed-image-content-authority",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(managedImageInspection.exitCode, resultText(managedImageInspection)).toBe(0);
  const managedImageInspectEntry = (
    JSON.parse(managedImageInspection.stdout) as Array<{ Id?: unknown; ID?: unknown }>
  )[0];
  const managedImageContentId = normalizeImmutableImageContentId(
    managedImageInspectEntry?.Id ?? managedImageInspectEntry?.ID,
  );
  expect(managedImageContentId).toMatch(IMMUTABLE_IMAGE_CONTENT_ID);

  const guardWithoutStartupOwner = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(
      "python3 -I /usr/local/lib/nemoclaw/hermes-runtime-config-guard.py ensure-api-key --hermes-dir /sandbox/.hermes",
    ),
    {
      artifactName: "phase-4-gpu-startup-guard-without-startup-owner",
      env,
      timeoutMs: 30_000,
    },
  );
  expect(guardWithoutStartupOwner.exitCode).not.toBe(0);
  expect(resultText(guardWithoutStartupOwner)).toContain(
    "Hermes runtime config guard refuses mutation under a foreign PID 1",
  );

  const guardFromNonStartupChild = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(
      "python3 -I /usr/local/lib/nemoclaw/hermes-runtime-config-guard.py ensure-api-key --hermes-dir /sandbox/.hermes --startup-owner",
    ),
    {
      artifactName: "phase-4-gpu-startup-owner-from-non-startup-child",
      env,
      timeoutMs: 30_000,
    },
  );
  expect(guardFromNonStartupChild.exitCode).not.toBe(0);
  expect(resultText(guardFromNonStartupChild)).toContain(
    "Hermes runtime config guard refuses mutation under a foreign PID 1",
  );

  const startupConfig = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(buildHermesManagedStartupIntegrityScript()),
    {
      artifactName: "phase-4-gpu-startup-config-and-guard",
      env,
      timeoutMs: 30_000,
    },
  );
  expect(startupConfig.exitCode, resultText(startupConfig)).toBe(0);
  expect(startupConfig.stdout.trim()).toBe("OK");

  // Inspect remains local to this proof: supervisor argv can carry opaque environment values.
  // Neither stdout, stderr nor result metadata is persisted by this probe.
  const runtimeCommandBoundary = await runtimeProvider.command(
    ["container", "inspect", ...containerRows],
    {
      artifactName: "phase-4-gpu-startup-runtime-command-boundary",
      env: buildAvailabilityProbeEnv(),
      persistArtifacts: false,
      timeoutMs: 30_000,
    },
  );
  expect(runtimeCommandBoundary.exitCode, "runtime pair inspection must succeed").toBe(0);
  const pair = hermesGpuRuntimePair(
    JSON.parse(runtimeCommandBoundary.stdout),
    sandboxName,
    parseOpenShellSandboxId(resultText(openshellState)),
  );
  expect(
    pair,
    "expected the exact workload and supervisor for the selected sandbox",
  ).not.toBeNull();
  const { workload: runtimeInspection, supervisor } = pair!;
  const containerId = runtimeInspection.Id;
  const runtimeConfig = runtimeInspection.Config;
  const runtimeEnvironment = Object.fromEntries(
    supervisor.Config.Env.filter((entry) => entry.includes("=")).map(
      (entry) => entry.split(/=(.*)/su).slice(0, 2) as [string, string],
    ),
  );
  const intendedTokens = hermesRuntimeIntendedCommand(runtimeEnvironment);
  const commandBoundary = {
    cmd: runtimeConfig.Cmd,
    entrypoint: runtimeConfig.Entrypoint,
    image: runtimeInspection?.Image ?? runtimeInspection?.ImageName ?? runtimeConfig.Image,
    has_openshell_sandbox_command: intendedTokens.length > 0,
    command_is_sleep_infinity:
      intendedTokens.length === 2 &&
      intendedTokens[0] === "sleep" &&
      intendedTokens[1] === "infinity",
    command_ends_with_nemoclaw_start:
      intendedTokens.length > 0 &&
      ["nemoclaw-start", "/usr/local/bin/nemoclaw-start"].includes(intendedTokens.at(-1) ?? ""),
  };
  expect(commandBoundary.has_openshell_sandbox_command).toBe(true);
  expect(
    [...(runtimeConfig.Env ?? []), ...supervisor.Config.Env].filter((entry) =>
      entry.startsWith("NEMOCLAW_MANAGED_BOOTSTRAP_IDENTITY="),
    ).length,
  ).toBe(0);
  assertHermesContainerImageAuthority(
    commandBoundary.image,
    managedImageReference,
    managedImageContentId as string,
  );
  expect(commandBoundary.command_ends_with_nemoclaw_start).toBe(true);
  expect(commandBoundary.command_is_sleep_infinity).toBe(false);

  const containerState = await runtimeProvider.command(
    ["container", "inspect", "--format", "{{.State.Status}} {{.RestartCount}}", containerId],
    {
      artifactName: "phase-4-gpu-startup-container-state",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(containerState.exitCode, resultText(containerState)).toBe(0);
  expect(containerState.stdout.trim()).toBe("running 0");

  const allContainers = await runtimeProvider.command(
    [
      "container",
      "ps",
      "--all",
      "--filter",
      `label=openshell.ai/sandbox-name=${sandboxName}`,
      "--filter",
      "label=openshell.ai/isolation-role=sandbox",
      "--format",
      "{{.Names}}",
    ],
    {
      artifactName: "phase-4-gpu-startup-all-containers",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(allContainers.exitCode, resultText(allContainers)).toBe(0);
  const allContainerNames = allContainers.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  expect(allContainerNames).toHaveLength(1);
  expect(allContainerNames.filter((name) => name.includes("-nemoclaw-gpu-backup-"))).toEqual([]);
}
