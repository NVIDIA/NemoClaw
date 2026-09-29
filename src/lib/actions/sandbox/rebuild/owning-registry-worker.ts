// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import type { RebuildSandboxOptions } from "../../../domain/lifecycle/options";
import { enforceRemovedImmutabilityMigrationBoundary } from "../../../state/migrations/removed-immutability";
import { withSandboxLifecycleLock } from "../lifecycle/lock";
import { rebuildSandbox } from "../rebuild-pipeline";
import { redactBoundedRebuildFailure } from "../rebuild-preflight-confirmation";
import type { RebuildSandboxExecutionOptions } from "../rebuild-prepared-recovery";
import { retireRebuildRecoveryBackup } from "../rebuild-recreate-journal";
import type { OwningRegistryWorkerInput, OwningRegistryWorkerResult } from "./owning-registry";

const MAX_REBUILD_INPUT_BYTES = 4 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readInput(): OwningRegistryWorkerInput {
  const descriptor = 3;
  const chunks: Buffer[] = [];
  let bytes = 0;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (;;) {
    const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
    if (count === 0) break;
    bytes += count;
    if (bytes > MAX_REBUILD_INPUT_BYTES) throw new Error("Rebuild worker input is too large.");
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!isRecord(parsed) || typeof parsed.sandboxName !== "string") {
    throw new Error("Rebuild worker input is invalid.");
  }
  if (
    parsed.operation === "rebuild" &&
    isRecord(parsed.options) &&
    isRecord(parsed.executionOptions)
  ) {
    return {
      operation: "rebuild",
      sandboxName: parsed.sandboxName,
      options: parsed.options as RebuildSandboxOptions,
      executionOptions: parsed.executionOptions as RebuildSandboxExecutionOptions,
    };
  }
  if (
    parsed.operation === "retire-recovery" &&
    typeof parsed.transactionId === "string" &&
    typeof parsed.confirmDataRecovered === "boolean"
  ) {
    return {
      operation: "retire-recovery",
      sandboxName: parsed.sandboxName,
      transactionId: parsed.transactionId,
      confirmDataRecovered: parsed.confirmDataRecovered,
    };
  }
  throw new Error("Rebuild worker input is invalid.");
}

function writeResult(result: OwningRegistryWorkerResult): void {
  fs.writeFileSync(4, JSON.stringify(result));
}

function workerIdentity(input: OwningRegistryWorkerInput): Omit<OwningRegistryWorkerResult, "ok"> {
  return {
    operation: input.operation,
    sandboxName: input.sandboxName,
    gatewayPort: Number(process.env.NEMOCLAW_GATEWAY_PORT),
  };
}

async function run(input: OwningRegistryWorkerInput): Promise<void> {
  if (input.operation === "retire-recovery") {
    const retired = await withSandboxLifecycleLock(input.sandboxName, () => {
      enforceRemovedImmutabilityMigrationBoundary(input.sandboxName, {
        allowStateRecord: true,
      });
      return retireRebuildRecoveryBackup(input);
    });
    console.log(
      `Retired rebuild recovery '${retired.transactionId}' for sandbox '${input.sandboxName}' from ${retired.backupPath}.`,
    );
    return;
  }
  const executionOptions = {
    ...input.executionOptions,
    throwOnError: true,
  } as const;
  await rebuildSandbox(input.sandboxName, input.options, executionOptions);
}

async function main(): Promise<void> {
  const input = readInput();
  const identity = workerIdentity(input);
  try {
    await run(input);
    writeResult({ ok: true, ...identity });
  } catch (error) {
    const detail = redactBoundedRebuildFailure(error);
    writeResult({ ok: false, ...identity, ...(detail ? { message: detail } : {}) });
    process.exitCode = 1;
  }
}

void main().catch(() => {
  console.error("Rebuild worker failed.");
  process.exitCode = 1;
});
