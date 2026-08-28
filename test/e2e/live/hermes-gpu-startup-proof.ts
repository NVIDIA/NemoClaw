// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type ManagedWorkloadAuthority,
  readManagedWorkloadAuthority,
} from "../../../src/lib/onboard/workload/authority.ts";
import { managedImageRuntimeIdentity } from "../../../src/lib/onboard/managed-image/contract.ts";
import { assertManagedBootstrapIdentity } from "../../../src/lib/onboard/managed-bootstrap/adapter.ts";
import { MANAGED_BOOTSTRAP_TRAMPOLINE_EXECUTABLE } from "../../../src/lib/onboard/managed-bootstrap/docker.ts";
import { MANAGED_BOOTSTRAP_REQUEST_FILE } from "../../../src/lib/onboard/managed-bootstrap/envelope.ts";
import { fingerprintManagedStartupProfile } from "../../../src/lib/onboard/managed-startup/profile.ts";
import { OPENSHELL_SANDBOX_SUPERVISOR_ARGV } from "../../../src/lib/onboard/sandbox-create-launch.ts";
import { load as loadSandboxRegistry } from "../../../src/lib/state/registry/persistence.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import {
  type HostCliClient,
  resultText,
  type SandboxClient,
  trustedSandboxShellScript,
} from "../fixtures/clients/index.ts";
import { expect } from "../fixtures/e2e-test.ts";
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
  sandbox: SandboxClient;
  sandboxName: string;
  status: Pick<ShellProbeResult, "stdout" | "stderr">;
}

const IMMUTABLE_IMAGE_REFERENCE = /^[^@\s]+@sha256:[a-f0-9]{64}$/u;

export function assertHermesGpuStartupOutputContract(
  gpuRoute: HermesGpuStartupProofOptions["gpuRoute"],
  installText: string,
): void {
  expect(installText).toContain("Starting OpenShell Docker-driver gateway...");
  expect(installText).toContain("Docker-driver gateway is healthy");
  expect(installText).not.toContain("Reusing healthy NemoClaw gateway.");
  expect(installText).not.toContain("Reusing existing Docker-driver gateway");
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
): void {
  expect(containerImage).toBe(authorityReference);
}

export async function assertHermesGpuStartupProof({
  env,
  gpuRoute,
  host,
  install,
  sandbox,
  sandboxName,
  status,
}: HermesGpuStartupProofOptions): Promise<void> {
  const installText = resultText(install);
  assertHermesGpuStartupOutputContract(gpuRoute, installText);
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
    argv0: "/opt/openshell/bin/openshell-sandbox",
    has_nemoclaw_start: false,
  });

  const runningContainers = await host.command(
    "docker",
    [
      "ps",
      "--filter",
      `label=openshell.ai/sandbox-name=${sandboxName}`,
      "--format",
      "{{.ID}} {{.Names}}",
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
  expect(
    containerRows,
    `expected one running container, got ${runningContainers.stdout}`,
  ).toHaveLength(1);
  const [containerId = ""] = containerRows[0].split(/\s+/, 1);
  expect(containerId).not.toBe("");

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

  const dockerCommandBoundary = await host.command(
    "bash",
    [
      "-lc",
      String.raw`docker inspect "$1" | python3 -c 'import json, sys; config=json.load(sys.stdin)[0]["Config"]; env=dict(item.split("=", 1) for item in (config.get("Env") or []) if "=" in item); command=env.get("OPENSHELL_SANDBOX_COMMAND", ""); tokens=command.split(); print(json.dumps({"cmd": config.get("Cmd"), "entrypoint": config.get("Entrypoint"), "image": config.get("Image"), "has_openshell_sandbox_command": bool(command), "command_is_sleep_infinity": tokens == ["sleep", "infinity"], "command_ends_with_nemoclaw_start": bool(tokens) and tokens[-1] in ("nemoclaw-start", "/usr/local/bin/nemoclaw-start")}))'`,
      "hermes-gpu-command-boundary",
      containerId,
    ],
    {
      artifactName: "phase-4-gpu-startup-docker-command-boundary",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(dockerCommandBoundary.exitCode, resultText(dockerCommandBoundary)).toBe(0);
  const commandBoundary = JSON.parse(dockerCommandBoundary.stdout);
  const verifiedManagedAuthority = managedAuthority!;
  expect(verifiedManagedAuthority.agent).toBe("hermes");
  const managedBootstrapCommand = commandBoundary.cmd;
  expect(Array.isArray(managedBootstrapCommand)).toBe(true);
  const bootstrapIdentity = managedBootstrapCommand[5];
  expect(typeof bootstrapIdentity).toBe("string");
  assertManagedBootstrapIdentity(bootstrapIdentity);
  const agentIdentity = managedImageRuntimeIdentity(verifiedManagedAuthority.agent);
  expect(commandBoundary.entrypoint).toEqual([MANAGED_BOOTSTRAP_TRAMPOLINE_EXECUTABLE]);
  expect(managedBootstrapCommand).toEqual([
    "--agent",
    verifiedManagedAuthority.agent,
    "--profile-fingerprint",
    fingerprintManagedStartupProfile(verifiedManagedAuthority.profile),
    "--bootstrap-identity",
    bootstrapIdentity,
    "--agent-uid",
    String(agentIdentity.uid),
    "--agent-gid",
    String(agentIdentity.gid),
    "--agent-workdir",
    agentIdentity.workdir,
    "--request-file",
    MANAGED_BOOTSTRAP_REQUEST_FILE,
    "--",
    ...OPENSHELL_SANDBOX_SUPERVISOR_ARGV,
  ]);
  expect(commandBoundary.has_openshell_sandbox_command).toBe(true);
  assertHermesContainerImageAuthority(commandBoundary.image, managedImageReference);
  expect(commandBoundary.command_ends_with_nemoclaw_start).toBe(true);
  expect(commandBoundary.command_is_sleep_infinity).toBe(false);

  const containerState = await host.command(
    "docker",
    ["inspect", "--format", "{{.State.Status}} {{.RestartCount}}", containerId],
    {
      artifactName: "phase-4-gpu-startup-container-state",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(containerState.exitCode, resultText(containerState)).toBe(0);
  expect(containerState.stdout.trim()).toBe("running 0");

  const allContainers = await host.command(
    "docker",
    [
      "ps",
      "-a",
      "--filter",
      `label=openshell.ai/sandbox-name=${sandboxName}`,
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
