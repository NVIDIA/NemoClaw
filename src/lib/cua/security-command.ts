// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { ProcessCuaSecurityAdapter } from "../adapters/cua-security";
import { type CuaCommandRouteLockDeps, withCuaCommandRouteLock } from "./command-route-lock";
import {
  CUA_LIFECYCLE_SCHEMA_VERSION,
  type CuaFailure,
  type CuaSecurityAttestation,
} from "./contract";
import { isCuaFrameworkEnabled } from "./feature";
import { resolveCuaQualificationArtifactRunner } from "./qualification-artifact-runner";
import { getCuaReconciliationAdapterDigest } from "./reconciliation";
import { getCuaAdapterBindings } from "./runtime-manifest";
import {
  CUA_SECURITY_EXIT_CODES,
  type CuaSecurityLifecycleInput,
  type CuaSecurityLifecycleResult,
  type CuaSecurityOperation,
  executeCuaSecurityLifecycle,
} from "./security-lifecycle";

export interface CuaSecurityCommandInput {
  operation: CuaSecurityOperation;
  sandboxName: string;
  adapterPath?: string;
}

function commandFailure(
  operation: CuaSecurityOperation,
  family: "validation_failed" | "lifecycle_unavailable" | "runtime_unavailable",
): CuaSecurityLifecycleResult {
  return {
    record: {
      schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
      kind: "failure",
      operation,
      family,
      retryable: false,
      component: "runtime",
    },
    exitCode:
      family === "validation_failed"
        ? CUA_SECURITY_EXIT_CODES.validation
        : CUA_SECURITY_EXIT_CODES.unavailable,
  };
}

export interface CuaSecurityCommandDeps extends CuaCommandRouteLockDeps {
  isFrameworkEnabled?: typeof isCuaFrameworkEnabled;
  getAdapterBindings?: typeof getCuaAdapterBindings;
  resolveQualificationArtifactRunner?: typeof resolveCuaQualificationArtifactRunner;
  executeLifecycle?: (
    input: CuaSecurityLifecycleInput,
  ) => CuaSecurityLifecycleResult | Promise<CuaSecurityLifecycleResult>;
}

export async function executeCuaSecurityCommand(
  input: CuaSecurityCommandInput,
  deps: CuaSecurityCommandDeps = {},
): Promise<CuaSecurityLifecycleResult> {
  if (!(deps.isFrameworkEnabled ?? isCuaFrameworkEnabled)()) {
    return commandFailure(input.operation, "lifecycle_unavailable");
  }
  if (
    input.adapterPath &&
    (!path.isAbsolute(input.adapterPath) || path.normalize(input.adapterPath) !== input.adapterPath)
  ) {
    return commandFailure(input.operation, "validation_failed");
  }
  try {
    return await withCuaCommandRouteLock(
      input.sandboxName,
      async (entry) => {
        let adapter: ProcessCuaSecurityAdapter | undefined;
        if (input.adapterPath) {
          try {
            let executable = input.adapterPath;
            let expectedDigest: string | undefined;
            if (entry?.cuaReconciliation) {
              const retainedDigest = getCuaReconciliationAdapterDigest(entry, "security");
              if (!retainedDigest) {
                return commandFailure(input.operation, "runtime_unavailable");
              }
              expectedDigest = retainedDigest;
            } else {
              const binding = (deps.getAdapterBindings ?? getCuaAdapterBindings)().security;
              if (input.adapterPath !== binding.path) {
                return commandFailure(input.operation, "validation_failed");
              }
              executable = binding.path;
              expectedDigest = binding.digest;
            }
            const qualificationArtifactRunner = (
              deps.resolveQualificationArtifactRunner ?? resolveCuaQualificationArtifactRunner
            )();
            adapter = new ProcessCuaSecurityAdapter(executable, {
              expectedDigest,
              ...(qualificationArtifactRunner ? { qualificationArtifactRunner } : {}),
            });
          } catch {
            return commandFailure(input.operation, "runtime_unavailable");
          }
        }
        return await (deps.executeLifecycle ?? executeCuaSecurityLifecycle)({
          operation: input.operation,
          sandboxName: input.sandboxName,
          ...(adapter ? { adapter } : {}),
        });
      },
      deps,
    );
  } catch {
    return commandFailure(input.operation, "runtime_unavailable");
  }
}

export interface RenderedCuaSecurityResult {
  exitCode: number;
  output?: CuaSecurityAttestation | CuaFailure;
  message?: string;
  error?: string;
}

export function renderCuaSecurityResult(
  operation: CuaSecurityOperation,
  lifecycleResult: CuaSecurityLifecycleResult,
  jsonEnabled: boolean,
): RenderedCuaSecurityResult {
  if (jsonEnabled) {
    return { exitCode: lifecycleResult.exitCode, output: lifecycleResult.record };
  }
  if (lifecycleResult.record.kind === "failure") {
    return {
      exitCode: lifecycleResult.exitCode,
      error: `CUA ${operation.replace(".", " ")} failed: ${lifecycleResult.record.family}`,
    };
  }
  return {
    exitCode: lifecycleResult.exitCode,
    message: `CUA security ${operation.slice("security.".length)}: enforced`,
  };
}
