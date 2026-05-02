// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- transitional action facade until implementations leave src/nemoclaw.ts. */

import { getNemoClawRuntimeBridge } from "./nemoclaw-runtime-bridge";

export async function addSandboxPolicy(sandboxName: string, args: string[] = []): Promise<void> {
  await getNemoClawRuntimeBridge().sandboxPolicyAdd(sandboxName, args);
}

export async function removeSandboxPolicy(sandboxName: string, args: string[] = []): Promise<void> {
  await getNemoClawRuntimeBridge().sandboxPolicyRemove(sandboxName, args);
}

export function listSandboxPolicies(sandboxName: string): void {
  getNemoClawRuntimeBridge().sandboxPolicyList(sandboxName);
}

export function listSandboxChannels(sandboxName: string): void {
  getNemoClawRuntimeBridge().sandboxChannelsList(sandboxName);
}

export async function addSandboxChannel(sandboxName: string, args: string[] = []): Promise<void> {
  await getNemoClawRuntimeBridge().sandboxChannelsAdd(sandboxName, args);
}

export async function removeSandboxChannel(
  sandboxName: string,
  args: string[] = [],
): Promise<void> {
  await getNemoClawRuntimeBridge().sandboxChannelsRemove(sandboxName, args);
}

export async function startSandboxChannel(
  sandboxName: string,
  args: string[] = [],
): Promise<void> {
  await getNemoClawRuntimeBridge().sandboxChannelsStart(sandboxName, args);
}

export async function stopSandboxChannel(sandboxName: string, args: string[] = []): Promise<void> {
  await getNemoClawRuntimeBridge().sandboxChannelsStop(sandboxName, args);
}
