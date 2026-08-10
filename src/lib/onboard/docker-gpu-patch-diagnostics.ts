// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { dockerCapture, dockerLogs } from "../adapters/docker";
import { GATEWAY_PORT } from "../core/ports";
import { rejectSymlinksOnPath } from "../state/config-io";
import { nemoclawStateRoot } from "../state/state-root";
import { createDockerGpuDiagnosticRedactor } from "./docker-gpu-diagnostic-redaction";
import { fullDockerContainerId } from "./docker-gpu-patch-clone";
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
  DockerRecreateLifecycleObservation,
} from "./docker-gpu-patch-types";
import {
  OPENSHELL_MANAGED_BY_LABEL,
  OPENSHELL_MANAGED_BY_VALUE,
  OPENSHELL_SANDBOX_NAME_LABEL,
  queryOpenShellDockerSandboxContainers,
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

const MAX_DIAGNOSTIC_FILE_BYTES = 256_000;
const MAX_JSON_TRAILING_PREVIEW_BYTES = 96_000;

function boundTextToUtf8Bytes(content: string, maxBytes = MAX_DIAGNOSTIC_FILE_BYTES): string {
  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  if (Buffer.byteLength(normalized) <= maxBytes) return normalized;
  const marker = `[diagnostic truncated to complete trailing lines within ${String(maxBytes)} bytes]\n`;
  const tailBudget = Math.max(0, maxBytes - Buffer.byteLength(marker));
  const bytes = Buffer.from(normalized);
  let tail = bytes.subarray(Math.max(0, bytes.length - tailBudget)).toString("utf8");
  const firstNewline = tail.indexOf("\n");
  if (firstNewline < 0) return `${marker}[oversized single-line diagnostic omitted]\n`;
  tail = tail.slice(firstNewline + 1);
  while (Buffer.byteLength(marker) + Buffer.byteLength(tail) > maxBytes) tail = tail.slice(1);
  return `${marker}${tail}`;
}

function writeTextFile(dir: string, name: string, content: string): void {
  fs.writeFileSync(path.join(dir, name), boundTextToUtf8Bytes(content), {
    mode: 0o600,
  });
}

function writeJsonFile(dir: string, name: string, value: unknown): void {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized) <= MAX_DIAGNOSTIC_FILE_BYTES) {
    fs.writeFileSync(path.join(dir, name), serialized, { mode: 0o600 });
    return;
  }
  const bounded = {
    diagnosticTruncated: true,
    originalBytes: Buffer.byteLength(serialized),
    trailingPreview: boundTextToUtf8Bytes(serialized, MAX_JSON_TRAILING_PREVIEW_BYTES),
  };
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify(bounded, null, 2)}\n`, { mode: 0o600 });
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

function fingerprintSandboxLiveIdentity(getOutput: string): string | null {
  const clean = String(getOutput).replace(/\x1b\[[0-9;]*m/g, "");
  const id = clean.match(/^\s*Id:\s+(\S+)\s*$/im)?.[1];
  if (!id || id.length > 512) return null;
  return createHash("sha256").update(id).digest("hex");
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
    `image_id=${inspect.Image ?? "unknown"}`,
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

function dockerGpuReplacementCleanupCommands(containerId: string): string[] {
  return [`docker rm -f ${JSON.stringify(containerId)}`];
}

function confirmationValue(value: boolean | undefined): string {
  return value === true ? "yes" : value === false ? "no" : "unknown";
}

function diagnosticContainerId(value: string | null | undefined): string | null {
  const normalized = fullDockerContainerId(value);
  if (normalized) return normalized;
  const fallback = String(value ?? "").trim();
  return fallback || null;
}

function queryDiagnosticContainerIds(
  sandboxName: string,
  deps: DockerGpuPatchDeps,
  capture: NonNullable<DockerGpuPatchDeps["dockerCapture"]>,
) {
  return queryOpenShellDockerSandboxContainers(sandboxName, {
    dockerRun:
      deps.dockerRun ??
      ((args, options) => {
        try {
          return {
            status: 0,
            stdout: capture(args, { ...options, ignoreError: false }),
            stderr: "",
          };
        } catch {
          return { status: 1, stdout: "", stderr: "docker ps did not complete successfully" };
        }
      }),
  });
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
    lifecycleGeneration?: string | null;
    lifecycleObservations?: readonly DockerRecreateLifecycleObservation[];
    lifecycleObservationDroppedCount?: number;
    cleanupReason?: string | null;
    cleanupStartedAt?: string | null;
    forwardDiagnostic?: string | null;
    forwardListOutput?: string | null;
    captureStage?: "pre-rollback" | "post-cutover-pre-cleanup";
    /**
     * The caller captured evidence before rollback and cannot yet determine
     * whether manual cleanup will be required.
     */
    cleanupDisposition?: "pending-rollback" | "pending-sandbox-delete";
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
  const selectedMode = options.selectedMode || context?.selectedMode || null;
  const snapshot = options.snapshot ?? null;
  const classification = options.classification ?? null;
  const redactor = createDockerGpuDiagnosticRedactor(options.additionalSensitiveValues);
  const containerIdentityQuery = queryDiagnosticContainerIds(sandboxName, deps, capture);
  const discoveredContainerIds = containerIdentityQuery.ids;
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
    writeJsonFile(dir, name, redactor.redactValue(value));
  };

  const cleanupPendingRollback = options.cleanupDisposition === "pending-rollback";
  const cleanupPendingSandboxDelete = options.cleanupDisposition === "pending-sandbox-delete";
  const prePatchRestored = context?.rolledBack === true;
  const replacementId = fullDockerContainerId(context?.newContainerId);
  const inspectConfirmsReplacementPresent =
    replacementId !== null &&
    inspectedTargets.some(({ entries }) =>
      entries.some((entry) => fullDockerContainerId(entry.Id) === replacementId),
    );
  const snapshotConfirmsReplacementPresent =
    replacementId !== null && snapshot?.patchedContainerState != null;
  const replacementPresence =
    snapshotConfirmsReplacementPresent || inspectConfirmsReplacementPresent
      ? "present"
      : (context?.replacementPresence ?? "unknown");
  const expectedContainerId = diagnosticContainerId(context?.newContainerId);
  const observedContainerIds = discoveredContainerIds
    .map(diagnosticContainerId)
    .filter((value): value is string => value !== null);
  const containerIdentityMatch =
    expectedContainerId === null || !containerIdentityQuery.ok
      ? "unknown"
      : observedContainerIds.length !== 1
        ? observedContainerIds.length === 0
          ? "missing"
          : "ambiguous"
        : observedContainerIds[0] === expectedContainerId
          ? "yes"
          : "no";
  let cleanupDisposition: DockerGpuPatchDiagnostics["cleanupDisposition"];
  let cleanupCommands: string[] = [];
  if (cleanupPendingRollback) {
    cleanupDisposition = "pending_rollback";
  } else if (cleanupPendingSandboxDelete) {
    cleanupDisposition = "pending_sandbox_delete";
  } else if (!prePatchRestored) {
    cleanupDisposition = "unknown";
  } else if (replacementPresence === "absent") {
    cleanupDisposition = "not_required";
  } else if (replacementId) {
    cleanupDisposition = "manual";
    cleanupCommands = dockerGpuReplacementCleanupCommands(replacementId).map(redactor.redactText);
  } else {
    cleanupDisposition = "unknown";
  }
  const errorText = redactor.redactText(
    options.error instanceof Error
      ? options.error.message
      : options.error
        ? String(options.error)
        : "none",
  );
  const summaryLines = [
    `created_at=${now.toISOString()}`,
    `sandbox_name=${redactor.redactText(sandboxName)}`,
    `error=${errorText}`,
    ...(options.additionalSummaryLines ?? []).map(redactor.redactText),
    `selected_gpu_mode=${redactor.redactText(selectedMode?.label ?? "none")}`,
    `old_container_id=${redactor.redactText(context?.oldContainerId ?? "unknown")}`,
    `new_container_id=${redactor.redactText(context?.newContainerId ?? "unknown")}`,
    `backup_container_name=${redactor.redactText(context?.backupContainerName ?? "none")}`,
    `lifecycle_generation=${redactor.redactText(options.lifecycleGeneration ?? "unknown")}`,
    `lifecycle_history_dropped=${String(options.lifecycleObservationDroppedCount ?? 0)}`,
    `capture_stage=${options.captureStage?.replaceAll("-", "_") ?? "unspecified"}`,
    `expected_container_id=${redactor.redactText(expectedContainerId ?? "unknown")}`,
    `observed_container_ids=${redactor.redactText(containerIdentityQuery.ok ? observedContainerIds.join(",") || "none" : "unknown")}`,
    `container_identity_query=${containerIdentityQuery.ok ? "succeeded" : "failed"}`,
    `container_identity_match=${containerIdentityMatch}`,
    `cleanup_reason=${redactor.redactText(options.cleanupReason ?? "unknown")}`,
    `cleanup_started_at=${redactor.redactText(options.cleanupStartedAt ?? "unknown")}`,
    `rolled_back=${cleanupPendingRollback ? "pending" : cleanupPendingSandboxDelete ? "not_applicable" : context?.rolledBack === true ? "yes" : context?.rolledBack === false ? "failed" : "no"}`,
    ...(context?.replacementStopConfirmed !== undefined
      ? [`replacement_stop_confirmed=${confirmationValue(context.replacementStopConfirmed)}`]
      : []),
    ...(context?.replacementRemovalConfirmed !== undefined
      ? [`replacement_removal_confirmed=${confirmationValue(context.replacementRemovalConfirmed)}`]
      : []),
    ...(prePatchRestored ? [`replacement_presence=${replacementPresence}`] : []),
    `cleanup_disposition=${cleanupDisposition}`,
    `cleanup_required=${cleanupDisposition === "manual" ? "yes" : cleanupDisposition === "not_required" ? "no" : "unknown"}`,
    ...(cleanupCommands.length > 0
      ? ["cleanup_commands:", ...cleanupCommands.map((command) => `  ${command}`)]
      : []),
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
  let sandboxGetOutput = "";
  if (deps.runCaptureOpenshell) {
    try {
      sandboxGetOutput = deps.runCaptureOpenshell(["sandbox", "get", sandboxName], {
        ignoreError: true,
        timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
      });
    } catch {
      // The standalone capture loop below still records the other evidence.
    }
  }
  const liveIdentityFingerprint = fingerprintSandboxLiveIdentity(sandboxGetOutput);
  summaryLines.push(
    `openshell_identity_fingerprint=${redactor.redactText(liveIdentityFingerprint ?? "unknown")}`,
  );
  writeDiagnosticText("summary.txt", summaryLines.join("\n"));
  if (snapshot?.patchedContainerState) {
    writeDiagnosticJson(
      "patched-container-state.json",
      redactor.sanitizeState(snapshot.patchedContainerState),
    );
  }
  if (options.dockerTopOutput?.trim())
    writeDiagnosticText("docker-top.txt", options.dockerTopOutput);
  if (options.lifecycleObservations?.length) {
    writeDiagnosticJson("lifecycle-history.json", options.lifecycleObservations);
  }
  if (options.forwardDiagnostic?.trim()) {
    writeDiagnosticText("forward-start.txt", options.forwardDiagnostic);
  }
  if (options.forwardListOutput?.trim()) {
    writeDiagnosticText("forward-list.txt", options.forwardListOutput);
  }

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
    const expectedTarget = context?.newContainerId ?? discoveredContainerIds[0] ?? null;
    if (expectedTarget) {
      for (const [fileName, logPath] of [
        ["managed-startup.log", "/tmp/nemoclaw-start.log"],
        ["openclaw-gateway.log", "/tmp/gateway.log"],
      ] as const) {
        try {
          const output = capture(
            ["exec", expectedTarget, "sh", "-c", `test -f ${logPath} && tail -n 240 ${logPath}`],
            { ignoreError: true, timeout: DOCKER_GPU_PATCH_TIMEOUT_MS },
          );
          if (output.trim()) writeDiagnosticText(fileName, output);
        } catch {
          // Best effort.
        }
      }
    }
  }

  if (deps.runCaptureOpenshell) {
    const captures: Array<[string, string[]]> = [
      ["openshell-version.txt", ["--version"]],
      ["openshell-sandbox-list.txt", ["sandbox", "list"]],
      ["openshell-forward-list.txt", ["forward", "list"]],
      ["openshell-logs.txt", ["doctor", "logs", "--name", "nemoclaw"]],
    ];
    if (sandboxGetOutput.trim()) writeDiagnosticText("openshell-sandbox-get.txt", sandboxGetOutput);
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

  return { dir, cleanupCommands, cleanupDisposition, summaryLines };
}
