// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import type { ContainerEngineCommandCapture } from "../../adapters/container-engine";
import { openRegularFileNoFollow } from "../../adapters/fs/regular-file";
import { hardenPodmanSocketDirectory, type PodmanSocketAuthorityDeps } from "../../adapters/podman";
import type { CheckpointPortableRuntimeAuthority } from "../../state/onboard-checkpoint-types";
import { parsePortableRuntimeAuthority } from "../../state/onboard/portable-runtime-authority";
import {
  inspectPortablePodmanReadiness,
  portablePodmanCommandEnvironment,
  type PortablePodmanReadinessDeps,
  type PortablePodmanReadinessResult,
} from "./portable-runtime-readiness";

const RECEIPT_DIRECTORY = "portable-demo-lifecycle";
const MAX_RECEIPT_BYTES = 4096;
const CURRENT_RECEIPT_SCHEMA_VERSION = 4;
const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/u;
const SANDBOX_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;

type CommandResult = {
  readonly status: number | null;
  readonly stdout?: string | Buffer | null;
  readonly stderr?: string | Buffer | null;
  readonly error?: Error;
};

export interface PortableRuntimeReceiptReadinessDeps {
  readonly platform?: NodeJS.Platform;
  readonly stateDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly podman?: (args: readonly string[], env?: NodeJS.ProcessEnv) => CommandResult;
  readonly podmanSocketAuthorityDeps?: PodmanSocketAuthorityDeps;
  readonly runtimeReadiness?: PortablePodmanReadinessDeps;
  readonly hardenSocketDirectory?: (socketPath: string, uid: number) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function portableDemoReceiptPath(sandboxName: string, stateDir: string): string {
  const fileName = `${createHash("sha256").update(sandboxName).digest("hex")}.json`;
  return path.join(stateDir, RECEIPT_DIRECTORY, fileName);
}

export function defaultPortableDemoStateDir(env: NodeJS.ProcessEnv): string {
  if (
    env.VITEST === "true" &&
    (env.HOME ?? "") === env.NEMOCLAW_TEST_BASE_HOME &&
    env.NEMOCLAW_TEST_STATE_DIR &&
    path.isAbsolute(env.NEMOCLAW_TEST_STATE_DIR)
  ) {
    return env.NEMOCLAW_TEST_STATE_DIR;
  }
  return path.join(env.HOME ?? os.homedir(), ".nemoclaw");
}

function exactReceiptKeys(receipt: Record<string, unknown>): boolean {
  const expected =
    receipt.schemaVersion === CURRENT_RECEIPT_SCHEMA_VERSION
      ? "containerId,dashboardPort,registryGeneration,runtimeAuthority,sandboxId,sandboxName,schemaVersion"
      : receipt.schemaVersion === 3
        ? "containerId,dashboardPort,registryGeneration,sandboxId,sandboxName,schemaVersion"
        : "containerId,dashboardPort,sandboxId,sandboxName,schemaVersion";
  return Object.keys(receipt).sort().join(",") === expected;
}

function parseReceiptAuthority(
  value: unknown,
  sandboxName: string,
): CheckpointPortableRuntimeAuthority | "legacy" {
  if (!isRecord(value) || !exactReceiptKeys(value)) {
    throw new Error("Portable demo lifecycle receipt fields are invalid");
  }
  const schemaVersion = value.schemaVersion;
  if (
    (schemaVersion !== 1 &&
      schemaVersion !== 2 &&
      schemaVersion !== 3 &&
      schemaVersion !== CURRENT_RECEIPT_SCHEMA_VERSION) ||
    value.sandboxName !== sandboxName ||
    typeof value.containerId !== "string" ||
    !CONTAINER_ID_PATTERN.test(value.containerId) ||
    typeof value.sandboxId !== "string" ||
    !SANDBOX_ID_PATTERN.test(value.sandboxId) ||
    !Number.isInteger(value.dashboardPort) ||
    Number(value.dashboardPort) < 1024 ||
    Number(value.dashboardPort) > 65535 ||
    ((schemaVersion === 3 || schemaVersion === CURRENT_RECEIPT_SCHEMA_VERSION) &&
      (typeof value.registryGeneration !== "string" ||
        !SANDBOX_ID_PATTERN.test(value.registryGeneration)))
  ) {
    throw new Error("Portable demo lifecycle receipt values are invalid");
  }
  if (schemaVersion !== CURRENT_RECEIPT_SCHEMA_VERSION) return "legacy";
  const authority = parsePortableRuntimeAuthority(value.runtimeAuthority);
  if (!authority) throw new Error("Portable demo lifecycle receipt values are invalid");
  return authority;
}

function loadReceiptAuthority(
  sandboxName: string,
  stateDir: string,
): CheckpointPortableRuntimeAuthority | "legacy" | null {
  let file;
  try {
    file = openRegularFileNoFollow(portableDemoReceiptPath(sandboxName, stateDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return parseReceiptAuthority(JSON.parse(file.readUtf8(MAX_RECEIPT_BYTES)), sandboxName);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Portable demo lifecycle receipt is malformed");
    }
    throw error;
  } finally {
    file.close();
  }
}

function podmanCapture(
  podman: NonNullable<PortableRuntimeReceiptReadinessDeps["podman"]>,
  env: NodeJS.ProcessEnv,
): ContainerEngineCommandCapture {
  return (_executable, args) => {
    const result = podman(args, env);
    return {
      status: result.status ?? 1,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
      ...(result.error ? { error: result.error } : {}),
    };
  };
}

function defaultPodmanCapture(env: NodeJS.ProcessEnv): ContainerEngineCommandCapture {
  return (_executable, args, timeoutMs) => {
    const result = spawnSync("podman", [...args], {
      encoding: "utf-8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });
    return {
      status: result.status ?? 1,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
      ...(result.error ? { error: result.error } : {}),
    };
  };
}

/** Inspect the receipt-owned portable runtime, or return null for an ordinary sandbox. */
export function inspectPortableRuntimeReceiptReadiness(
  sandboxName: string,
  deps: PortableRuntimeReceiptReadinessDeps = {},
): PortablePodmanReadinessResult | null {
  const commandEnv = deps.env ?? process.env;
  const stateDir = deps.stateDir ?? defaultPortableDemoStateDir(commandEnv);
  let authority: CheckpointPortableRuntimeAuthority | "legacy" | null;
  try {
    authority = loadReceiptAuthority(sandboxName, stateDir);
  } catch {
    return {
      ok: false,
      stage: "socket authority",
      detail: "The portable lifecycle receipt is unsafe or invalid; rerun onboarding.",
      timing: { mode: "warm", activationMs: 0, apiMs: 0, totalMs: 0 },
    };
  }
  if (!authority) return null;
  if (authority === "legacy") {
    return {
      ok: false,
      stage: "socket authority",
      detail:
        "The lifecycle receipt predates recorded portable Podman authority; rerun onboarding.",
      timing: { mode: "warm", activationMs: 0, apiMs: 0, totalMs: 0 },
    };
  }
  const podmanEnv = portablePodmanCommandEnvironment(authority, commandEnv);
  const capture = deps.podman
    ? podmanCapture(deps.podman, podmanEnv)
    : defaultPodmanCapture(podmanEnv);
  return inspectPortablePodmanReadiness(authority, {
    platform: deps.platform,
    env: commandEnv,
    socketAuthorityDeps: deps.podmanSocketAuthorityDeps,
    hardenSocketDirectory: deps.hardenSocketDirectory ?? hardenPodmanSocketDirectory,
    podmanCapture: capture,
    ...deps.runtimeReadiness,
  });
}
