// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync, type SpawnSyncReturns } from "node:child_process";

import {
  assertPodmanExecutableAuthority,
  capturePodmanExecutableAuthority,
  type PodmanExecutableAuthority,
  type PodmanExecutableAuthorityDeps,
} from "../podman/executable-authority";
import { resolveOpenshell } from "./resolve";

export const HERMES_PORTABLE_OPENSHELL_VERSION = "0.0.106" as const;
const VERSION_TIMEOUT_MS = 5_000;
const VERSION_MAX_BUFFER_BYTES = 16 * 1024;
const SEMVER_PATTERN = /(?:^|[^0-9.])([0-9]+\.[0-9]+\.[0-9]+)(?![0-9.])/u;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function parseExecutableVersion(value: string, executablePath: string): string | null {
  const executable = executablePath.trim().split(/\s+/u, 1)[0]?.split("/").pop() ?? "";
  if (executable) {
    const executablePattern = new RegExp(`\\b${escapeRegExp(executable)}\\b`, "iu");
    let executableSeen = false;
    for (const line of value.split(/\r?\n/u)) {
      const executableMatch = executablePattern.exec(line);
      if (!executableMatch) continue;
      executableSeen = true;
      const version = line
        .slice(executableMatch.index + executableMatch[0].length)
        .match(SEMVER_PATTERN)?.[1];
      if (version) return version;
    }
    if (executableSeen) return null;
  }
  return value.match(SEMVER_PATTERN)?.[1] ?? null;
}

export interface HermesPortableOpenShellExecutableAuthority {
  readonly executable: PodmanExecutableAuthority;
  readonly version: typeof HERMES_PORTABLE_OPENSHELL_VERSION;
}

type VersionResult = Pick<SpawnSyncReturns<string>, "error" | "status" | "stderr" | "stdout">;

export interface HermesPortableOpenShellExecutableAuthorityDeps extends PodmanExecutableAuthorityDeps {
  readonly resolve?: (env: NodeJS.ProcessEnv) => string | null;
  readonly runVersion?: (executable: string, env: NodeJS.ProcessEnv) => VersionResult;
}

function failExecutableAuthority(message: string): never {
  throw new Error(`Hermes portable OpenShell executable authority ${message}`);
}

function runVersion(executable: string, env: NodeJS.ProcessEnv): VersionResult {
  return spawnSync(executable, ["--version"], {
    encoding: "utf8",
    env,
    maxBuffer: VERSION_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: VERSION_TIMEOUT_MS,
  });
}

function requireVersion(
  executable: string,
  env: NodeJS.ProcessEnv,
  probe: (executable: string, env: NodeJS.ProcessEnv) => VersionResult,
): typeof HERMES_PORTABLE_OPENSHELL_VERSION {
  const result = probe(executable, env);
  if (result.error || result.status !== 0) failExecutableAuthority("version probe failed");
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (parseExecutableVersion(output, executable) !== HERMES_PORTABLE_OPENSHELL_VERSION) {
    failExecutableAuthority(`requires OpenShell ${HERMES_PORTABLE_OPENSHELL_VERSION}`);
  }
  return HERMES_PORTABLE_OPENSHELL_VERSION;
}

function resolveCurrent(
  env: NodeJS.ProcessEnv,
  resolver?: (env: NodeJS.ProcessEnv) => string | null,
): string | null {
  return resolver?.(env) ?? resolveOpenshell({ env });
}

/** Capture the exact schema-5 OpenShell executable before reservation effects. */
export function captureHermesPortableOpenShellExecutableAuthority(
  executablePath: string,
  childEnv: NodeJS.ProcessEnv,
  resolutionEnv: NodeJS.ProcessEnv,
  deps: HermesPortableOpenShellExecutableAuthorityDeps = {},
): HermesPortableOpenShellExecutableAuthority {
  if (resolveCurrent(resolutionEnv, deps.resolve) !== executablePath) {
    failExecutableAuthority("disagrees with the admitted OpenShell resolution");
  }
  let executable: PodmanExecutableAuthority;
  try {
    executable = capturePodmanExecutableAuthority(executablePath, deps);
  } catch {
    failExecutableAuthority("could not capture a safe executable generation");
  }
  return Object.freeze({
    executable,
    version: requireVersion(executablePath, childEnv, deps.runVersion ?? runVersion),
  });
}

/** Revalidate exact schema-5 path, generation, digest, and version before a child. */
export function assertHermesPortableOpenShellExecutableAuthority(
  expected: HermesPortableOpenShellExecutableAuthority,
  childEnv: NodeJS.ProcessEnv,
  resolutionEnv: NodeJS.ProcessEnv,
  deps: HermesPortableOpenShellExecutableAuthorityDeps = {},
): string {
  if (
    expected.version !== HERMES_PORTABLE_OPENSHELL_VERSION ||
    resolveCurrent(resolutionEnv, deps.resolve) !== expected.executable.executablePath
  ) {
    failExecutableAuthority("disagrees with the current OpenShell resolution");
  }
  try {
    assertPodmanExecutableAuthority(expected.executable, deps);
  } catch {
    failExecutableAuthority("executable generation changed after reservation");
  }
  requireVersion(expected.executable.executablePath, childEnv, deps.runVersion ?? runVersion);
  return expected.executable.executablePath;
}

/** Revalidate the retained OpenShell path and executable bytes without another version child. */
export function assertHermesPortableOpenShellExecutableFileAuthority(
  expected: HermesPortableOpenShellExecutableAuthority,
  resolutionEnv: NodeJS.ProcessEnv,
  deps: HermesPortableOpenShellExecutableAuthorityDeps = {},
): string {
  if (
    expected.version !== HERMES_PORTABLE_OPENSHELL_VERSION ||
    resolveCurrent(resolutionEnv, deps.resolve) !== expected.executable.executablePath
  ) {
    failExecutableAuthority("disagrees with the current OpenShell resolution");
  }
  try {
    assertPodmanExecutableAuthority(expected.executable, deps);
  } catch {
    failExecutableAuthority("executable generation changed after reservation");
  }
  return expected.executable.executablePath;
}

export interface OpenShellSubprocessRuntimeAuthority {
  readonly homeDir: string;
  readonly configHome: string;
  readonly runtimeDir: string;
}

function requireMatchingEnvironmentValue(
  source: NodeJS.ProcessEnv,
  name: string,
  expected: string,
): void {
  const actual = source[name];
  if (actual !== undefined && actual !== "" && actual !== expected) {
    throw new Error(
      `Hermes portable OpenShell environment ${name} disagrees with runtime authority`,
    );
  }
}

/** Build the allowlisted environment for a receipt-owned direct OpenShell child. */
export function buildOpenShellSubprocessEnv(
  source: NodeJS.ProcessEnv = process.env,
  authority?: OpenShellSubprocessRuntimeAuthority,
): NodeJS.ProcessEnv {
  const names = new Set([
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "TERM",
    "LANG",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "CURL_CA_BUNDLE",
  ]);
  const environment = Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && (names.has(entry[0]) || entry[0].startsWith("LC_")),
    ),
  );
  if (!authority) return environment;
  requireMatchingEnvironmentValue(source, "HOME", authority.homeDir);
  requireMatchingEnvironmentValue(source, "XDG_CONFIG_HOME", authority.configHome);
  requireMatchingEnvironmentValue(source, "XDG_RUNTIME_DIR", authority.runtimeDir);
  return {
    ...environment,
    HOME: authority.homeDir,
    XDG_CONFIG_HOME: authority.configHome,
    XDG_RUNTIME_DIR: authority.runtimeDir,
  };
}

/** Resolve OpenShell without exiting when it is unavailable. */
export function resolveOpenshellBinaryOrNull(env?: NodeJS.ProcessEnv): string | null {
  return resolveOpenshell(env ? { env } : undefined);
}
