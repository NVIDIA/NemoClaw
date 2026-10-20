// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";

import {
  runBoundedRetry,
  type BoundedRetryResult,
  type RetryEvidence,
} from "../../../tools/e2e/retry-evidence.mts";
import type { ArtifactSink } from "./artifacts.ts";
import { buildChildEnv } from "./redaction.ts";
import { type ShellProbe, trustedShellCommand } from "./shell-probe.ts";

export type PortableRegistryReadinessObservation =
  | { readonly kind: "ready"; readonly statusCode: 200 }
  | { readonly kind: "http-status"; readonly statusCode: number }
  | {
      readonly kind: "transport";
      readonly code: "connection-refused" | "connection-reset" | "timeout" | "unexpected";
    };

export const PORTABLE_REGISTRY_READINESS_MAX_ATTEMPTS = 10;
export const PORTABLE_REGISTRY_READINESS_DELAY_MS = 1_000;

const PORTABLE_REGISTRY_DIAGNOSTIC_ENV_KEYS = [
  "CONTAINERS_CONF",
  "CONTAINERS_STORAGE_CONF",
  "DOCKER_HOST",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
] as const;

const PROCESS_HEADROOM_DIAGNOSTIC = `
service=nemoclaw-native-podman-e2e.service
uid=$(id -u)
systemctl --user show "$service" --property=MainPID,TasksCurrent,TasksMax,LimitNPROC,ControlGroup --no-pager 2>/dev/null || true
systemctl show "user@\${uid}.service" "user-\${uid}.slice" --property=Id,TasksCurrent,TasksMax,LimitNPROC,ControlGroup --no-pager 2>/dev/null || true

capture_process() {
  local label=$1 pid=$2 group current max events depth=0
  if [[ ! $pid =~ ^[1-9][0-9]*$ || ! -r /proc/$pid/limits || ! -r /proc/$pid/cgroup ]]; then
    printf '%s_pid=unavailable\n' "$label"
    return
  fi
  printf '%s_pid=%s\n' "$label" "$pid"
  awk -v label="$label" '$1 == "Max" && $2 == "processes" { printf "%s_rlimit_nproc_soft=%s hard=%s\\n", label, $3, $4 }' "/proc/$pid/limits" || printf '%s_rlimit_nproc=unavailable\n' "$label"
  group=$(awk -F: '$1 == "0" { print $3; exit }' "/proc/$pid/cgroup" 2>/dev/null) || group=
  [[ $group == /* ]] || { printf '%s_cgroup=unavailable\n' "$label"; return; }
  while (( depth < 24 )); do
    current=$(cat "/sys/fs/cgroup$group/pids.current" 2>/dev/null) || current=unavailable
    max=$(cat "/sys/fs/cgroup$group/pids.max" 2>/dev/null) || max=unavailable
    events=$(awk '$1 == "max" { print $2; exit }' "/sys/fs/cgroup$group/pids.events" 2>/dev/null) || events=unavailable
    printf '%s_cgroup=%s pids_current=%s pids_max=%s pids_events_max=%s\n' "$label" "$group" "\${current:-unavailable}" "\${max:-unavailable}" "\${events:-unavailable}"
    [[ $group == / ]] && break
    group=\${group%/*}
    [[ -n $group ]] || group=/
    ((depth += 1))
  done
}

service_pid=$(systemctl --user show "$service" --property=MainPID --value 2>/dev/null || true)
registry_pid=$(podman container inspect --format '{{.State.Pid}}' nemoclaw-portable-registry 2>/dev/null || true)
capture_process service "$service_pid"
capture_process registry "$registry_pid"
user_tasks=$(ps -u "$uid" -L --no-headers 2>/dev/null | wc -l | tr -d ' ') || user_tasks=unavailable
printf 'user_tasks=%s\n' "\${user_tasks:-unavailable}"
host_threads_max=$(cat /proc/sys/kernel/threads-max 2>/dev/null) || host_threads_max=unavailable
host_pid_max=$(cat /proc/sys/kernel/pid_max 2>/dev/null) || host_pid_max=unavailable
host_tasks=$(awk '{ split($4, tasks, "/"); print tasks[2] }' /proc/loadavg 2>/dev/null) || host_tasks=unavailable
printf 'host_threads_max=%s\n' "\${host_threads_max:-unavailable}"
printf 'host_pid_max=%s\n' "\${host_pid_max:-unavailable}"
printf 'host_tasks=%s\n' "\${host_tasks:-unavailable}"
`;

function retryableTransport(observation: PortableRegistryReadinessObservation): boolean {
  return observation.kind === "transport" && observation.code !== "unexpected";
}

/**
 * Wait for the managed registry through a bounded read-only policy.
 *
 * Connection refusal, reset, and timeout are the only transient startup
 * signatures. An HTTP response other than the unauthenticated registry 200,
 * or an unknown transport failure, stops immediately for diagnostics.
 */
export async function runPortableRegistryReadinessPolicy(options: {
  readonly probe: (attempt: number) => Promise<PortableRegistryReadinessObservation>;
  readonly onEvidence?: (evidence: RetryEvidence) => Promise<void> | void;
  readonly maxAttempts?: number;
  readonly delayMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}): Promise<BoundedRetryResult<PortableRegistryReadinessObservation>> {
  return runBoundedRetry({
    operation: "portable-registry.http-readiness",
    owner: "portable-profile-rootless-linux",
    idempotence: "read-only",
    maxAttempts: options.maxAttempts ?? PORTABLE_REGISTRY_READINESS_MAX_ATTEMPTS,
    delayMs: options.delayMs ?? PORTABLE_REGISTRY_READINESS_DELAY_MS,
    run: options.probe,
    classify: (observation, error) => {
      if (error !== undefined || observation === undefined) {
        return { outcome: "failed", failureClass: "deterministic" };
      }
      if (observation.kind === "ready") return { outcome: "passed" };
      return {
        outcome: "failed",
        failureClass: retryableTransport(observation) ? "transient-external" : "deterministic",
      };
    },
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.onEvidence ? { onEvidence: options.onEvidence } : {}),
  });
}

export async function probePortableRegistry(
  url = "http://127.0.0.1:5000/v2/",
): Promise<PortableRegistryReadinessObservation> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (observation: PortableRegistryReadinessObservation): void => {
      if (settled) return;
      settled = true;
      resolve(observation);
    };
    const request = http.get(url, (response) => {
      const responseFailure = (): void => {
        settle({ kind: "transport", code: "unexpected" });
      };
      response.once("aborted", responseFailure);
      response.once("error", responseFailure);
      response.once("close", () => {
        if (!response.complete) responseFailure();
      });
      response.resume();
      response.once("end", () =>
        settle(
          response.statusCode === 200
            ? { kind: "ready", statusCode: 200 }
            : { kind: "http-status", statusCode: response.statusCode ?? 0 },
        ),
      );
    });
    request.once("error", (error: NodeJS.ErrnoException) => {
      const code =
        error.code === "ECONNREFUSED"
          ? "connection-refused"
          : error.code === "ECONNRESET"
            ? "connection-reset"
            : error.code === "ETIMEDOUT"
              ? "timeout"
              : "unexpected";
      settle({ kind: "transport", code });
    });
    request.setTimeout(500, () => {
      settle({ kind: "transport", code: "timeout" });
      request.destroy();
    });
  });
}

async function captureRegistryFailureDiagnostics(shellProbe: ShellProbe): Promise<void> {
  const env = buildChildEnv(process.env, {
    additionalAllowedEnv: PORTABLE_REGISTRY_DIAGNOSTIC_ENV_KEYS,
    fixtureOverlay: {},
  });
  const commands = [
    {
      artifactName: "portable-registry-container-inspect",
      args: [
        "container",
        "inspect",
        "--format",
        [
          "id={{.Id}}",
          "name={{.Name}}",
          "status={{.State.Status}}",
          "running={{.State.Running}}",
          "exit_code={{.State.ExitCode}}",
          "error={{.State.Error}}",
        ].join("\\n"),
        "nemoclaw-portable-registry",
      ],
      reason: "capture the managed registry container state after readiness failure",
    },
    {
      artifactName: "portable-registry-port-mapping",
      args: ["port", "nemoclaw-portable-registry", "5000/tcp"],
      reason: "capture the managed registry published port after readiness failure",
    },
    {
      artifactName: "portable-registry-log-tail",
      args: ["logs", "--tail", "50", "nemoclaw-portable-registry"],
      reason: "capture a bounded managed registry log tail after readiness failure",
    },
  ] as const;
  // Capture headroom before the other probes add processes to a constrained runner.
  await shellProbe
    .run(
      trustedShellCommand({
        command: "bash",
        args: ["-e", "-u", "-o", "pipefail", "-c", PROCESS_HEADROOM_DIAGNOSTIC],
        reason: "capture bounded process and cgroup headroom after registry readiness failure",
      }),
      {
        artifactName: "portable-registry-process-headroom",
        captureLimitBytes: 32 * 1024,
        env,
        timeoutMs: 10_000,
      },
    )
    .catch(() => undefined);
  await Promise.allSettled(
    commands.map((command) =>
      shellProbe.run(
        trustedShellCommand({
          command: "podman",
          args: command.args,
          reason: command.reason,
        }),
        {
          artifactName: command.artifactName,
          captureLimitBytes: 32 * 1024,
          env,
          timeoutMs: 10_000,
        },
      ),
    ),
  );
}

export async function collectPortableRegistryReadinessFailure(options: {
  readonly artifacts: ArtifactSink;
  readonly probe?: (attempt: number) => Promise<PortableRegistryReadinessObservation>;
  readonly shellProbe: ShellProbe;
}): Promise<PortableRegistryReadinessObservation | undefined> {
  const result = await runPortableRegistryReadinessPolicy({
    probe: options.probe ?? (() => probePortableRegistry()),
    onEvidence: async (evidence) => {
      await options.artifacts.writeJson("portable-registry-readiness-retry.json", evidence);
    },
  });
  if (result.outcome === "passed") return undefined;
  await options.artifacts.writeJson("portable-registry-readiness-failure.json", {
    observation: result.value ?? null,
  });
  await captureRegistryFailureDiagnostics(options.shellProbe);
  return result.value;
}
