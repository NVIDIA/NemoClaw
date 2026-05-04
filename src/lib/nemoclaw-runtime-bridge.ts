// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- transitional bridge until command actions are extracted from src/nemoclaw.ts. */

import type { SandboxLogsOptions } from "./sandbox-logs-options";

export interface SandboxConnectOptions {
  probeOnly?: boolean;
}

export interface NemoClawRuntimeBridge {
  sandboxConnect: (sandboxName: string, options?: SandboxConnectOptions) => Promise<void>;
  sandboxDestroy: (sandboxName: string, args?: string[]) => Promise<void>;
  sandboxLogs: (sandboxName: string, options: SandboxLogsOptions) => void;
  sandboxRebuild: (sandboxName: string, args?: string[]) => Promise<void>;
  sandboxSkillInstall: (sandboxName: string, args?: string[]) => Promise<void>;
  sandboxStatus: (sandboxName: string) => Promise<void>;
  upgradeSandboxes: (args?: string[]) => Promise<void>;
}

let runtimeFactory = (): NemoClawRuntimeBridge => {
  const runtimeModule = require("../nemoclaw") as {
    runtimeBridge?: NemoClawRuntimeBridge;
  } & NemoClawRuntimeBridge;
  return runtimeModule.runtimeBridge ?? runtimeModule;
};

export function setNemoClawRuntimeBridgeFactoryForTest(
  factory: () => NemoClawRuntimeBridge,
): void {
  runtimeFactory = factory;
}

export function getNemoClawRuntimeBridge(): NemoClawRuntimeBridge {
  return runtimeFactory();
}
