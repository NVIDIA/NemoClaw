// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import path from "node:path";

import { DOCKER_DESKTOP_CREDENTIAL_STORE_NAMES } from "../../domain/docker-host";

type ReadFile = (filePath: string, encoding: BufferEncoding) => string;
type RunCapture = (
  command: readonly string[],
  options?: { ignoreError?: boolean; timeout?: number },
) => string | null;

export interface DockerCredentialStoreConfig {
  readonly credsStore?: string;
  readonly configPath?: string;
}

/**
 * Read the global credential-helper name from the active Docker client config.
 * Missing, unreadable, and malformed configs intentionally declare no helper.
 */
export function readDockerCredentialStore(
  env: NodeJS.ProcessEnv,
  readFile: ReadFile,
): DockerCredentialStoreConfig {
  try {
    // os.homedir() can throw in HOME-less containers. Treat that like a
    // missing config so host inspection and generated-image builds fail safe.
    const configDirectory = env.DOCKER_CONFIG || path.join(os.homedir(), ".docker");
    const configPath = env.DOCKER_CONFIG ? "$DOCKER_CONFIG/config.json" : "~/.docker/config.json";
    const parsed: { credsStore?: unknown } = JSON.parse(
      readFile(path.join(configDirectory, "config.json"), "utf-8"),
    );
    return typeof parsed.credsStore === "string" && parsed.credsStore !== ""
      ? { credsStore: parsed.credsStore, configPath }
      : {};
  } catch {
    return {};
  }
}

// Windows interop can stall. Bound the read-only probe so a hung helper cannot
// hang preflight, readiness collection, or a generated sandbox-image build.
const DOCKER_CREDENTIAL_HELPER_PROBE_TIMEOUT_MS = 10_000;

/**
 * True when an exact Docker Desktop credential helper answers a read-only
 * `list` call with parseable JSON. The allowlist prevents Docker config from
 * selecting an arbitrary executable at this trust boundary.
 */
export function dockerDesktopCredentialHelperResponds(
  credsStore: string,
  runCapture: RunCapture,
): boolean {
  if (!DOCKER_DESKTOP_CREDENTIAL_STORE_NAMES.has(credsStore)) return false;
  try {
    const output = runCapture([`docker-credential-${credsStore}`, "list"], {
      ignoreError: true,
      timeout: DOCKER_CREDENTIAL_HELPER_PROBE_TIMEOUT_MS,
    });
    JSON.parse(String(output || ""));
    return true;
  } catch {
    return false;
  }
}
