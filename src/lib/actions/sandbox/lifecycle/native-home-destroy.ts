// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import type { OpenShellRuntimeSelection } from "../../../adapters/openshell/runtime-selection";
import {
  createSdkOpenShellSandboxStateLifecycle,
  type OpenShellSandboxStateLifecycle,
} from "../../../adapters/openshell/sandbox-lifecycle-sdk";
import { resolveRegisteredAgentDefinition } from "../../../agent/runtime";
import type { ManagedImageAgent } from "../../../onboard/managed-image/agents";
import type {
  RuntimeProviderPrivilegedSandboxCommandResult,
  RuntimeProviderStoppedSandboxStateCleanupResult,
} from "../../../onboard/runtime-provider/contract";
import type { SandboxEntry } from "../../../state/registry";
import { type DestroyRunOpenshell, SANDBOX_DESTROY_TIMEOUT_MS } from "../destroy-gateway";

const SANDBOX_NATIVE_ROOT = "/sandbox";
const COMPLETE_NATIVE_HOME_AGENTS = new Set<string>([
  "hermes",
  "langchain-deepagents-code",
  "openclaw",
] satisfies ManagedImageAgent[]);

export function isCompleteNativeHomeAgent(agentName: string): agentName is ManagedImageAgent {
  return COMPLETE_NATIVE_HOME_AGENTS.has(agentName);
}

function requireNormalizedNativeRoot(agentName: string, configuredRoot: string): string {
  const normalized = path.posix.normalize(configuredRoot);
  if (
    normalized !== configuredRoot ||
    !path.posix.isAbsolute(configuredRoot) ||
    !normalized.startsWith(`${SANDBOX_NATIVE_ROOT}/`) ||
    !/^\/sandbox\/[A-Za-z0-9._/-]+$/u.test(normalized)
  ) {
    throw new Error(
      `Agent '${agentName}' has an unsafe native-home root; registry or manifest repair is required.`,
    );
  }
  return normalized;
}

function requireProtectedNativePath(relativePath: string, agentName: string): string {
  const normalized = path.posix.normalize(relativePath);
  if (
    normalized !== relativePath ||
    path.posix.isAbsolute(relativePath) ||
    normalized === "." ||
    normalized.startsWith("../")
  ) {
    throw new Error(
      `Agent '${agentName}' has an unsafe user-managed path; registry or manifest repair is required.`,
    );
  }
  return `${SANDBOX_NATIVE_ROOT}/${normalized}`;
}

function protectedNativeHomeEntries(
  agentName: string,
  nativeRoot: string,
  userManagedFiles: readonly string[],
  hostMounts: SandboxEntry["hostMounts"],
): string[] {
  const protectedEntries = new Set<string>();
  for (const relativePath of userManagedFiles) {
    const managedPath = requireProtectedNativePath(relativePath, agentName);
    if (managedPath === nativeRoot || managedPath.startsWith(`${nativeRoot}/`)) {
      protectedEntries.add(managedPath);
    }
  }
  if (agentName === "langchain-deepagents-code") {
    for (const mount of hostMounts ?? []) {
      if (typeof mount.target !== "string") {
        throw new Error("Deep Agents host-mount target is invalid; registry repair is required.");
      }
      const normalized = path.posix.normalize(mount.target);
      const prefix = `${SANDBOX_NATIVE_ROOT}/`;
      if (normalized !== mount.target || !normalized.startsWith(prefix)) {
        throw new Error("Deep Agents host-mount target is invalid; registry repair is required.");
      }
      protectedEntries.add(normalized);
    }
  }
  return [...protectedEntries].sort();
}

class NativeHomeRetainedStateError extends Error {}

export async function wipeNativeHomeWithRecovery(options: {
  wipe: () => void;
  agentName: string;
  sandboxName: string;
  gatewayName: string;
  liveIdentityFingerprint: string | undefined;
  runtimeProviderId: string | undefined;
  runtimeSelection: OpenShellRuntimeSelection | undefined;
  lifecycle: OpenShellSandboxStateLifecycle | undefined;
  identityMatches: () => boolean;
  lifecycleEnvironment: () => NodeJS.ProcessEnv;
}): Promise<void> {
  try {
    options.wipe();
  } catch (error) {
    if (
      !(error instanceof NativeHomeRetainedStateError) ||
      options.agentName !== "openclaw" ||
      !options.liveIdentityFingerprint ||
      (options.runtimeSelection?.workspace ?? process.env.OPENSHELL_WORKSPACE ?? "default") !==
        "default" ||
      (options.runtimeProviderId !== "docker" && options.runtimeProviderId !== "podman")
    ) {
      throw error;
    }
    // Preserve the ordinary Error/stopped cleanup path. Only quiesce after
    // failed deletion verification and an independent running-container proof.
    // The lifecycle SDK operates in the default workspace; do not widen it.
    const lifecycle =
      options.lifecycle ??
      createSdkOpenShellSandboxStateLifecycle({
        env: options.lifecycleEnvironment(),
      });
    const stopped = await lifecycle.stopSandbox({
      sandboxName: options.sandboxName,
      sandboxIdentityFingerprint: options.liveIdentityFingerprint,
      target: { kind: "named", gatewayName: options.gatewayName },
      timeoutMs: SANDBOX_DESTROY_TIMEOUT_MS,
    });
    if (stopped.kind === "failed") {
      throw new Error(`Could not stop OpenClaw native-home writers: ${stopped.error.message}`, {
        cause: error,
      });
    }
    if (!options.identityMatches()) {
      throw new Error(
        "Sandbox identity changed or could not be confirmed after stopping native-home writers.",
      );
    }
    options.wipe();
  }
}

export function wipeOwnedAgentNativeHome(
  redactError: (error: unknown) => string,
  sandboxName: string,
  agentName: string,
  runOpenshell: DestroyRunOpenshell,
  hostMounts: SandboxEntry["hostMounts"],
  runPrivileged?: (command: readonly string[]) => RuntimeProviderPrivilegedSandboxCommandResult,
  clearStoppedNativeHome?: (
    root: string,
    protectedPaths: readonly string[],
  ) => RuntimeProviderStoppedSandboxStateCleanupResult,
  runAsSandboxUser?: (command: readonly string[]) => RuntimeProviderPrivilegedSandboxCommandResult,
): void {
  if (!isCompleteNativeHomeAgent(agentName)) return;
  const agent = resolveRegisteredAgentDefinition({ agent: agentName });
  if (!agent) {
    throw new Error(
      `Agent '${agentName}' could not be resolved for native-home cleanup; registry or manifest repair is required.`,
    );
  }
  const nativeRoot =
    agentName === "langchain-deepagents-code"
      ? SANDBOX_NATIVE_ROOT
      : requireNormalizedNativeRoot(agentName, agent.configPaths.dir);
  const protectedEntries = protectedNativeHomeEntries(
    agentName,
    nativeRoot,
    agent.userManagedFiles,
    hostMounts,
  );
  const script = [
    "set -eu",
    `root='${nativeRoot}'`,
    'if [ ! -e "$root" ]; then exit 0; fi',
    'if [ ! -d "$root" ] || [ -L "$root" ]; then echo "unsafe agent native root" >&2; exit 20; fi',
    "is_exact_keep() {",
    '  candidate="$1"; shift',
    '  for keep in "$@"; do [ "$candidate" != "$keep" ] || return 0; done',
    "  return 1",
    "}",
    "is_keep_parent() {",
    '  candidate="$1"; shift',
    '  for keep in "$@"; do [ "${keep#"$candidate"/}" = "$keep" ] || return 0; done',
    "  return 1",
    "}",
    "clean_dir() {",
    "  local directory entry",
    '  directory="$1"; shift',
    '  for entry in "$directory"/.[!.]* "$directory"/..?* "$directory"/*; do',
    '    if [ ! -e "$entry" ] && [ ! -L "$entry" ]; then continue; fi',
    '    if is_exact_keep "$entry" "$@"; then continue; fi',
    '    if is_keep_parent "$entry" "$@"; then',
    '      if [ ! -d "$entry" ] || [ -L "$entry" ]; then',
    '        echo "unsafe protected native-home ancestor" >&2',
    "        exit 21",
    "      fi",
    '      clean_dir "$entry" "$@"',
    "    else",
    '      rm -rf -- "$entry"',
    "    fi",
    "  done",
    "}",
    "verify_dir() {",
    "  local directory entry",
    '  directory="$1"; shift',
    '  for entry in "$directory"/.[!.]* "$directory"/..?* "$directory"/*; do',
    '    if [ ! -e "$entry" ] && [ ! -L "$entry" ]; then continue; fi',
    '    if is_exact_keep "$entry" "$@"; then continue; fi',
    '    if is_keep_parent "$entry" "$@"; then',
    '      if [ ! -d "$entry" ] || [ -L "$entry" ]; then return 1; fi',
    '      verify_dir "$entry" "$@" || return 1',
    "    else",
    "      return 1",
    "    fi",
    "  done",
    "}",
    'clean_dir "$root" "$@"',
    'if ! verify_dir "$root" "$@"; then',
    '  echo "agent native root retains sandbox-owned state" >&2',
    "  exit 22",
    "fi",
  ].join("\n");
  const command = ["sh", "-c", script, "nemoclaw-native-home-cleanup", ...protectedEntries];
  let result: {
    readonly status: number | null;
    readonly stdout?: string | Buffer;
    readonly stderr?: string | Buffer;
    readonly error?: Error;
  } = runOpenshell(["sandbox", "exec", "--name", sandboxName, "--", ...command], {
    ignoreError: true,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: SANDBOX_DESTROY_TIMEOUT_MS,
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    throw new Error(
      `${agent.displayName} native-home cleanup timed out after ${String(SANDBOX_DESTROY_TIMEOUT_MS / 1000)} seconds; its result is unknown.`,
    );
  }
  if (result.status !== 0 && result.status !== 20 && result.status !== 21 && runPrivileged) {
    try {
      result = runPrivileged(command);
    } catch (error) {
      const stoppedCleanup = clearStoppedNativeHome?.(nativeRoot, protectedEntries);
      if (stoppedCleanup?.cleared) return;
      if (stoppedCleanup) {
        throw new Error(
          `Stopped native-home cleanup failed (${stoppedCleanup.failure}). ${redactError(error)}`,
          { cause: error },
        );
      }
      throw error;
    }
    // Rootless Podman root may lack permission to remove sandbox-user state,
    // including agent SQLite files. Finish the validated wipe as the image's
    // pinned sandbox user before attempting stopped-volume cleanup.
    if (
      isCompleteNativeHomeAgent(agentName) &&
      result.status === 1 &&
      !result.error &&
      runAsSandboxUser
    ) {
      result = runAsSandboxUser(command);
      if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
        throw new Error(
          `${agent.displayName} native-home cleanup timed out after ${String(SANDBOX_DESTROY_TIMEOUT_MS / 1000)} seconds; its result is unknown.`,
        );
      }
    }
  }
  let retainedStateWhileRunning = false;
  if (
    result.status !== 0 &&
    result.status !== 20 &&
    result.status !== 21 &&
    clearStoppedNativeHome
  ) {
    const stoppedCleanup = clearStoppedNativeHome(nativeRoot, protectedEntries);
    if (stoppedCleanup.cleared) return;
    retainedStateWhileRunning =
      result.status === 22 && stoppedCleanup.failure === "runtime-not-stopped";
    result = {
      ...result,
      stderr: `Stopped native-home cleanup failed (${stoppedCleanup.failure}). ${String(result.stderr ?? "")}`,
    };
  }
  if (result.status !== 0 || result.error) {
    const detail = `${String(result.stderr ?? "")}\n${String(result.stdout ?? "")}`
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 500);
    const message = `Could not remove the sandbox-owned ${agent.displayName} native home before sandbox deletion${detail ? `: ${detail}` : "."}`;
    // Exit 22 is the fixed cleanup script's failed verification after deletion.
    // Keep permission, unsafe-path and transport failures out of this recovery.
    if (retainedStateWhileRunning && !result.error) throw new NativeHomeRetainedStateError(message);
    throw new Error(message);
  }
}
