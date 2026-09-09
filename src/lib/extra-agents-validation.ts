// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// This source also runs directly under Node's native TypeScript stripping in
// the managed image. Keep it dependency-free: CLI-style extensionless imports
// do not resolve another .ts source file at that runtime boundary.
function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNoMaxSpawnDepth(value: unknown, label: string): void {
  if (!isObjectRecord(value) || !Object.hasOwn(value, "maxSpawnDepth")) return;
  throw new Error(
    `${label}.maxSpawnDepth is not accepted per-agent; OpenClaw honours it only on agents.defaults.subagents. Set it under the manifest 'defaults.subagents.maxSpawnDepth' instead.`,
  );
}

export function assertNoPerAgentMaxSpawnDepth(value: unknown): void {
  const agents = Array.isArray(value)
    ? value
    : isObjectRecord(value) && Array.isArray(value.agents)
      ? value.agents
      : [];
  agents.forEach((entry, index) => {
    if (!isObjectRecord(entry)) return;
    assertNoMaxSpawnDepth(entry.subagents, `NEMOCLAW_EXTRA_AGENTS_JSON.agents[${index}].subagents`);
  });
  if (isObjectRecord(value) && isObjectRecord(value.main)) {
    assertNoMaxSpawnDepth(value.main.subagents, "NEMOCLAW_EXTRA_AGENTS_JSON.main.subagents");
  }
}

export function assertNoPerAgentMaxSpawnDepthJson(raw: string | undefined): void {
  if (!raw?.trim()) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return;
  }
  assertNoPerAgentMaxSpawnDepth(parsed);
}
