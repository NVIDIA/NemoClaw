// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { dockerCapture, dockerLogs } from "../adapters/docker";
import { GATEWAY_PORT } from "../core/ports";
import { rejectSymlinksOnPath } from "../state/config-io";
import { nemoclawStateRoot } from "../state/state-root";
import { createDockerGpuDiagnosticRedactor } from "./docker-gpu-diagnostic-redaction";
import { DOCKER_GPU_PATCH_TIMEOUT_MS } from "./docker-gpu-patch-constants";
import { getDockerGpuPatchFailureContext } from "./docker-gpu-patch-recreate";
import type {
  DockerContainerInspect,
  DockerContainerState,
  DockerGpuPatchDeps,
  DockerGpuPatchDiagnostics,
  DockerGpuPatchFailureClassification,
  DockerGpuPatchFailureContext,
  DockerGpuPatchMode,
  DockerGpuPatchSandboxSnapshot,
} from "./docker-gpu-patch-types";
import {
  findOpenShellDockerSandboxContainerIds,
  OPENSHELL_MANAGED_BY_LABEL,
  OPENSHELL_MANAGED_BY_VALUE,
  OPENSHELL_SANDBOX_NAME_LABEL,
} from "./openshell-docker-sandbox-containers";

function stringArray(value: string[] | string | null | undefined): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}

function envKey(env: string): string {
  const index = env.indexOf("=");
  return index === -1 ? env : env.slice(0, index);
}

function writeTextFile(dir: string, name: string, content: string): void {
  fs.writeFileSync(path.join(dir, name), content.endsWith("\n") ? content : `${content}\n`, {
    mode: 0o600,
  });
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "sandbox";
}

function timestampForPath(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

const DIAGNOSTIC_ENV_KEYS = new Set([
  "OPENSHELL_ENDPOINT",
  "OPENSHELL_SANDBOX_ID",
  "OPENSHELL_SANDBOX",
  "OPENSHELL_LOG_LEVEL",
  "OPENSHELL_TLS_CA",
  "OPENSHELL_TLS_CERT",
  "OPENSHELL_TLS_KEY",
]);

function diagnosticEnvLines(env: string[] | null | undefined): string[] {
  return stringArray(env)
    .filter((entry) => DIAGNOSTIC_ENV_KEYS.has(envKey(entry)))
    .sort()
    .map((entry) => `  env.${envKey(entry)}=${entry.slice(envKey(entry).length + 1)}`);
}

export function formatDockerInspectNetworkSummary(
  target: string,
  inspect: DockerContainerInspect,
): string {
  const lines = [
    `target=${target}`,
    `id=${inspect.Id ?? "unknown"}`,
    `name=${String(inspect.Name || "").replace(/^\/+/, "") || "unknown"}`,
    `image=${inspect.Config?.Image ?? "unknown"}`,
    `network_mode=${inspect.HostConfig?.NetworkMode ?? "unknown"}`,
  ];
  const extraHosts = stringArray(inspect.HostConfig?.ExtraHosts);
  if (extraHosts.length > 0) {
    lines.push("extra_hosts:");
    for (const entry of extraHosts) lines.push(`  ${entry}`);
  }
  const envLines = diagnosticEnvLines(inspect.Config?.Env);
  if (envLines.length > 0) lines.push("openshell_env:", ...envLines);
  const networks = inspect.NetworkSettings?.Networks || {};
  const names = Object.keys(networks).sort();
  if (names.length > 0) {
    lines.push("networks:");
    for (const name of names) {
      const network = networks[name] || {};
      lines.push(
        `  ${name}: ip=${network.IPAddress || "unknown"} gateway=${network.Gateway || "unknown"}`,
      );
      const aliases = stringArray(network.Aliases);
      if (aliases.length > 0) lines.push(`    aliases=${aliases.join(",")}`);
    }
  }
  return lines.join("\n");
}

function describePatchedContainerState(state: DockerContainerState | null): string[] {
  if (!state) return [];
  const lines: string[] = [];
  if (state.Status) lines.push(`patched_container_status=${state.Status}`);
  if (typeof state.ExitCode === "number") {
    lines.push(`patched_container_exit_code=${state.ExitCode}`);
  }
  if (state.OOMKilled) lines.push("patched_container_oom_killed=true");
  if (state.Error) lines.push(`patched_container_error=${state.Error}`);
  if (state.Health?.Status) lines.push(`patched_container_health=${state.Health.Status}`);
  if (state.FinishedAt && state.FinishedAt !== "0001-01-01T00:00:00Z") {
    lines.push(`patched_container_finished_at=${state.FinishedAt}`);
  }
  return lines;
}

export function dockerGpuPatchCleanupCommands(sandboxName: string): string[] {
  return [`openshell sandbox delete ${JSON.stringify(sandboxName)}`];
}

export function collectDockerGpuPatchDiagnostics(
  sandboxName: string,
  options: {
    error?: unknown;
    context?: DockerGpuPatchFailureContext | null;
    selectedMode?: DockerGpuPatchMode | null;
    snapshot?: DockerGpuPatchSandboxSnapshot | null;
    classification?: DockerGpuPatchFailureClassification | null;
    additionalSummaryLines?: readonly string[];
    additionalSensitiveValues?: readonly string[];
    dockerTopOutput?: string | null;
  } = {},
  deps: DockerGpuPatchDeps = {},
): DockerGpuPatchDiagnostics | null {
  const home = (deps.homedir ?? os.homedir)();
  if (!path.isAbsolute(home)) return null;
  const capture = deps.dockerCapture ?? dockerCapture;
  const logs = deps.dockerLogs ?? dockerLogs;
  const now = (deps.now ?? (() => new Date()))();
  const dir = path.join(
    nemoclawStateRoot(home, GATEWAY_PORT),
    "onboard-failures",
    `${timestampForPath(now)}-${sanitizePathPart(sandboxName)}-docker-gpu-patch`,
  );
  try {
    rejectSymlinksOnPath(dir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    rejectSymlinksOnPath(dir);
  } catch {
    return null;
  }

  const context = options.context || getDockerGpuPatchFailureContext(options.error) || null;
  const redactor = createDockerGpuDiagnosticRedactor(options.additionalSensitiveValues);
  let discoveredContainerIds: string[] = [];
  try {
    discoveredContainerIds = findOpenShellDockerSandboxContainerIds(sandboxName, deps);
  } catch {
    discoveredContainerIds = [];
  }
  const containerTargets = uniqueStrings([
    ...(context
      ? [context.oldContainerId, context.newContainerId, context.backupContainerName]
      : []),
    ...discoveredContainerIds,
  ]);
  const inspectedTargets: Array<{ target: string; entries: DockerContainerInspect[] }> = [];
  for (const target of containerTargets) {
    try {
      const inspect = capture(["inspect", target], {
        ignoreError: true,
        timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
      });
      if (!inspect.trim()) continue;
      const parsed = JSON.parse(inspect);
      const entries = (Array.isArray(parsed) ? parsed : [parsed]) as DockerContainerInspect[];
      for (const entry of entries) redactor.rememberInspect(entry);
      inspectedTargets.push({ target, entries });
    } catch {
      // Best-effort diagnostics must not hide the original failure.
    }
  }
  const writeDiagnosticText = (name: string, content: string): void => {
    writeTextFile(dir, name, redactor.redactText(content));
  };
  const writeDiagnosticJson = (name: string, value: unknown): void => {
    writeTextFile(dir, name, JSON.stringify(redactor.redactValue(value), null, 2));
  };

  const cleanupCommands = dockerGpuPatchCleanupCommands(sandboxName).map(redactor.redactText);
  const errorText = redactor.redactText(
    options.error instanceof Error
      ? options.error.message
      : options.error
        ? String(options.error)
        : "none",
  );
  const selectedMode = options.selectedMode || context?.selectedMode || null;
  const snapshot = options.snapshot ?? null;
  const classification = options.classification ?? null;
  const summaryLines = [
    `created_at=${now.toISOString()}`,
    `sandbox_name=${redactor.redactText(sandboxName)}`,
    `error=${errorText}`,
    ...(options.additionalSummaryLines ?? []).map(redactor.redactText),
    `selected_gpu_mode=${redactor.redactText(selectedMode?.label ?? "none")}`,
    `old_container_id=${redactor.redactText(context?.oldContainerId ?? "unknown")}`,
    `new_container_id=${redactor.redactText(context?.newContainerId ?? "unknown")}`,
    `backup_container_name=${redactor.redactText(context?.backupContainerName ?? "none")}`,
    `rolled_back=${context?.rolledBack === true ? "yes" : context?.rolledBack === false ? "failed" : "no"}`,
    "cleanup_commands:",
    ...cleanupCommands.map((command) => `  ${command}`),
  ];
  if (context?.modeAttempts?.length) {
    summaryLines.push("gpu_mode_attempts:");
    for (const attempt of context.modeAttempts) {
      summaryLines.push(
        redactor.redactText(
          `  ${attempt.mode.label}: ${attempt.ok ? "ok" : "failed"}${attempt.error ? `: ${attempt.error}` : ""}`,
        ),
      );
    }
  }
  if (classification) {
    summaryLines.push(`failure_kind=${redactor.redactText(classification.kind)}`);
    if (classification.headline) {
      summaryLines.push(`failure_headline=${redactor.redactText(classification.headline)}`);
    }
  }
  if (snapshot) {
    if (snapshot.sandboxPhase) {
      summaryLines.push(`sandbox_phase=${redactor.redactText(snapshot.sandboxPhase)}`);
    }
    if (snapshot.sandboxListLine) {
      summaryLines.push(`sandbox_list_row=${redactor.redactText(snapshot.sandboxListLine)}`);
    }
    summaryLines.push(
      ...describePatchedContainerState(snapshot.patchedContainerState).map(redactor.redactText),
    );
  }
  writeDiagnosticText("summary.txt", summaryLines.join("\n"));
  if (snapshot?.patchedContainerState) {
    writeDiagnosticJson("patched-container-state.json", snapshot.patchedContainerState);
  }
  if (options.dockerTopOutput?.trim())
    writeDiagnosticText("docker-top.txt", options.dockerTopOutput);

  try {
    const ps = capture(
      [
        "ps",
        "-a",
        "--filter",
        `label=${OPENSHELL_MANAGED_BY_LABEL}=${OPENSHELL_MANAGED_BY_VALUE}`,
        "--filter",
        `label=${OPENSHELL_SANDBOX_NAME_LABEL}=${sandboxName}`,
      ],
      { ignoreError: true, timeout: DOCKER_GPU_PATCH_TIMEOUT_MS },
    );
    if (ps.trim()) writeDiagnosticText("docker-ps.txt", ps);
  } catch {
    // Best effort.
  }

  if (containerTargets.length > 0) {
    const inspectEntries: DockerContainerInspect[] = [];
    const networkSummaries: string[] = [];
    for (const { target, entries } of inspectedTargets) {
      const sanitizedEntries = entries.map(redactor.sanitizeInspect);
      inspectEntries.push(...sanitizedEntries);
      for (const [index, entry] of sanitizedEntries.entries()) {
        networkSummaries.push(
          redactor.redactText(
            formatDockerInspectNetworkSummary(
              entries.length === 1 ? target : `${target}[${index}]`,
              entry,
            ),
          ),
        );
      }
    }
    if (inspectEntries.length > 0) writeDiagnosticJson("docker-inspect.json", inspectEntries);
    if (networkSummaries.length > 0) {
      writeDiagnosticText("docker-network-summary.txt", networkSummaries.join("\n\n"));
    }
    const containerLogs = containerTargets
      .map((target) => {
        try {
          return redactor.redactText(
            [`===== ${target} =====`, logs(target, { tail: 120 })].join("\n"),
          );
        } catch {
          return redactor.redactText(`===== ${target} =====\n(unavailable)`);
        }
      })
      .join("\n");
    if (containerLogs.trim()) writeDiagnosticText("docker-logs.txt", containerLogs);
  }

  if (deps.runCaptureOpenshell) {
    const captures: Array<[string, string[]]> = [
      ["openshell-sandbox-get.txt", ["sandbox", "get", sandboxName]],
      ["openshell-sandbox-list.txt", ["sandbox", "list"]],
      ["openshell-logs.txt", ["doctor", "logs", "--name", "nemoclaw"]],
    ];
    for (const [fileName, args] of captures) {
      try {
        const output = deps.runCaptureOpenshell(args, {
          ignoreError: true,
          timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
        });
        if (output.trim()) writeDiagnosticText(fileName, output);
      } catch {
        // Best effort.
      }
    }
  }

  return { dir, cleanupCommands, summaryLines };
}
