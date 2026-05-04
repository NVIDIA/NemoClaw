// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- transitional action facade until implementations leave src/nemoclaw.ts. */

import type { SandboxConnectOptions } from "./sandbox-connect-action";
import type { SandboxLogsOptions } from "./sandbox-logs-options";
import { getNemoClawRuntimeBridge } from "./nemoclaw-runtime-bridge";

export async function connectSandbox(
  sandboxName: string,
  options?: SandboxConnectOptions,
): Promise<void> {
  const { connectSandbox: connectExtractedSandbox } = require("./sandbox-connect-action") as {
    connectSandbox: (sandboxName: string, options?: SandboxConnectOptions) => Promise<void>;
  };
  await connectExtractedSandbox(sandboxName, options);
}

export async function showSandboxStatus(sandboxName: string): Promise<void> {
  const { showSandboxStatus: showExtractedSandboxStatus } = require("./sandbox-status-action") as {
    showSandboxStatus: (sandboxName: string) => Promise<void>;
  };
  await showExtractedSandboxStatus(sandboxName);
}

export function showSandboxLogs(sandboxName: string, options: SandboxLogsOptions): void {
  const { showSandboxLogs: showSandboxLogsAction } = require("./sandbox-logs-action") as {
    showSandboxLogs: (sandboxName: string, options: SandboxLogsOptions) => void;
  };
  showSandboxLogsAction(sandboxName, options);
}

export async function destroySandbox(sandboxName: string, args: string[] = []): Promise<void> {
  const { destroySandbox: destroyExtractedSandbox } = require("./sandbox-destroy-action") as {
    destroySandbox: (sandboxName: string, args?: string[]) => Promise<void>;
  };
  await destroyExtractedSandbox(sandboxName, args);
}

export async function rebuildSandbox(sandboxName: string, args: string[] = []): Promise<void> {
  await getNemoClawRuntimeBridge().sandboxRebuild(sandboxName, args);
}

export async function installSandboxSkill(
  sandboxName: string,
  args: string[] = [],
): Promise<void> {
  const { installSandboxSkill: installExtractedSandboxSkill } = require("./sandbox-skill-install-action") as {
    installSandboxSkill: (sandboxName: string, args?: string[]) => Promise<void>;
  };
  await installExtractedSandboxSkill(sandboxName, args);
}

export async function runSandboxSnapshot(sandboxName: string, args: string[]): Promise<void> {
  const { runSandboxSnapshot: runExtractedSandboxSnapshot } = require("./snapshot-action") as {
    runSandboxSnapshot: (sandboxName: string, args: string[]) => Promise<void>;
  };
  await runExtractedSandboxSnapshot(sandboxName, args);
}
