// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface SandboxSummary {
  defaultSandbox?: string | null;
}

export interface StartCommandDeps {
  listSandboxes: () => SandboxSummary;
  startAll: (options: { sandboxName?: string }) => Promise<void>;
}

export interface StopCommandDeps {
  listSandboxes: () => SandboxSummary;
  stopAll: (options: { sandboxName?: string }) => void;
}

const SAFE_SANDBOX_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function resolveDefaultSandboxName(listSandboxes: () => SandboxSummary): string | undefined {
  const { defaultSandbox } = listSandboxes();
  return defaultSandbox && SAFE_SANDBOX_RE.test(defaultSandbox) ? defaultSandbox : undefined;
}

export async function runStartCommand(deps: StartCommandDeps): Promise<void> {
  await deps.startAll({ sandboxName: resolveDefaultSandboxName(deps.listSandboxes) });
}

export function runStopCommand(deps: StopCommandDeps): void {
  deps.stopAll({ sandboxName: resolveDefaultSandboxName(deps.listSandboxes) });
}
