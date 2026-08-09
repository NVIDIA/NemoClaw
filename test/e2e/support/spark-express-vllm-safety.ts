// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CommandExitResult } from "../fixtures/clients/command.ts";
import { resultText } from "../fixtures/clients/command.ts";

const DOCKER_NOT_FOUND_PATTERN = /no such (?:object|container)/iu;

export function assertLocalDockerEnvironment(env: NodeJS.ProcessEnv): void {
  const host = String(env.DOCKER_HOST ?? "").trim();
  const context = String(env.DOCKER_CONTEXT ?? "").trim();
  if (host && !host.startsWith("unix://")) {
    throw new Error(
      `DGX Spark qualification requires a local Docker socket; got DOCKER_HOST=${host}`,
    );
  }
  if (context && context !== "default") {
    throw new Error(
      `DGX Spark qualification requires the default local Docker context; got DOCKER_CONTEXT=${context}`,
    );
  }
}

export function classifyDockerContainerInspection(result: CommandExitResult): "absent" | "present" {
  if (result.exitCode === 0) return "present";
  if (DOCKER_NOT_FOUND_PATTERN.test(`${result.stdout}\n${result.stderr}`)) return "absent";
  throw new Error(`Docker container inspection failed: ${resultText(result)}`);
}

export function listedSandboxNames(result: CommandExitResult): Set<string> {
  if (result.exitCode !== 0) {
    throw new Error(`OpenShell sandbox listing failed: ${resultText(result)}`);
  }
  return new Set(
    result.stdout
      .split(/\r?\n/u)
      .map((name) => name.trim())
      .filter(Boolean),
  );
}
