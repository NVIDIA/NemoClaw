// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { dockerRun } from "../../../src/lib/adapters/docker/command.ts";
import { createDockerGpuDiagnosticRedactor } from "../../../src/lib/onboard/docker-gpu-diagnostic-redaction.ts";
import { resolveGatewayLogPathForPort } from "../../../src/lib/onboard/gateway/state-dir.ts";
import { captureDockerContainerFailureEvidence } from "../../../src/lib/onboard/managed-bootstrap/docker-container-failure-evidence.ts";

import type { ArtifactSink } from "./artifacts.ts";
import type { HostCliClient } from "./clients/host.ts";
import type { ShellProbeResult } from "./shell-probe.ts";

const MAX_CONTAINERS = 4;
const MAX_GATEWAY_LOG_BYTES = 16 * 1024;

export async function installJetsonWithDiagnostics(
  artifacts: ArtifactSink,
  host: Pick<HostCliClient, "command" | "openshellCommandPath">,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<ShellProbeResult> {
  let result: ShellProbeResult | undefined;
  try {
    result = await host.command("bash", ["install.sh", "--non-interactive"], {
      artifactName: "phase-2-install-jetson-nvmap",
      cwd,
      env,
      timeoutMs: 40 * 60_000,
    });
    return result;
  } finally {
    if (result?.exitCode !== 0) {
      await captureJetsonInstallFailureDiagnostics(artifacts, host, sandboxName, env);
    }
  }
}

function gatewayLogTail(env: NodeJS.ProcessEnv): string | null {
  if (!env.HOME) return null;
  let fd: number | undefined;
  try {
    const logPath = resolveGatewayLogPathForPort({ home: env.HOME, port: 8080 });
    fd = fs.openSync(
      logPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_GATEWAY_LOG_BYTES));
    const read = fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length));
    const lines = buffer.subarray(0, read).toString("utf8").split(/\r?\n/u);
    if (stat.size > buffer.length) lines.shift();
    return lines.slice(-120).join("\n");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Capture runtime evidence before failed installation releases its test-owned resources. */
export async function captureJetsonInstallFailureDiagnostics(
  artifacts: ArtifactSink,
  host: Pick<HostCliClient, "command" | "openshellCommandPath">,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    const redactor = createDockerGpuDiagnosticRedactor([env.COMPATIBLE_API_KEY ?? ""]);
    const capture = (args: readonly string[], includeStderr = false): string | null => {
      const result = dockerRun(args, {
        env,
        replaceEnv: true,
        ignoreError: true,
        suppressOutput: true,
        timeout: 2_000,
        killSignal: "SIGKILL",
        maxBuffer: 256 * 1024,
      });
      if (result.error || result.status !== 0) return null;
      const stdout = String(result.stdout ?? "");
      if (args[0] === "inspect" && args.length === 2) {
        const inspected = JSON.parse(stdout);
        if (Array.isArray(inspected) && inspected.length === 1)
          redactor.rememberInspect(inspected[0]);
      }
      return includeStderr ? `${stdout}\n${String(result.stderr ?? "")}` : stdout;
    };
    let inventory: string | null = null;
    try {
      inventory = capture([
        "ps",
        "--all",
        "--no-trunc",
        "--filter",
        "label=openshell.ai/managed-by=openshell",
        "--filter",
        `label=openshell.ai/sandbox-name=${sandboxName}`,
        "--format",
        "{{.ID}}",
      ]);
    } catch {
      // Gateway evidence remains useful when Docker is unavailable.
    }
    const containerIds = [...new Set((inventory ?? "").trim().split(/\s+/u))].filter((id) =>
      /^[a-f0-9]{64}$/u.test(id),
    );
    const containers = containerIds.slice(0, MAX_CONTAINERS).map((id) => ({
      id,
      ...captureDockerContainerFailureEvidence(id, {
        dockerCapture: (args) => capture(args) ?? "",
        dockerLogs: (containerId, options) =>
          capture(["logs", "--tail", String(options?.tail ?? 120), containerId], true) ?? "",
      }),
    }));
    let sandbox: { exitCode: number | null; stdout: string; stderr: string } | null = null;
    try {
      const result = await host.command(
        host.openshellCommandPath,
        ["sandbox", "get", "-g", env.OPENSHELL_GATEWAY ?? "nemoclaw", sandboxName],
        { env, timeoutMs: 2_000, captureLimitBytes: 16 * 1024, persistArtifacts: false },
      );
      sandbox = { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    } catch {
      // Container evidence remains useful when the gateway cannot answer.
    }
    await artifacts.writeJson(
      "jetson-install-failure.json",
      redactor.redactValue({
        schemaVersion: 1,
        capturedAt: new Date().toISOString(),
        sandboxName,
        inventoryAvailable: inventory !== null,
        containersTruncated: containerIds.length > MAX_CONTAINERS,
        containers,
        sandbox,
        gatewayLogTail: gatewayLogTail(env),
      }),
    );
  } catch {
    // Diagnostic acquisition and artifact failures must preserve the installation failure.
  }
}
