// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import path from "node:path";

import type { RebuildSandboxOptions } from "../../../domain/lifecycle/options";
import { snapshotKnownCredentialEnv } from "../../../onboard/credential-env";
import { isCurrentPortableHostFenceHeld } from "../../../state/portable-uninstall-retirement";
import { buildSubprocessEnv } from "../../../subprocess-env";
import { findSandboxAcrossGatewayRoots } from "../../../state/registry/cross-port";
import type { RebuildSandboxExecutionOptions } from "../rebuild-prepared-recovery";

export interface RebuildOwningRegistryInput {
  readonly sandboxName: string;
  readonly options: RebuildSandboxOptions;
  readonly executionOptions: RebuildSandboxExecutionOptions;
}

type RebuildOwningRegistryDependencies = {
  findSandbox: typeof findSandboxAcrossGatewayRoots;
  isHostFenceHeld: typeof isCurrentPortableHostFenceHeld;
  runWorker(input: RebuildOwningRegistryInput, gatewayPort: number): Promise<void>;
};

const WORKER_PATH = path.join(__dirname, "owning-registry-worker.js");
const REBUILD_ENV_NAMES = [
  "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
  "NEMOCLAW_NON_INTERACTIVE",
  "NEMOCLAW_OPENSHELL_BIN",
  "NEMOCLAW_OPENSHELL_GATEWAY_BIN",
  "NEMOCLAW_OPENSHELL_SANDBOX_BIN",
  "NEMOCLAW_REBUILD_VERBOSE",
  "NEMOCLAW_SANDBOX_BASE_IMAGE_REFRESH",
] as const;

function rebuildWorkerEnv(gatewayPort: number): Record<string, string> {
  const extra: Record<string, string> = {
    ...snapshotKnownCredentialEnv(),
    NEMOCLAW_GATEWAY_PORT: String(gatewayPort),
  };
  for (const name of REBUILD_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) extra[name] = value;
  }
  return buildSubprocessEnv(extra);
}

async function runWorker(input: RebuildOwningRegistryInput, gatewayPort: number): Promise<void> {
  const child = spawn(process.execPath, [WORKER_PATH], {
    env: rebuildWorkerEnv(gatewayPort),
    stdio: ["inherit", "inherit", "inherit", "pipe"],
  });
  const inputStream = child.stdio[3];
  if (!inputStream || !("end" in inputStream)) {
    child.kill();
    throw new Error("Cannot route rebuild input to the owning gateway registry.");
  }
  const inputWritten = new Promise<void>((resolve, reject) => {
    inputStream.once("error", reject);
    inputStream.end(JSON.stringify(input), resolve);
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) {
        resolve();
        return;
      }
      reject(new Error("Rebuild in the owning gateway registry did not complete successfully."));
    });
  });
  await inputWritten;
}

export const rebuildOwningRegistryDependencies: RebuildOwningRegistryDependencies = {
  findSandbox: findSandboxAcrossGatewayRoots,
  isHostFenceHeld: isCurrentPortableHostFenceHeld,
  runWorker,
};

/**
 * Re-enter rebuild in a fresh process whose static state paths are bound to
 * the sandbox's owning gateway root. Returns true when the worker owns the
 * operation and the caller must stop its local pipeline.
 */
export async function delegateRebuildToOwningRegistry(
  input: RebuildOwningRegistryInput,
  homeDir: string,
  currentRegistryFile: string,
): Promise<boolean> {
  const hit = rebuildOwningRegistryDependencies.findSandbox(input.sandboxName, homeDir);
  if (!hit || path.resolve(hit.registryFile) === path.resolve(currentRegistryFile)) return false;
  if (hit.registryGatewayPort === undefined) {
    throw new Error("Cannot resolve the gateway registry root that owns the sandbox.");
  }
  if (rebuildOwningRegistryDependencies.isHostFenceHeld(homeDir)) {
    throw new Error(
      `Cannot transfer rebuild for '${input.sandboxName}' while another lifecycle command owns the host fence. Run 'nemoclaw ${input.sandboxName} rebuild' directly.`,
    );
  }
  await rebuildOwningRegistryDependencies.runWorker(input, hit.registryGatewayPort);
  return true;
}
