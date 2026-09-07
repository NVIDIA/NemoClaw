// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { McpSourceEntry } from "../mcp-bridge-contracts";

const states = new Map<string, Record<string, McpSourceEntry>>();

export function clearTransientBridgeState(): void {
  states.clear();
}

export function hydrateTransientBridgeState(
  sandboxName: string,
  bridges: Record<string, McpSourceEntry>,
): void {
  states.set(sandboxName, structuredClone(bridges));
}

export function getTransientBridgeState(sandboxName: string): Record<string, McpSourceEntry> {
  return states.get(sandboxName) ?? {};
}

export function setTransientBridgeState(
  sandboxName: string,
  bridges: Record<string, McpSourceEntry>,
): void {
  states.set(sandboxName, structuredClone(bridges));
}
