// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import type { ContainerEngineCommandCapture } from "../../adapters/container-engine";
import {
  assertPodmanSocketAuthority,
  capturePodmanSocketAuthority,
  createPodmanContainerEngine,
  hardenPodmanSocketDirectory,
  type PodmanSocketAuthority,
  type PodmanSocketAuthorityDeps,
} from "../../adapters/podman";
import type { CheckpointPortableRuntimeAuthority } from "../../state/onboard-checkpoint-types";
import { parsePortableRuntimeAuthority } from "../../state/onboard/portable-runtime-authority";

export const PORTABLE_PODMAN_STARTUP_TIMEOUT_ENV = "NEMOCLAW_PORTABLE_PODMAN_STARTUP_TIMEOUT_MS";
export const DEFAULT_PORTABLE_PODMAN_STARTUP_TIMEOUT_MS = 60_000;
export const MIN_PORTABLE_PODMAN_STARTUP_TIMEOUT_MS = 15_000;
export const MAX_PORTABLE_PODMAN_STARTUP_TIMEOUT_MS = 300_000;
export const PORTABLE_PODMAN_STEADY_STATE_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const USER_COMMAND_ENV_NAMES = new Set([
  "USER",
  "LOGNAME",
  "SHELL",
  "PATH",
  "TERM",
  "HOSTNAME",
  "LANG",
  "TMPDIR",
  "TMP",
  "TEMP",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
]);

type CommandResult = {
  readonly status: number | null;
  readonly stdout?: string | Buffer | null;
  readonly stderr?: string | Buffer | null;
  readonly error?: Error;
};

export type PortablePodmanReadinessStage =
  | "socket authority"
  | "service activation"
  | "startup API health"
  | "steady-state API health";

export interface PortablePodmanReadinessTiming {
  readonly mode: "cold" | "warm";
  readonly activationMs: number;
  readonly apiMs: number;
  readonly totalMs: number;
}

export type PortablePodmanReadinessRecovery = "portable-onboarding" | "current-user-authority";

export type PortablePodmanReadinessResult =
  | {
      readonly ok: true;
      readonly authority: PodmanSocketAuthority;
      readonly dockerHost: string;
      readonly serverVersion: string;
      readonly timing: PortablePodmanReadinessTiming;
    }
  | {
      readonly ok: false;
      readonly stage: PortablePodmanReadinessStage;
      readonly detail: string;
      readonly socketPath?: string;
      readonly recovery?: PortablePodmanReadinessRecovery;
      readonly timing: PortablePodmanReadinessTiming;
    };

export interface PortablePodmanReadinessDeps {
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => void;
  readonly systemctl?: (
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
  ) => CommandResult;
  readonly podmanCapture?: ContainerEngineCommandCapture;
  readonly socketAuthorityDeps?: PodmanSocketAuthorityDeps;
  readonly hardenSocketDirectory?: (socketPath: string, uid: number) => void;
  readonly captureSocketAuthority?: (
    socketPath: string,
    deps?: PodmanSocketAuthorityDeps,
  ) => PodmanSocketAuthority;
  readonly assertSocketAuthority?: (
    authority: PodmanSocketAuthority,
    deps?: PodmanSocketAuthorityDeps,
  ) => void;
}

function sleep(milliseconds: number): void {
  if (milliseconds > 0) Atomics.wait(SLEEP_BUFFER, 0, 0, milliseconds);
}

function elapsed(now: () => number, startedAt: number): number {
  return Math.max(0, Math.round(now() - startedAt));
}

function timing(
  mode: "cold" | "warm",
  activationMs: number,
  apiMs: number,
  totalMs: number,
): PortablePodmanReadinessTiming {
  return { mode, activationMs, apiMs, totalMs };
}

export function resolvePortablePodmanStartupTimeout(env: NodeJS.ProcessEnv): number {
  const raw = env[PORTABLE_PODMAN_STARTUP_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_PORTABLE_PODMAN_STARTUP_TIMEOUT_MS;
  if (!/^\d+$/u.test(raw.trim())) return DEFAULT_PORTABLE_PODMAN_STARTUP_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) &&
    value >= MIN_PORTABLE_PODMAN_STARTUP_TIMEOUT_MS &&
    value <= MAX_PORTABLE_PODMAN_STARTUP_TIMEOUT_MS
    ? value
    : DEFAULT_PORTABLE_PODMAN_STARTUP_TIMEOUT_MS;
}

export function portablePodmanCommandEnvironment(
  authority: CheckpointPortableRuntimeAuthority,
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && (USER_COMMAND_ENV_NAMES.has(name) || name.startsWith("LC_"))) {
      env[name] = value;
    }
  }
  Object.assign(env, {
    HOME: authority.homeDir,
    XDG_CONFIG_HOME: authority.configHome,
    XDG_RUNTIME_DIR: authority.runtimeDir,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${authority.runtimeDir}/bus`,
  });
  const containersConf = path.join(authority.configHome, "nemoclaw", "portable", "containers.conf");
  if (source.CONTAINERS_CONF === containersConf) env.CONTAINERS_CONF = containersConf;
  if (source.NETAVARK_FW === "iptables") env.NETAVARK_FW = "iptables";
  if (source.GIT_SSL_CAINFO) env.GIT_SSL_CAINFO = source.GIT_SSL_CAINFO;
  if (source.GIT_SSL_CAPATH) env.GIT_SSL_CAPATH = source.GIT_SSL_CAPATH;
  if (source.GIT_CONFIG_NOSYSTEM === "1") {
    env.GIT_CONFIG_NOSYSTEM = "1";
  }
  return env;
}

function failure(
  stage: PortablePodmanReadinessStage,
  detail: string,
  mode: "cold" | "warm",
  activationMs: number,
  apiMs: number,
  totalMs: number,
  socketPath?: string,
  recovery?: PortablePodmanReadinessRecovery,
): PortablePodmanReadinessResult {
  return {
    ok: false,
    stage,
    detail,
    ...(socketPath ? { socketPath } : {}),
    ...(recovery ? { recovery } : {}),
    timing: timing(mode, activationMs, apiMs, totalMs),
  };
}

function parseServerVersion(stdout: string): string | null {
  try {
    const value = JSON.parse(stdout) as { Server?: { Version?: unknown } };
    const version = value.Server?.Version;
    return typeof version === "string" && version.trim() !== "" ? version.trim() : null;
  } catch {
    return null;
  }
}

function isMissingSocket(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function sameDirectoryAuthority(
  expected: PodmanSocketAuthority,
  actual: PodmanSocketAuthority,
): boolean {
  return (
    actual.directoryChain.length === expected.directoryChain.length &&
    actual.directoryChain.every((component, index) => {
      const pinned = expected.directoryChain[index];
      return (
        pinned !== undefined &&
        component.device === pinned.device &&
        component.inode === pinned.inode &&
        component.mode === pinned.mode &&
        component.ownerUid === pinned.ownerUid &&
        component.path === pinned.path
      );
    })
  );
}

function recaptureColdActivationSocket(
  expected: PodmanSocketAuthority,
  socketPath: string,
  authorityDeps: PodmanSocketAuthorityDeps,
  capture: (socketPath: string, deps?: PodmanSocketAuthorityDeps) => PodmanSocketAuthority,
  assert: (authority: PodmanSocketAuthority, deps?: PodmanSocketAuthorityDeps) => void,
): PodmanSocketAuthority | null {
  try {
    assert(expected, authorityDeps);
    return null;
  } catch {
    // A cold systemd activation can replace only the socket inode after the
    // first successful connection. Re-capture the same secured path and keep
    // every other authority field pinned before retrying the API probe.
  }
  try {
    const replacement = capture(socketPath, authorityDeps);
    return replacement.socketPath === expected.socketPath &&
      replacement.device === expected.device &&
      replacement.inode !== expected.inode &&
      replacement.mode === expected.mode &&
      replacement.ownerUid === expected.ownerUid &&
      sameDirectoryAuthority(expected, replacement)
      ? replacement
      : null;
  } catch {
    return null;
  }
}

function probePodmanServerVersion(
  socketAuthority: PodmanSocketAuthority,
  timeoutMs: number,
  authorityDeps: PodmanSocketAuthorityDeps,
  assertAuthority: NonNullable<PortablePodmanReadinessDeps["assertSocketAuthority"]>,
  podmanCapture?: ContainerEngineCommandCapture,
): string | null {
  const provider = createPodmanContainerEngine({
    operation: "host-doctor",
    socketAuthority,
    authorityDeps,
    assertAuthority,
    ...(podmanCapture ? { capture: podmanCapture } : {}),
  });
  const result = provider.capture(["version", "--format", "json"], timeoutMs);
  return result.status === 0 ? parseServerVersion(result.stdout) : null;
}

/**
 * Verify one receipt-owned rootless Podman API. Cold activation and warm health
 * use separate budgets; no process-global engine selector participates.
 */
export function inspectPortablePodmanReadiness(
  recordedAuthority: CheckpointPortableRuntimeAuthority,
  deps: PortablePodmanReadinessDeps = {},
): PortablePodmanReadinessResult {
  const startedAt = (deps.now ?? Date.now)();
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const uid = deps.uid ?? process.geteuid?.() ?? process.getuid?.();
  const home = deps.home ?? os.userInfo().homedir;
  const normalized = parsePortableRuntimeAuthority(recordedAuthority);
  if (
    (deps.platform ?? process.platform) !== "linux" ||
    !normalized ||
    !Number.isSafeInteger(uid) ||
    normalized.uid !== uid ||
    normalized.homeDir !== home
  ) {
    return failure(
      "socket authority",
      "The recorded portable Podman authority does not match the current Linux user.",
      "warm",
      0,
      0,
      elapsed(now, startedAt),
      undefined,
      "current-user-authority",
    );
  }

  const commandEnv = portablePodmanCommandEnvironment(normalized, env);
  const startupTimeoutMs = resolvePortablePodmanStartupTimeout(env);
  const systemctl =
    deps.systemctl ??
    ((args, childEnv, timeoutMs) =>
      spawnSync("systemctl", [...args], {
        encoding: "utf-8",
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
      }));
  const capture = deps.captureSocketAuthority ?? capturePodmanSocketAuthority;
  const assert = deps.assertSocketAuthority ?? assertPodmanSocketAuthority;
  const authorityDeps = { ...deps.socketAuthorityDeps, uid: normalized.uid };
  let socketSeen = false;
  let socketHardened = false;
  let socketAuthority: PodmanSocketAuthority | null = null;
  let coldActivationSocketRecaptured = false;
  const active = systemctl(
    ["--user", "is-active", "--quiet", "podman.service"],
    commandEnv,
    PORTABLE_PODMAN_STEADY_STATE_TIMEOUT_MS,
  );
  const serviceActive = active.status === 0 && !active.error;
  if (!serviceActive) {
    try {
      (deps.hardenSocketDirectory ?? hardenPodmanSocketDirectory)(
        normalized.socketPath,
        normalized.uid,
      );
      socketHardened = true;
      socketAuthority = capture(normalized.socketPath, authorityDeps);
      if (socketAuthority.socketPath !== normalized.socketPath) {
        throw new Error("The captured Podman socket does not match the recorded endpoint.");
      }
      socketSeen = true;
    } catch (error) {
      if (!isMissingSocket(error)) {
        return failure(
          "socket authority",
          "The recorded portable Podman socket is absent, unsafe, or no longer has its recorded authority.",
          "cold",
          0,
          0,
          elapsed(now, startedAt),
          normalized.socketPath,
        );
      }
      socketAuthority = null;
    }
    if (socketAuthority) {
      const apiStartedAt = now();
      let serverVersion: string | null;
      try {
        serverVersion = probePodmanServerVersion(
          socketAuthority,
          PORTABLE_PODMAN_STEADY_STATE_TIMEOUT_MS,
          authorityDeps,
          assert,
          deps.podmanCapture,
        );
      } catch {
        return failure(
          "socket authority",
          "The recorded portable Podman socket changed while its API was being verified.",
          "cold",
          0,
          elapsed(now, apiStartedAt),
          elapsed(now, startedAt),
          normalized.socketPath,
        );
      }
      if (serverVersion) {
        return {
          ok: true,
          authority: socketAuthority,
          dockerHost: `unix://${normalized.socketPath}`,
          serverVersion,
          timing: timing("warm", 0, elapsed(now, apiStartedAt), elapsed(now, startedAt)),
        };
      }
    }
  }
  const mode = serviceActive ? "warm" : "cold";
  const deadlineMs = mode === "warm" ? PORTABLE_PODMAN_STEADY_STATE_TIMEOUT_MS : startupTimeoutMs;
  const activationStartedAt = now();
  if (mode === "cold") {
    const activated = systemctl(
      ["--user", "start", "podman.socket"],
      commandEnv,
      Math.max(1, deadlineMs - elapsed(now, startedAt)),
    );
    if (activated.status !== 0 || activated.error) {
      return failure(
        "service activation",
        "The current user's Podman socket service could not be activated.",
        mode,
        elapsed(now, activationStartedAt),
        0,
        elapsed(now, startedAt),
        normalized.socketPath,
      );
    }
  }
  const activationMs = elapsed(now, activationStartedAt);
  const apiStartedAt = now();
  const budgetStartedAt = mode === "warm" ? apiStartedAt : startedAt;

  while (elapsed(now, budgetStartedAt) < deadlineMs) {
    if (!socketAuthority) {
      try {
        if (!socketHardened) {
          (deps.hardenSocketDirectory ?? hardenPodmanSocketDirectory)(
            normalized.socketPath,
            normalized.uid,
          );
          socketHardened = true;
        }
        socketAuthority = capture(normalized.socketPath, authorityDeps);
        if (socketAuthority.socketPath !== normalized.socketPath) {
          throw new Error("The captured Podman socket does not match the recorded endpoint.");
        }
        socketSeen = true;
      } catch (error) {
        if (mode === "cold" && isMissingSocket(error)) {
          (deps.sleep ?? sleep)(
            Math.min(POLL_INTERVAL_MS, Math.max(0, deadlineMs - elapsed(now, startedAt))),
          );
          continue;
        }
        return failure(
          "socket authority",
          "The recorded portable Podman socket is absent, unsafe, or no longer has its recorded authority.",
          mode,
          activationMs,
          elapsed(now, apiStartedAt),
          elapsed(now, startedAt),
          normalized.socketPath,
        );
      }
    }

    const remainingMs = Math.max(1, deadlineMs - elapsed(now, budgetStartedAt));
    try {
      const serverVersion = probePodmanServerVersion(
        socketAuthority,
        remainingMs,
        authorityDeps,
        assert,
        deps.podmanCapture,
      );
      if (serverVersion) {
        return {
          ok: true,
          authority: socketAuthority,
          dockerHost: `unix://${normalized.socketPath}`,
          serverVersion,
          timing: timing(mode, activationMs, elapsed(now, apiStartedAt), elapsed(now, startedAt)),
        };
      }
    } catch {
      const replacement =
        mode === "cold" && !coldActivationSocketRecaptured
          ? recaptureColdActivationSocket(
              socketAuthority,
              normalized.socketPath,
              authorityDeps,
              capture,
              assert,
            )
          : null;
      if (replacement) {
        socketAuthority = replacement;
        coldActivationSocketRecaptured = true;
        continue;
      }
      return failure(
        "socket authority",
        "The recorded portable Podman socket changed while its API was being verified.",
        mode,
        activationMs,
        elapsed(now, apiStartedAt),
        elapsed(now, startedAt),
        normalized.socketPath,
      );
    }
    if (mode === "warm") break;
    (deps.sleep ?? sleep)(
      Math.min(POLL_INTERVAL_MS, Math.max(0, deadlineMs - elapsed(now, startedAt))),
    );
  }

  const stage = mode === "warm" ? "steady-state API health" : "startup API health";
  return failure(
    socketSeen ? stage : "service activation",
    socketSeen
      ? mode === "warm"
        ? "The recorded portable Podman API did not return a server version within 10000 ms."
        : `The activated portable Podman API did not return a server version within ${String(startupTimeoutMs)} ms.`
      : `The activated portable Podman service did not create its recorded socket within ${String(startupTimeoutMs)} ms.`,
    mode,
    activationMs,
    elapsed(now, apiStartedAt),
    elapsed(now, startedAt),
    normalized.socketPath,
  );
}

export function portablePodmanReadinessError(
  result: Extract<PortablePodmanReadinessResult, { ok: false }>,
): Error {
  const socket = result.socketPath ? ` Recorded socket: ${result.socketPath}.` : "";
  return new Error(
    `Portable Podman readiness failed at ${result.stage}: ${result.detail}${socket}`,
  );
}
