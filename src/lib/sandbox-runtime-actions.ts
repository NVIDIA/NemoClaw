// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- transitional action facade until implementations leave src/nemoclaw.ts. */

import type { SandboxConnectOptions } from "./nemoclaw-runtime-bridge";
import { getNemoClawRuntimeBridge } from "./nemoclaw-runtime-bridge";

export async function connectSandbox(
  sandboxName: string,
  options?: SandboxConnectOptions,
): Promise<void> {
  await getNemoClawRuntimeBridge().sandboxConnect(sandboxName, options);
}

export async function showSandboxStatus(sandboxName: string): Promise<void> {
  await getNemoClawRuntimeBridge().sandboxStatus(sandboxName);
}

export function showSandboxLogs(sandboxName: string, follow: boolean): void {
  const { showSandboxLogs: showSandboxLogsAction } = require("./sandbox-logs-action") as {
    showSandboxLogs: (sandboxName: string, follow: boolean) => void;
  };
  showSandboxLogsAction(sandboxName, follow);
}

export async function destroySandbox(sandboxName: string, args: string[] = []): Promise<void> {
  await getNemoClawRuntimeBridge().sandboxDestroy(sandboxName, args);
}

export async function rebuildSandbox(sandboxName: string, args: string[] = []): Promise<void> {
  await getNemoClawRuntimeBridge().sandboxRebuild(sandboxName, args);
}

export async function installSandboxSkill(
  sandboxName: string,
  args: string[] = [],
): Promise<void> {
  await getNemoClawRuntimeBridge().sandboxSkillInstall(sandboxName, args);
}

export async function runSandboxSnapshot(sandboxName: string, args: string[]): Promise<void> {
  await getNemoClawRuntimeBridge().sandboxSnapshot(sandboxName, args);
}
