// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerSpawnSync } from "../../adapters/docker/exec";
import { resolveSandboxContainerOwner } from "../../domain/sandbox/container-owner";
import { findLabeledSandboxContainers } from "../../onboard/docker-driver-sandbox-recovery";
import {
  registeredRuntimeProviderSupportsContainerEngineOperation,
  resolveRegisteredRuntimeProvider,
} from "../../onboard/runtime-provider/selection";
import { load as loadRegistry } from "../../state/registry/persistence";

/**
 * The sandbox's own memory cgroup records `oom_kill` when the kernel kills a
 * process inside it while the container supervisor survives — the case that
 * leaves `nemoclaw status` reporting Ready over a degraded sandbox (#5796).
 *
 * The counter must be read from the host. Running this script through the
 * sandbox exec transport puts it under the sandbox policy, which denies
 * `/sys/fs/cgroup`, so a real OOM was indistinguishable from "the probe could
 * not run" and status never escalated. A host-side `docker exec` enters the
 * container's cgroup namespace without inheriting that policy, so
 * `/sys/fs/cgroup/memory.events` resolves to the sandbox's own counters.
 */
const CGROUP_OOM_PROBE_SCRIPT = [
  "probe_cgroup_file() {",
  '  file="$1"',
  '  key="$2"',
  '  if [ ! -r "$file" ]; then',
  "    return 1",
  "  fi",
  "  while IFS=' ' read -r current value _rest; do",
  '    if [ "$current" = "$key" ]; then',
  '      case "$value" in ""|*[!0-9]*) exit 3 ;; esac',
  '      printf "oom_kill=%s\\nsource=%s\\n" "$value" "$file"',
  "      exit 0",
  "    fi",
  '  done < "$file"',
  "  exit 3",
  "}",
  "for f in /sys/fs/cgroup/memory.events.local /sys/fs/cgroup/memory.events; do",
  '  probe_cgroup_file "$f" oom_kill',
  "done",
  "for f in /sys/fs/cgroup/memory.oom_control /sys/fs/cgroup/memory/memory.oom_control; do",
  '  probe_cgroup_file "$f" oom_kill',
  "done",
  "exit 2",
].join("\n");

export type TerminalRuntimeOomProbeResult =
  | { kind: "ok"; oomKillCount: 0; source?: string }
  | { kind: "degraded"; oomKillCount: number; source?: string }
  | { kind: "unavailable"; detail?: string };

export type TerminalRuntimeOomProbeRunner = (args: readonly string[]) => {
  status: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  error?: Error;
};

export function parseTerminalRuntimeOomProbeOutput(
  stdout: string | Buffer | undefined,
): TerminalRuntimeOomProbeResult {
  const text = Buffer.isBuffer(stdout) ? stdout.toString("utf8") : (stdout ?? "");
  const countMatch = text.match(/^oom_kill=([^\n]+)$/m);
  if (!countMatch) return { kind: "unavailable", detail: "missing oom_kill counter" };
  if (!/^\d+$/.test(countMatch[1])) {
    return { kind: "unavailable", detail: "invalid oom_kill counter" };
  }
  const oomKillCount = Number(countMatch[1]);
  const source = text.match(/^source=(.+)$/m)?.[1];
  if (!Number.isFinite(oomKillCount)) {
    return { kind: "unavailable", detail: "invalid oom_kill counter" };
  }
  if (oomKillCount > 0) return { kind: "degraded", oomKillCount, source };
  return { kind: "ok", oomKillCount: 0, source };
}

const PROBE_TIMEOUT_MS = 5_000;

export interface TerminalRuntimeOomProbeDeps {
  getSandboxDriver: (name: string) => string | null | undefined;
  listLabeledContainerNames: (name: string) => string[];
  listSandboxNames: () => string[] | undefined;
  run: TerminalRuntimeOomProbeRunner;
}

/** Registry read failure is unknown, not "not docker", so the probe reports
 * unavailable instead of silently concluding the sandbox has no counter. */
function readSandboxDriver(name: string): string | null | undefined {
  try {
    return loadRegistry().sandboxes[name]?.openshellDriver;
  } catch {
    return undefined;
  }
}

function readSandboxNames(): string[] | undefined {
  try {
    return Object.values(loadRegistry().sandboxes).map((entry) => entry.name);
  } catch {
    return undefined;
  }
}

const defaultDeps: TerminalRuntimeOomProbeDeps = {
  getSandboxDriver: readSandboxDriver,
  listLabeledContainerNames: (name) =>
    findLabeledSandboxContainers(name).map((container) => container.name),
  listSandboxNames: readSandboxNames,
  run: (args) =>
    dockerSpawnSync(args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: PROBE_TIMEOUT_MS,
    }),
};

function hasLegacyContainerHealthProbe(driverName: string | null | undefined): boolean {
  const normalized = driverName?.trim().toLowerCase();
  if (!normalized) return false;
  const provider = resolveRegisteredRuntimeProvider(normalized);
  if (
    !provider ||
    provider.identity.id !== normalized ||
    !registeredRuntimeProviderSupportsContainerEngineOperation(normalized, "gateway-inspection")
  ) {
    return false;
  }
  try {
    return (
      provider.gateway.prepareHostRuntime({
        environment: process.env,
        platform: process.platform,
      }).socketPath === null
    );
  } catch {
    return false;
  }
}

export function probeTerminalRuntimeCgroupOom(
  sandboxName: string,
  depsOverride: Partial<TerminalRuntimeOomProbeDeps> = {},
): TerminalRuntimeOomProbeResult {
  const deps: TerminalRuntimeOomProbeDeps = { ...defaultDeps, ...depsOverride };
  if (!hasLegacyContainerHealthProbe(deps.getSandboxDriver(sandboxName))) {
    return { kind: "unavailable", detail: "cgroup OOM probe requires the docker driver" };
  }
  // Reading the wrong container's counter would report a degraded sandbox that
  // is healthy, so ambiguous ownership stays unavailable rather than guessing.
  const labeledContainerNames = deps.listLabeledContainerNames(sandboxName);
  if (labeledContainerNames.length !== 1) {
    return {
      kind: "unavailable",
      detail:
        labeledContainerNames.length === 0
          ? "no labeled container found for sandbox"
          : "ambiguous sandbox container ownership",
    };
  }
  const sandboxNames = deps.listSandboxNames();
  if (!sandboxNames) {
    return { kind: "unavailable", detail: "sandbox ownership registry unavailable" };
  }
  const containerName = resolveSandboxContainerOwner(
    labeledContainerNames[0] ?? "",
    sandboxName,
    sandboxNames,
  );
  if (!containerName) return { kind: "unavailable", detail: "sandbox container owner unresolved" };

  const result = deps.run(["exec", containerName, "sh", "-lc", CGROUP_OOM_PROBE_SCRIPT]);
  if (result.error) return { kind: "unavailable", detail: result.error.message };
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8")
      : (result.stderr ?? "");
    return { kind: "unavailable", detail: stderr.trim() || `exit ${String(result.status)}` };
  }
  return parseTerminalRuntimeOomProbeOutput(result.stdout);
}
