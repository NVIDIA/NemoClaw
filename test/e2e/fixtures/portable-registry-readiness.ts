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

const PORTABLE_REGISTRY_MINIMUM_PROCESS_HEADROOM_ENV = "PORTABLE_REGISTRY_MINIMUM_PROCESS_HEADROOM";

const PORTABLE_REGISTRY_DIAGNOSTIC_ENV_KEYS = [
  "CONTAINERS_CONF",
  "CONTAINERS_STORAGE_CONF",
  "DOCKER_HOST",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  PORTABLE_REGISTRY_MINIMUM_PROCESS_HEADROOM_ENV,
] as const;

const PROCESS_HEADROOM_DIAGNOSTIC = `
service=nemoclaw-native-podman-e2e.service
uid=$(id -u)
/usr/bin/systemctl --user show "$service" --property=MainPID,TasksCurrent,TasksMax,LimitNPROC,ControlGroup --no-pager 2>/dev/null || true
/usr/bin/systemctl show "user@\${uid}.service" "user-\${uid}.slice" --property=Id,TasksCurrent,TasksMax,LimitNPROC,ControlGroup --no-pager 2>/dev/null || true

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

service_pid=$(/usr/bin/systemctl --user show "$service" --property=MainPID --value 2>/dev/null || true)
registry_pid=$(podman container inspect --format '{{.State.Pid}}' nemoclaw-portable-registry 2>/dev/null || true)
registry_pids_limit=$(docker inspect --format '{{.HostConfig.PidsLimit}}' nemoclaw-portable-registry 2>/dev/null || true)
printf 'registry_pids_limit=%s\n' "\${registry_pids_limit:-unavailable}"
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

const PROCESS_BOUNDARY_PROBE = `
minimum=\${PORTABLE_REGISTRY_MINIMUM_PROCESS_HEADROOM:?}
service=nemoclaw-native-podman-e2e.service
service_pid=unavailable
registry_pid=unavailable
service_group=unavailable
registry_group=unavailable
tasks_max=unavailable
tasks_current=unavailable
service_cgroup_max=unavailable
service_cgroup_current=unavailable
registry_cgroups='[]'
effective_headroom=unavailable
limiting_cgroup=unavailable
registry_nproc_soft=unavailable
user_tasks=unavailable
host_threads_max=unavailable
host_tasks=unavailable

fail_boundary() {
  jq -cn --arg failureReason "$1" --argjson minimum "$minimum" \
    --arg servicePid "$service_pid" --arg registryPid "$registry_pid" \
    --arg serviceGroup "$service_group" --arg registryGroup "$registry_group" \
    --arg tasksMax "$tasks_max" --arg tasksCurrent "$tasks_current" \
    --arg cgroupMax "$service_cgroup_max" --arg cgroupCurrent "$service_cgroup_current" \
    --argjson registryCgroups "$registry_cgroups" \
    --arg effectiveHeadroom "$effective_headroom" --arg limitingCgroup "$limiting_cgroup" \
    --arg registryNprocSoft "$registry_nproc_soft" --arg userTasks "$user_tasks" \
    --arg hostThreadsMax "$host_threads_max" --arg hostTasks "$host_tasks" \
    '{schemaVersion: 2, failureReason: $failureReason, minimumHeadroom: $minimum,
      service: {pid: $servicePid, cgroup: $serviceGroup, tasksMax: $tasksMax,
        tasksCurrent: $tasksCurrent, cgroupPidsMax: $cgroupMax,
        cgroupPidsCurrent: $cgroupCurrent},
      registry: {pid: $registryPid, cgroup: $registryGroup},
      registryCgroups: $registryCgroups, effectiveHeadroom: $effectiveHeadroom,
      limitingCgroup: $limitingCgroup, registryNprocSoft: $registryNprocSoft,
      userTasks: $userTasks, hostThreadsMax: $hostThreadsMax, hostTasks: $hostTasks}'
  exit 1
}

service_pid=$(/usr/bin/systemctl --user show "$service" --property=MainPID --value 2>/dev/null || true)
registry_pid=$(podman container inspect --format '{{.State.Pid}}' nemoclaw-portable-registry 2>/dev/null || true)
[[ $service_pid =~ ^[1-9][0-9]*$ && $registry_pid =~ ^[1-9][0-9]*$ ]] || \
  fail_boundary process-identities-unavailable
service_group=$(awk -F: '$1 == "0" { print $3; exit }' "/proc/$service_pid/cgroup" 2>/dev/null || true)
registry_group=$(awk -F: '$1 == "0" { print $3; exit }' "/proc/$registry_pid/cgroup" 2>/dev/null || true)
manager_root="/user.slice/user-$(id -u).slice/user@$(id -u).service"
[[ $service_group == "$manager_root/"* && $service_group != *'..'* ]] || \
  fail_boundary service-cgroup-invalid
[[ $registry_group == "$manager_root/"* && $registry_group != *'..'* ]] || \
  fail_boundary registry-cgroup-invalid
tasks_max=$(/usr/bin/systemctl --user show "$service" --property=TasksMax --value 2>/dev/null || true)
tasks_current=$(/usr/bin/systemctl --user show "$service" --property=TasksCurrent --value 2>/dev/null || true)
service_cgroup_max=$(cat "/sys/fs/cgroup$service_group/pids.max" 2>/dev/null || true)
service_cgroup_current=$(cat "/sys/fs/cgroup$service_group/pids.current" 2>/dev/null || true)
[[ $tasks_max =~ ^[0-9]+$ && $tasks_current =~ ^[0-9]+$ ]] || \
  fail_boundary service-task-limit-unavailable
[[ $service_cgroup_max =~ ^[0-9]+$ && $service_cgroup_current =~ ^[0-9]+$ ]] || \
  fail_boundary service-cgroup-limit-unavailable
[[ $service_cgroup_max == "$tasks_max" ]] || fail_boundary service-cgroup-limit-mismatch
(( tasks_max - tasks_current >= minimum )) || fail_boundary service-headroom-insufficient
(( service_cgroup_max - service_cgroup_current >= minimum )) || \
  fail_boundary service-cgroup-headroom-insufficient

# Podman can move a rootless container into a sibling scope. Every ancestor of
# the observed registry PID can constrain it, including limits outside the user
# manager. Cgroup v2 exposes pids.max/current only on non-root cgroups, so the
# root cannot impose a pids-controller limit. Record every non-root ancestor and
# require a finite effective limit with headroom.
group="$registry_group"
depth=0
while (( depth < 24 )); do
  [[ $group != / ]] || break
  cgroup_max=$(cat "/sys/fs/cgroup$group/pids.max" 2>/dev/null || true)
  cgroup_current=$(cat "/sys/fs/cgroup$group/pids.current" 2>/dev/null || true)
  [[ $cgroup_current =~ ^[0-9]+$ && ( $cgroup_max == max || $cgroup_max =~ ^[0-9]+$ ) ]] || \
    fail_boundary registry-cgroup-limit-unavailable
  registry_cgroups=$(jq -cn --argjson rows "$registry_cgroups" --arg path "$group" \
    --arg pidsMax "$cgroup_max" --argjson pidsCurrent "$cgroup_current" \
    '$rows + [{path: $path, pidsMax: $pidsMax, pidsCurrent: $pidsCurrent}]')
  if [[ $cgroup_max != max ]]; then
    (( cgroup_max >= cgroup_current )) || fail_boundary registry-cgroup-exhausted
    headroom=$((cgroup_max - cgroup_current))
    if [[ $effective_headroom == unavailable ]] || (( headroom < effective_headroom )); then
      effective_headroom=$headroom
      limiting_cgroup=$group
    fi
    (( headroom >= minimum )) || fail_boundary registry-cgroup-headroom-insufficient
  fi
  group="\${group%/*}"
  [[ -n $group ]] || group=/
  ((depth += 1))
done
[[ $group == / ]] || fail_boundary registry-cgroup-depth-exceeded
[[ $effective_headroom != unavailable ]] || fail_boundary registry-finite-limit-unavailable
registry_nproc_soft=$(awk '$1 == "Max" && $2 == "processes" { print $3; exit }' "/proc/$registry_pid/limits" 2>/dev/null || true)
user_tasks=$(ps -u "$(id -u)" -L --no-headers 2>/dev/null | wc -l | tr -d ' ') || \
  fail_boundary registry-user-tasks-unavailable
host_threads_max=$(cat /proc/sys/kernel/threads-max 2>/dev/null || true)
host_tasks=$(awk '{ split($4, tasks, "/"); print tasks[2] }' /proc/loadavg 2>/dev/null || true)
[[ $user_tasks =~ ^[0-9]+$ &&
   ( $registry_nproc_soft == unlimited || $registry_nproc_soft =~ ^[0-9]+$ ) ]] || \
  fail_boundary registry-nproc-limit-unavailable
if [[ $registry_nproc_soft != unlimited ]]; then
  (( registry_nproc_soft - user_tasks >= minimum )) || \
    fail_boundary registry-nproc-headroom-insufficient
fi
[[ $host_threads_max =~ ^[0-9]+$ && $host_tasks =~ ^[0-9]+$ ]] || \
  fail_boundary host-thread-limit-unavailable
(( host_threads_max - host_tasks >= minimum )) || fail_boundary host-thread-headroom-insufficient
registry_pid_after=$(podman container inspect --format '{{.State.Pid}}' nemoclaw-portable-registry 2>/dev/null || true)
registry_group_after=$(awk -F: '$1 == "0" { print $3; exit }' "/proc/$registry_pid/cgroup" 2>/dev/null || true)
service_pid_after=$(/usr/bin/systemctl --user show "$service" --property=MainPID --value 2>/dev/null || true)
[[ $registry_pid_after == "$registry_pid" && $registry_group_after == "$registry_group" &&
   $service_pid_after == "$service_pid" ]] || fail_boundary process-identity-changed
jq -cn --argjson minimum "$minimum" \
  --arg servicePid "$service_pid" --arg registryPid "$registry_pid" \
  --arg serviceGroup "$service_group" --arg registryGroup "$registry_group" \
  --argjson tasksMax "$tasks_max" --argjson tasksCurrent "$tasks_current" \
  --argjson cgroupMax "$service_cgroup_max" --argjson cgroupCurrent "$service_cgroup_current" \
  --argjson registryCgroups "$registry_cgroups" --argjson effectiveHeadroom "$effective_headroom" \
  --arg limitingCgroup "$limiting_cgroup" --arg registryNprocSoft "$registry_nproc_soft" \
  --argjson userTasks "$user_tasks" --argjson hostThreadsMax "$host_threads_max" \
  --argjson hostTasks "$host_tasks" \
  '{schemaVersion: 2, minimumHeadroom: $minimum,
    service: {pid: $servicePid, cgroup: $serviceGroup, tasksMax: $tasksMax, tasksCurrent: $tasksCurrent,
      cgroupPidsMax: $cgroupMax, cgroupPidsCurrent: $cgroupCurrent},
    registry: {pid: $registryPid, cgroup: $registryGroup},
    registryCgroups: $registryCgroups, effectiveHeadroom: $effectiveHeadroom,
    limitingCgroup: $limitingCgroup, registryNprocSoft: $registryNprocSoft,
    userTasks: $userTasks, hostThreadsMax: $hostThreadsMax, hostTasks: $hostTasks}'
`;

export interface PortableRegistryProcessBoundaryEvidence {
  readonly schemaVersion: 2;
  readonly minimumHeadroom: number;
  readonly service: {
    readonly pid: string;
    readonly cgroup: string;
    readonly tasksMax: number;
    readonly tasksCurrent: number;
    readonly cgroupPidsMax: number;
    readonly cgroupPidsCurrent: number;
  };
  readonly registry: { readonly pid: string; readonly cgroup: string };
  readonly registryCgroups: readonly {
    readonly path: string;
    readonly pidsMax: string;
    readonly pidsCurrent: number;
  }[];
  readonly effectiveHeadroom: number;
  readonly limitingCgroup: string;
  readonly registryNprocSoft: string;
  readonly userTasks: number;
  readonly hostThreadsMax: number;
  readonly hostTasks: number;
}

export async function capturePortableRegistryProcessBoundary(options: {
  readonly artifacts: ArtifactSink;
  readonly shellProbe: ShellProbe;
}): Promise<PortableRegistryProcessBoundaryEvidence> {
  const minimumHeadroomText = process.env[PORTABLE_REGISTRY_MINIMUM_PROCESS_HEADROOM_ENV];
  if (!minimumHeadroomText || !/^[1-9][0-9]*$/u.test(minimumHeadroomText)) {
    throw new Error("Portable registry minimum process headroom must be a positive integer.");
  }
  const minimumHeadroom = Number(minimumHeadroomText);
  if (!Number.isSafeInteger(minimumHeadroom)) {
    throw new Error("Portable registry minimum process headroom must be a safe integer.");
  }
  const env = buildChildEnv(process.env, {
    additionalAllowedEnv: PORTABLE_REGISTRY_DIAGNOSTIC_ENV_KEYS,
    fixtureOverlay: {},
  });
  const result = await options.shellProbe.run(
    trustedShellCommand({
      command: "bash",
      args: ["-e", "-u", "-o", "pipefail", "-c", PROCESS_BOUNDARY_PROBE],
      reason: "verify finite process headroom in the registry's actual cgroup hierarchy",
    }),
    {
      artifactName: "portable-registry-process-boundary-probe",
      captureLimitBytes: 32 * 1024,
      env,
      timeoutMs: 10_000,
    },
  );
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut) {
    const failureReason = /"failureReason":"([a-z-]+)"/u.exec(result.stdout)?.[1] ?? "probe-failed";
    throw new Error(`Portable registry process-boundary verification failed: ${failureReason}.`);
  }
  let evidence: PortableRegistryProcessBoundaryEvidence;
  try {
    evidence = JSON.parse(result.stdout) as PortableRegistryProcessBoundaryEvidence;
  } catch {
    throw new Error("Portable registry process-boundary evidence was not valid JSON.");
  }
  await options.artifacts.writeJson("portable-registry-process-boundary.json", evidence);
  return evidence;
}

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
