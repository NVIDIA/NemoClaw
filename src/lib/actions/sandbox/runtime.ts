// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0


import type { DestroySandboxOptions, RebuildSandboxOptions } from "../../domain/lifecycle/options";
import type { SandboxConnectOptions } from "./connect";
import type { SandboxLogsOptions } from "../../domain/sandbox/log-options";

export async function connectSandbox(
  sandboxName: string,
  options?: SandboxConnectOptions,
): Promise<void> {
  const { connectSandbox: connectExtractedSandbox } = require("./connect") as {
    connectSandbox: (sandboxName: string, options?: SandboxConnectOptions) => Promise<void>;
  };
  await connectExtractedSandbox(sandboxName, options);
}

export async function showSandboxStatus(sandboxName: string): Promise<void> {
  const { showSandboxStatus: showExtractedSandboxStatus } = require("./status") as {
    showSandboxStatus: (sandboxName: string) => Promise<void>;
  };
  await showExtractedSandboxStatus(sandboxName);
}

export function showSandboxLogs(sandboxName: string, options: SandboxLogsOptions): void {
  const { showSandboxLogs: showSandboxLogsAction } = require("./logs") as {
    showSandboxLogs: (sandboxName: string, options: SandboxLogsOptions) => void;
  };
  showSandboxLogsAction(sandboxName, options);
}

export async function destroySandbox(
  sandboxName: string,
  options: string[] | DestroySandboxOptions = {},
): Promise<void> {
  const { destroySandbox: destroyExtractedSandbox } = require("./destroy") as {
    destroySandbox: (
      sandboxName: string,
      options?: string[] | DestroySandboxOptions,
    ) => Promise<void>;
  };
  await destroyExtractedSandbox(sandboxName, options);
}

export async function rebuildSandbox(
  sandboxName: string,
  options: string[] | RebuildSandboxOptions = {},
): Promise<void> {
  const { rebuildSandbox: rebuildExtractedSandbox } = require("./rebuild") as {
    rebuildSandbox: (
      sandboxName: string,
      options?: string[] | RebuildSandboxOptions,
    ) => Promise<void>;
  };
  await rebuildExtractedSandbox(sandboxName, options);
}

export async function installSandboxSkill(
  sandboxName: string,
  args: string[] = [],
): Promise<void> {
  const { installSandboxSkill: installExtractedSandboxSkill } = require("./skill-install") as {
    installSandboxSkill: (sandboxName: string, args?: string[]) => Promise<void>;
  };
  await installExtractedSandboxSkill(sandboxName, args);
}

export async function runSandboxSnapshot(sandboxName: string, args: string[]): Promise<void> {
  const { runSandboxSnapshot: runExtractedSandboxSnapshot } = require("./snapshot") as {
    runSandboxSnapshot: (sandboxName: string, args: string[]) => Promise<void>;
  };
  await runExtractedSandboxSnapshot(sandboxName, args);
}
