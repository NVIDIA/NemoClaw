// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { ProcessCuaSecurityAdapter } from "../adapters/cua-security";
import type { CuaFailure, CuaSecurityAttestation } from "./contract";
import {
  type CuaSecurityLifecycleResult,
  type CuaSecurityOperation,
  executeCuaSecurityLifecycle,
} from "./security-lifecycle";

export interface CuaSecurityCommandInput {
  operation: CuaSecurityOperation;
  sandboxName: string;
  adapterPath?: string;
}

export function executeCuaSecurityCommand(
  input: CuaSecurityCommandInput,
): CuaSecurityLifecycleResult {
  const adapter = input.adapterPath ? new ProcessCuaSecurityAdapter(input.adapterPath) : undefined;
  return executeCuaSecurityLifecycle({
    operation: input.operation,
    sandboxName: input.sandboxName,
    ...(adapter ? { adapter } : {}),
  });
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
