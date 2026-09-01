// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DOCKER_DESKTOP_CREDENTIAL_STORE_NAMES } from "../../domain/docker-host";
import { isWsl } from "../../platform";
import { buildSubprocessEnv } from "../../subprocess-env";
import {
  dockerDesktopCredentialHelperResponds,
  readDockerCredentialStore,
} from "./credential-store";
import { dockerSpawnSync } from "./exec";

const DOCKER_ENV_NAMES = [
  "CONTAINERS_CONF",
  "DOCKER_API_VERSION",
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
] as const;

export interface DockerBuildEnvironmentInput {
  env?: NodeJS.ProcessEnv;
  credentialHelperResponds?: (credsStore: string) => boolean;
  dockerContextIsDefault?: (env: NodeJS.ProcessEnv) => boolean;
  isWslHost?: boolean;
  allowCredentialIsolation?: boolean;
}

export interface PreparedDockerBuildEnvironment {
  env: NodeJS.ProcessEnv;
  isolatedCredentialConfig: boolean;
  cleanup(): DockerBuildEnvironmentCleanupResult;
}

export type DockerBuildEnvironmentCleanupResult =
  | { ok: true }
  | { ok: false; directory: string; error: string };

export function createCredentialFreeDockerConfig(purpose: "portable" | "wsl-buildkit"): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-${purpose}-docker-config-`));
  fs.chmodSync(directory, 0o700);
  fs.writeFileSync(path.join(directory, "config.json"), '{"auths":{}}\n', {
    encoding: "utf-8",
    flag: "wx",
    mode: 0o600,
  });
  return directory;
}

/** Restrict the host Docker build to environment values used by Docker itself. */
export function dockerBuildSubprocessEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env = buildSubprocessEnv();
  for (const key of DOCKER_ENV_NAMES) {
    const value = sourceEnv[key];
    // sourceEnv owns Docker daemon and client selection. Do not let a Docker
    // variable omitted by the caller leak back in from the parent process.
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  for (const key of Object.keys(env)) {
    if (
      key === "KUBECONFIG" ||
      key === "SSH_AUTH_SOCK" ||
      key === "RUST_LOG" ||
      key === "RUST_BACKTRACE" ||
      key.startsWith("OPENSHELL_") ||
      key.startsWith("GRPC_")
    ) {
      delete env[key];
    }
  }
  // Match the runner and Docker probe contract: an explicitly selected host
  // owns daemon authority, so an ambient context must not redirect the build.
  // Keep DOCKER_CONFIG because the selected daemon can still require registry
  // credentials or client certificates from that configuration.
  if (env.DOCKER_HOST !== undefined) {
    delete env.DOCKER_CONTEXT;
  }
  return env;
}

function requiresCredentialFreeWslBuildConfig(
  env: NodeJS.ProcessEnv,
  helperResponds: (credsStore: string) => boolean,
  isWslHost?: boolean,
): boolean {
  if (!isWsl({ env, isWsl: isWslHost })) return false;
  const { credsStore } = readDockerCredentialStore(env, fs.readFileSync);
  return (
    credsStore !== undefined &&
    DOCKER_DESKTOP_CREDENTIAL_STORE_NAMES.has(credsStore) &&
    !helperResponds(credsStore)
  );
}

function dockerDesktopCredentialHelperRespondsFromBuild(
  credsStore: string,
  env: NodeJS.ProcessEnv,
): boolean {
  return dockerDesktopCredentialHelperResponds(credsStore, (command, options) => {
    const [executable, ...args] = command;
    if (!executable) return null;
    const result = spawnSync(executable, args, {
      encoding: "utf-8",
      env: dockerBuildSubprocessEnv(env),
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: options?.timeout,
    });
    return result.error || result.status !== 0 ? null : result.stdout;
  });
}

export function dockerContextIsDefaultFromBuild(
  env: NodeJS.ProcessEnv,
  showContext: (env: NodeJS.ProcessEnv) => string | null = (sourceEnv) => {
    const result = dockerSpawnSync(["context", "show"], {
      encoding: "utf-8",
      env: dockerBuildSubprocessEnv(sourceEnv),
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    return result.error || result.status !== 0 ? null : String(result.stdout).trim();
  },
): boolean {
  // Any explicit endpoint owns daemon authority, including alternate Unix
  // sockets. Preserve its client configuration and registry credentials.
  if (env.DOCKER_HOST) return false;
  return showContext(env) === "default";
}

/**
 * Prepare the Docker environment shared by normal creation and rebuild image
 * preflight. Docker Desktop can leave WSL pointing at a Windows credential
 * helper that is unavailable from the current session; generated image builds
 * do not need registry credentials, so isolate that case without modifying the
 * user's Docker config.
 */
export function prepareDockerBuildEnvironment(
  input: DockerBuildEnvironmentInput = {},
): PreparedDockerBuildEnvironment {
  const sourceEnv = input.env ?? process.env;
  const helperResponds =
    input.credentialHelperResponds ??
    ((credsStore: string) => dockerDesktopCredentialHelperRespondsFromBuild(credsStore, sourceEnv));
  const contextIsDefault = input.dockerContextIsDefault ?? dockerContextIsDefaultFromBuild;
  const credentialFreeConfig =
    input.allowCredentialIsolation !== false &&
    contextIsDefault(sourceEnv) &&
    requiresCredentialFreeWslBuildConfig(sourceEnv, helperResponds, input.isWslHost)
      ? createCredentialFreeDockerConfig("wsl-buildkit")
      : null;
  return {
    env: {
      ...dockerBuildSubprocessEnv(sourceEnv),
      DOCKER_BUILDKIT: "1",
      ...(credentialFreeConfig ? { DOCKER_CONFIG: credentialFreeConfig } : {}),
    },
    isolatedCredentialConfig: credentialFreeConfig !== null,
    cleanup: () => {
      if (credentialFreeConfig === null) return { ok: true };
      try {
        fs.rmSync(credentialFreeConfig, { recursive: true, force: true });
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          directory: credentialFreeConfig,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

function boundedCleanupDiagnostic(value: string): string {
  return value.replace(/[^\x20-\x7E]/gu, "?").slice(0, 240);
}

/** Warn without replacing the Docker operation result when temporary cleanup fails. */
export function warnIfDockerBuildEnvironmentCleanupFailed(
  result: DockerBuildEnvironmentCleanupResult,
  operation: string,
  warn: (message: string) => void = console.warn,
): void {
  if (result.ok) return;
  const directory = boundedCleanupDiagnostic(result.directory);
  const operationLabel = boundedCleanupDiagnostic(operation);
  const detail = boundedCleanupDiagnostic(result.error);
  try {
    warn(
      `  Warning: failed to remove credential-free Docker config '${directory}' after ${operationLabel}: ${detail}. It contains no credentials and can be removed after Docker no longer uses it.`,
    );
  } catch {
    // Cleanup diagnostics must never replace the Docker operation result.
  }
}

/** Overlay a credential-free Docker client config onto a host subprocess env. */
export function mergeIsolatedDockerClientEnv(
  targetEnv: NodeJS.ProcessEnv,
  prepared: PreparedDockerBuildEnvironment,
): NodeJS.ProcessEnv {
  const isolatedConfig = prepared.isolatedCredentialConfig ? prepared.env.DOCKER_CONFIG : undefined;
  return isolatedConfig === undefined ? targetEnv : { ...targetEnv, DOCKER_CONFIG: isolatedConfig };
}
