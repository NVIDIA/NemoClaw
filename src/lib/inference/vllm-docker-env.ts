// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isIP } from "node:net";

import { buildSubprocessEnv } from "../subprocess-env";
import {
  assertDualStationSshBindingFiles,
  type DualStationSshBinding,
  dualStationDockerSshUri,
} from "./vllm-station-ssh-binding";

const DOCKER_CLIENT_ENV_NAMES = [
  "DOCKER_API_VERSION",
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
] as const;

const REMOTE_DOCKER_INCOMPATIBLE_ENV_NAMES = [
  "DOCKER_API_VERSION",
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
] as const;
const SSH_TRANSPORT_ENV_NAMES = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "SSH_AUTH_SOCK",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
] as const;
const CANONICAL_SSH_HOST_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const CANONICAL_SSH_USERNAME_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]*$/;

function validateRemoteDockerSshUri(value: string): string {
  const invalid = () =>
    new Error(
      "Remote Docker host must be a canonical ssh://[user@]host[:port] URI without a password, path, query, or fragment",
    );
  if (typeof value !== "string" || !value || value !== value.trim() || value.includes("\0")) {
    throw invalid();
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalid();
  }

  if (
    parsed.protocol !== "ssh:" ||
    !parsed.hostname ||
    parsed.password ||
    parsed.pathname ||
    parsed.search ||
    parsed.hash ||
    (parsed.username && !CANONICAL_SSH_USERNAME_PATTERN.test(parsed.username))
  ) {
    throw invalid();
  }

  const bracketedIpv6 = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]");
  const bareHostname = bracketedIpv6 ? parsed.hostname.slice(1, -1) : parsed.hostname;
  const validHostname = bracketedIpv6
    ? bareHostname === bareHostname.toLowerCase() && isIP(bareHostname) === 6
    : isIP(bareHostname) === 4 || CANONICAL_SSH_HOST_PATTERN.test(bareHostname);
  const port = parsed.port ? Number(parsed.port) : null;
  if (!validHostname || (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535))) {
    throw invalid();
  }

  const canonical = `ssh://${parsed.username ? `${parsed.username}@` : ""}${parsed.hostname}${
    parsed.port ? `:${parsed.port}` : ""
  }`;
  if (value !== canonical) throw invalid();
  return canonical;
}

/**
 * Use one Docker client selection for every managed-vLLM subprocess while
 * retaining the repository's child-process environment sanitization.
 */
export function buildVllmDockerEnv(
  extra: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const dockerEnv: Record<string, string> = {};
  for (const name of DOCKER_CLIENT_ENV_NAMES) {
    const value = source[name];
    if (value !== undefined) dockerEnv[name] = value;
  }
  const env = buildSubprocessEnv({ ...dockerEnv, ...extra });
  for (const name of DOCKER_CLIENT_ENV_NAMES) {
    if (source[name] === undefined && extra[name] === undefined) delete env[name];
  }
  return env;
}

/** Select the physical host's default Docker daemon, ignoring ambient client routing. */
export function buildLocalDualStationDockerEnv(
  extra: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env = buildVllmDockerEnv(extra, source);
  for (const name of DOCKER_CLIENT_ENV_NAMES) delete env[name];
  // Docker otherwise falls back to config.json's persisted currentContext,
  // which may point at a remote daemon even with every selector env unset.
  env.DOCKER_CONTEXT = "default";
  return env;
}

/** Minimal environment shared by strict SSH probes and Docker's SSH helper. */
export function buildVllmSshTransportEnv(
  extra: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of SSH_TRANSPORT_ENV_NAMES) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}

/**
 * Select one explicitly configured Docker-over-SSH daemon without allowing an
 * ambient context, client config, API pin, or TCP/TLS settings to influence it.
 */
export function buildRemoteVllmDockerEnv(
  binding: DualStationSshBinding,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  assertDualStationSshBindingFiles(binding);
  const remoteHost = validateRemoteDockerSshUri(dualStationDockerSshUri(binding));
  const env = buildVllmSshTransportEnv({ DOCKER_HOST: remoteHost }, source);
  for (const name of REMOTE_DOCKER_INCOMPATIBLE_ENV_NAMES) delete env[name];
  env.PATH = binding.sshWrapperDirectory;
  return env;
}
