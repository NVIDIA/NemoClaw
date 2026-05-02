// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- transitional bridge until command actions are extracted from src/nemoclaw.ts. */

import type { RecoveryResult } from "./inventory-commands";

export interface SpawnLikeResult {
  status: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

export interface GatewayRecoveryResult {
  recovered: boolean;
}

export interface SandboxConnectOptions {
  probeOnly?: boolean;
}

export interface NemoClawRuntimeBridge {
  captureOpenshell: (
    args: string[],
    opts?: { ignoreError?: boolean; timeout?: number },
  ) => { status: number | null; output: string };
  backupAll: () => void;
  deploy: (instanceName?: string) => Promise<void>;
  garbageCollectImages: (args?: string[]) => Promise<void>;
  help: () => void;
  onboard: (args?: string[]) => Promise<void>;
  recoverNamedGatewayRuntime: () => Promise<GatewayRecoveryResult>;
  recoverRegistryEntries: (options?: {
    requestedSandboxName?: string | null;
  }) => Promise<RecoveryResult>;
  runOpenshell: (
    args: string[],
    opts?: {
      env?: Record<string, string | undefined>;
      ignoreError?: boolean;
      stdio?: import("node:child_process").StdioOptions;
      timeout?: number;
    },
  ) => SpawnLikeResult;
  sandboxChannelsAdd: (sandboxName: string, args?: string[]) => Promise<void>;
  sandboxChannelsList: (sandboxName: string) => void;
  sandboxChannelsRemove: (sandboxName: string, args?: string[]) => Promise<void>;
  sandboxChannelsStart: (sandboxName: string, args?: string[]) => Promise<void>;
  sandboxChannelsStop: (sandboxName: string, args?: string[]) => Promise<void>;
  sandboxConnect: (sandboxName: string, options?: SandboxConnectOptions) => Promise<void>;
  sandboxDestroy: (sandboxName: string, args?: string[]) => Promise<void>;
  sandboxLogs: (sandboxName: string, follow: boolean) => void;
  sandboxPolicyAdd: (sandboxName: string, args?: string[]) => Promise<void>;
  sandboxPolicyList: (sandboxName: string) => void;
  sandboxPolicyRemove: (sandboxName: string, args?: string[]) => Promise<void>;
  sandboxRebuild: (sandboxName: string, args?: string[]) => Promise<void>;
  sandboxSkillInstall: (sandboxName: string, args?: string[]) => Promise<void>;
  sandboxSnapshot: (sandboxName: string, subArgs: string[]) => Promise<void>;
  sandboxStatus: (sandboxName: string) => Promise<void>;
  setup: (args?: string[]) => Promise<void>;
  setupSpark: (args?: string[]) => Promise<void>;
  upgradeSandboxes: (args?: string[]) => Promise<void>;
  version: () => void;
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
