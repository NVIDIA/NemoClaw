// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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

export const HERMES_GPU_EXTRA_PLACEHOLDER_KEYS = [
  "TELEGRAM_BOT_TOKEN_AGENT_A",
  "SLACK_BOT_TOKEN_AGENT_B",
] as const;
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
  expect(installText).toContain("Starting OpenShell Docker-driver gateway...");
  expect(installText).toContain("Docker-driver gateway is healthy");
  expect(installText).not.toContain("Reusing healthy NemoClaw gateway.");
  expect(installText).not.toContain("Reusing existing Docker-driver gateway");
  expect(installText).not.toContain("[reuse] Skipping gateway (running)");
  if (gpuRoute === "compatibility-only") {
    expect(installText).toContain(
      "Recreating OpenShell Docker sandbox container with NVIDIA GPU access",
    );
    expect(installText).toContain("Docker container mode selected:");
    for (const fragment of HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS) {
      expect(installText).not.toContain(fragment);
    }
  } else if (gpuRoute === "compatibility-fallback") {
    expect(installText).toContain(
      "Operator-authorized GPU fallback enabled; trying native OpenShell injection with one compatibility retry.",
    );
    for (const fragment of HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS) {
      expect(installText).toContain(fragment);
    }
    expect(installText).toContain(
      "Recreating OpenShell Docker sandbox container with NVIDIA GPU access",
    );
    expect(installText).toContain("Docker container mode selected:");
  } else {
    expect(installText).toContain(
      "Direct sandbox GPU enabled; allowing OpenShell GPU policy enrichment.",
    );
    expect(installText).not.toContain(
      "Recreating OpenShell Docker sandbox container with NVIDIA GPU access",
    );
    expect(installText).not.toContain("Docker container mode selected:");
    for (const fragment of HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS) {
      expect(installText).not.toContain(fragment);
    }
  }
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

  const expectedExtraPlaceholderAssignment = `NEMOCLAW_EXTRA_PLACEHOLDER_KEYS=${HERMES_GPU_EXTRA_PLACEHOLDER_KEYS.join(",")}`;
  const extraPlaceholderEnv = await host.command(
    "docker",
    [
      "exec",
      "--user",
      "0",
      containerId,
      "python3",
      "-c",
      String.raw`import os
from pathlib import Path

expected = ${JSON.stringify(expectedExtraPlaceholderAssignment)}.encode("utf-8")
for proc in Path("/proc").iterdir():
    if not proc.name.isdigit() or int(proc.name) == os.getpid():
        continue
    try:
        argv = [item.decode("utf-8", "strict") for item in (proc / "cmdline").read_bytes().split(b"\0") if item]
        if not any(Path(item).name == "nemoclaw-start" for item in argv):
            continue
        entries = (proc / "environ").read_bytes().split(b"\0")
    except (OSError, UnicodeDecodeError):
        continue
    if expected in entries:
        print(expected.decode("utf-8"))
        raise SystemExit(0)
raise SystemExit(1)`,
    ],
    {
      artifactName: "phase-4-gpu-startup-extra-placeholder-env",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(extraPlaceholderEnv.exitCode, resultText(extraPlaceholderEnv)).toBe(0);
  expect(extraPlaceholderEnv.stdout.trim()).toBe(expectedExtraPlaceholderAssignment);

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
      String.raw`docker inspect "$1" | python3 -c 'import json, sys; config=json.load(sys.stdin)[0]["Config"]; env=dict(item.split("=", 1) for item in (config.get("Env") or []) if "=" in item); command=env.get("OPENSHELL_SANDBOX_COMMAND", ""); tokens=command.split(); print(json.dumps({"cmd": config.get("Cmd"), "entrypoint": config.get("Entrypoint"), "has_openshell_sandbox_command": bool(command), "command_is_sleep_infinity": tokens == ["sleep", "infinity"], "command_ends_with_nemoclaw_start": bool(tokens) and tokens[-1] in ("nemoclaw-start", "/usr/local/bin/nemoclaw-start")}))'`,
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
  expect([null, []]).toContainEqual(commandBoundary.cmd);
  expect(commandBoundary).toMatchObject({
    entrypoint: ["/opt/openshell/bin/openshell-sandbox"],
    has_openshell_sandbox_command: true,
  });
  if (gpuRoute !== "native-success") {
    expect(commandBoundary.command_ends_with_nemoclaw_start).toBe(true);
    expect(commandBoundary.command_is_sleep_infinity).toBe(false);
  } else {
    expect(commandBoundary.command_is_sleep_infinity).toBe(true);
    expect(commandBoundary.command_ends_with_nemoclaw_start).toBe(false);
  }

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
