// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { isSupportedGatewayDockerHost } from "../domain/docker-host";

const READINESS_PROBE_TIMEOUT_MS = 15_000;
const READINESS_PROBE_MAX_BUFFER_BYTES = 1024 * 1024;

const READINESS_PROBE_ENV_NAMES = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PATH",
  "TERM",
  "HOSTNAME",
  "NODE_ENV",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_COLLATE",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_PAPER",
  "LC_NAME",
  "LC_ADDRESS",
  "LC_TELEPHONE",
  "LC_MEASUREMENT",
  "LC_IDENTIFICATION",
  "TZ",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_CONFIG_HOME",
  "XDG_BIN_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_DATA_DIRS",
  "XDG_CONFIG_DIRS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HOMEBREW_NO_AUTO_UPDATE",
  "HOMEBREW_NO_ENV_HINTS",
]);

export interface ReadinessProbeEnvironmentControls {
  /** Select the exact gateway inspected by unqualified OpenShell status commands. */
  gatewayName?: string;
  /** Trusted local mTLS bundle directory for the selected gateway. */
  localTlsDir?: string;
}

/**
 * Replacement environment for read-only readiness children.
 *
 * Names are exact rather than prefix-based: an ambient variable such as
 * `XDG_API_TOKEN` or `LC_CLIENT_SECRET` must never cross this boundary. The
 * only product control is the caller-selected gateway name. A Docker endpoint
 * is retained solely when it is the supported absolute local Unix socket form.
 */
export function buildSystemReadinessProbeEnv(
  source: NodeJS.ProcessEnv = process.env,
  controls: ReadinessProbeEnvironmentControls = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of READINESS_PROBE_ENV_NAMES) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  if (source.DOCKER_HOST && isSupportedGatewayDockerHost(source.DOCKER_HOST)) {
    env.DOCKER_HOST = source.DOCKER_HOST.trim();
  }
  if (controls.gatewayName) {
    if (/[\0\r\n]/u.test(controls.gatewayName)) {
      throw new Error("Readiness gateway name contains an invalid character.");
    }
    env.OPENSHELL_GATEWAY = controls.gatewayName;
  }
  if (
    controls.localTlsDir &&
    path.isAbsolute(controls.localTlsDir) &&
    !/[\0\r\n]/u.test(controls.localTlsDir)
  ) {
    env.OPENSHELL_LOCAL_TLS_DIR = path.normalize(controls.localTlsDir);
  }
  return env;
}

type ReadinessRunCapture = typeof import("../runner").runCapture;

/** Build a runCapture-compatible executor whose environment is replaced, not merged. */
export function createSystemReadinessCapture(env: NodeJS.ProcessEnv): ReadinessRunCapture {
  return (cmd, opts = {}) => {
    if (!Array.isArray(cmd) || cmd.length === 0) {
      throw new Error("Readiness probe command must be a non-empty argv array.");
    }
    const [file, ...args] = cmd.map(String);
    if (!file || file.includes("\0") || args.some((arg) => arg.includes("\0"))) {
      throw new Error("Readiness probe command contains an invalid executable or argument.");
    }
    const {
      ignoreError,
      includeStderr,
      env: _ignoredCallerEnv,
      stdio: _ignoredStdio,
      shell,
      ...spawnOptions
    } = opts;
    if (shell) throw new Error("Readiness probe commands cannot enable shell interpretation.");
    const result = spawnSync(file, args, {
      timeout: READINESS_PROBE_TIMEOUT_MS,
      maxBuffer: READINESS_PROBE_MAX_BUFFER_BYTES,
      ...spawnOptions,
      encoding: "utf-8",
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = String(result.stdout ?? "").trim();
    const stderr = String(result.stderr ?? "").trim();
    const output = includeStderr ? [stdout, stderr].filter(Boolean).join("\n") : stdout;
    if (result.error || result.status !== 0) {
      if (ignoreError) return includeStderr ? output : "";
      throw new Error("Readiness probe command failed.");
    }
    return output;
  };
}
